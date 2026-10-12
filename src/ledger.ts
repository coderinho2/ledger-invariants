import { createHash } from "node:crypto";
import type { Database, EntryInput, NewAccount, PostedEntry, PostingInput, Queryable } from "./types.js";

/** Refused before anything reaches the database: the database would refuse it too, less helpfully. */
export class LedgerError extends Error {}

/** The idempotency key was used before for a different entry. */
export class IdempotencyConflict extends LedgerError {}

/** The entry would leave a protected account below zero. Nothing was recorded. */
export class InsufficientFunds extends LedgerError {}

export async function createAccount(db: Queryable, account: NewAccount): Promise<void> {
  await db.query("insert into accounts (id, name, currency, normal_balance, allow_negative) values ($1, $2, $3, $4, $5)", [
    account.id,
    account.name,
    account.currency,
    account.normalBalance,
    !account.protected,
  ]);
}

/** Debits minus credits per currency must be zero; checked here for a clear message, and again by Postgres at commit. */
function validate(entry: EntryInput): void {
  if (entry.postings.length < 2) throw new LedgerError("an entry needs at least two postings");
  const totals = new Map<string, bigint>();
  for (const posting of entry.postings) {
    if (posting.amount === 0n) throw new LedgerError(`a posting to ${posting.accountId} is for zero`);
    totals.set(posting.currency, (totals.get(posting.currency) ?? 0n) + posting.amount);
  }
  for (const [currency, total] of totals) {
    if (total !== 0n) throw new LedgerError(`the entry does not balance in ${currency}: off by ${total}`);
  }
}

const byAccount = (a: PostingInput, b: PostingInput) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0);

/** A fingerprint of what the entry says, independent of the order its postings were listed in. */
export function requestHash(entry: EntryInput): string {
  const postings = [...entry.postings].sort(byAccount).map((p) => [p.accountId, p.currency, p.amount.toString()]);
  return createHash("sha256").update(JSON.stringify([entry.description, postings])).digest("hex");
}

/**
 * Records one entry and its postings in one transaction. Either all of it
 * is in the books or none of it is.
 *
 * With an idempotency key, the same request sent again (a client retry, a
 * webhook delivered twice) returns the entry already recorded, with
 * `replayed: true`, instead of moving the money a second time. The unique
 * index decides: if two attempts race, the second waits for the first to
 * commit and then finds its entry. The same key with a different entry is
 * an IdempotencyConflict.
 *
 * Postings are written in account order. That doesn't matter yet, but once
 * balances are kept per account, writing in a fixed order is what stops two
 * concurrent transfers between the same accounts from deadlocking.
 */
export async function postEntry(
  db: Database,
  entry: EntryInput,
  options: { idempotencyKey?: string; reverses?: string } = {},
): Promise<PostedEntry & { replayed: boolean }> {
  validate(entry);
  const key = options.idempotencyKey ?? null;
  const hash = key === null ? null : requestHash(entry);
  const postings = [...entry.postings].sort(byAccount);

  return db.transaction(async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      "insert into journal_entries (description, idempotency_key, request_hash, reverses) values ($1, $2, $3, $4::bigint) on conflict (idempotency_key) do nothing returning id::text as id",
      [entry.description, key, hash, options.reverses ?? null],
    );

    if (inserted.rows.length === 0) {
      // The key is taken: this is a retry, or a mistake.
      const existing = await tx.query<{ id: string; description: string; request_hash: string }>(
        "select id::text as id, description, request_hash from journal_entries where idempotency_key = $1",
        [key],
      );
      const found = existing.rows[0]!;
      if (found.request_hash !== hash) throw new IdempotencyConflict(`idempotency key ${key} was already used for a different entry (${found.id})`);
      const recorded = await tx.query<{ account_id: string; currency: string; amount: string }>(
        "select account_id, currency, amount::text as amount from postings where entry_id = $1::bigint order by account_id, amount",
        [found.id],
      );
      return {
        id: found.id,
        description: found.description,
        postings: recorded.rows.map((r) => ({ accountId: r.account_id, currency: r.currency.trim(), amount: BigInt(r.amount) })),
        replayed: true,
      };
    }

    const id = inserted.rows[0]!.id;
    for (const posting of postings) {
      await tx.query("insert into postings (entry_id, account_id, currency, amount) values ($1::bigint, $2, $3, $4::bigint)", [id, posting.accountId, posting.currency, posting.amount.toString()]);
    }
    return { id, description: entry.description, postings, replayed: false };
  }).catch((error: unknown) => {
    // The overdraft check runs at commit, so it surfaces as the commit's error.
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("insufficient funds")) throw new InsufficientFunds(message);
    throw error;
  });
}

/**
 * Corrects a recorded entry the only way the ledger allows: a new entry
 * with every posting negated, linked to the one it undoes. Both stay in the
 * books. An entry can be reversed once (the database holds that with a
 * unique index), and a reversal can't itself be reversed — post a new
 * entry instead.
 */
export async function reverseEntry(db: Database, entryId: string, options: { description?: string; idempotencyKey?: string } = {}): Promise<PostedEntry & { replayed: boolean }> {
  const original = await db.query<{ description: string; reverses: string | null }>("select description, reverses::text as reverses from journal_entries where id = $1::bigint", [entryId]);
  const found = original.rows[0];
  if (!found) throw new LedgerError(`entry ${entryId} does not exist`);
  if (found.reverses !== null) throw new LedgerError(`entry ${entryId} is itself a reversal; post a new entry instead`);
  const recorded = await db.query<{ account_id: string; currency: string; amount: string }>("select account_id, currency, amount::text as amount from postings where entry_id = $1::bigint", [entryId]);
  return postEntry(
    db,
    {
      description: options.description ?? `Reversal of entry ${entryId}: ${found.description}`,
      postings: recorded.rows.map((r) => ({ accountId: r.account_id, currency: r.currency.trim(), amount: -BigInt(r.amount) })),
    },
    { idempotencyKey: options.idempotencyKey, reverses: entryId },
  );
}

/**
 * An account's balance in its normal direction, in minor units: what a
 * person would call the balance. A wallet (credit-normal) holding $10 is
 * 1000n; the platform's cash (debit-normal) holding $10 is 1000n too.
 */
export async function getBalance(db: Queryable, accountId: string): Promise<bigint> {
  const { rows } = await db.query<{ balance: string }>("select balance::text as balance from account_balances where account_id = $1", [accountId]);
  if (!rows[0]) throw new LedgerError(`account ${accountId} does not exist`);
  return BigInt(rows[0].balance);
}

/** Accounts whose running balance disagrees with their postings. Always empty, unless something is very wrong. */
export async function balanceMismatches(db: Queryable): Promise<{ accountId: string; running: bigint; fromPostings: bigint }[]> {
  const { rows } = await db.query<{ account_id: string; running: string; from_postings: string }>("select account_id, running::text, from_postings::text from balance_mismatches");
  return rows.map((r) => ({ accountId: r.account_id, running: BigInt(r.running), fromPostings: BigInt(r.from_postings) }));
}

/** Debits minus credits on an account, in minor units: the raw signed sum. */
export async function rawBalance(db: Queryable, accountId: string): Promise<bigint> {
  const { rows } = await db.query<{ total: string }>("select coalesce(sum(amount), 0)::text as total from postings where account_id = $1", [accountId]);
  return BigInt(rows[0]!.total);
}

export type { PostingInput };
