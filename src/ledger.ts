import type { Database, EntryInput, NewAccount, PostedEntry, PostingInput, Queryable } from "./types.js";

/** Refused before anything reaches the database: the database would refuse it too, less helpfully. */
export class LedgerError extends Error {}

export async function createAccount(db: Queryable, account: NewAccount): Promise<void> {
  await db.query("insert into accounts (id, name, currency, normal_balance) values ($1, $2, $3, $4)", [account.id, account.name, account.currency, account.normalBalance]);
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

/**
 * Records one entry and its postings in one transaction. Either all of it
 * is in the books or none of it is.
 *
 * Postings are written in account order. That doesn't matter yet, but once
 * balances are kept per account, writing in a fixed order is what stops two
 * concurrent transfers between the same accounts from deadlocking.
 */
export async function postEntry(db: Database, entry: EntryInput): Promise<PostedEntry> {
  validate(entry);
  const postings = [...entry.postings].sort((a, b) => (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0));
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>("insert into journal_entries (description) values ($1) returning id::text as id", [entry.description]);
    const id = rows[0]!.id;
    for (const posting of postings) {
      await tx.query("insert into postings (entry_id, account_id, currency, amount) values ($1::bigint, $2, $3, $4::bigint)", [id, posting.accountId, posting.currency, posting.amount.toString()]);
    }
    return { id, description: entry.description, postings };
  });
}

/** Debits minus credits on an account, in minor units: the raw signed sum. */
export async function rawBalance(db: Queryable, accountId: string): Promise<bigint> {
  const { rows } = await db.query<{ total: string }>("select coalesce(sum(amount), 0)::text as total from postings where account_id = $1", [accountId]);
  return BigInt(rows[0]!.total);
}

export type { PostingInput };
