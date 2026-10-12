import { PGlite } from "@electric-sql/pglite";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { balanceMismatches, createAccount, getBalance, IdempotencyConflict, InsufficientFunds, LedgerError, postEntry, reverseEntry, SCHEMA } from "../src/index.js";
import type { PostingInput } from "../src/index.js";

/**
 * A model-based property test. fast-check generates random sequences of
 * operations; a few lines of plain TypeScript (the model) say what each one
 * should do — succeed, or be refused, and with which balances after — and
 * the ledger in Postgres must agree with the model after every step.
 *
 * The model is deliberately naive: a map of balances and a list of entries.
 * Anything the database does differently is a bug in one of them, and
 * fast-check shrinks the failing sequence to the shortest one that shows it.
 */

const WALLETS = ["wallet:alice", "wallet:bob", "wallet:carol"] as const;
type Wallet = (typeof WALLETS)[number];

type Op =
  | { kind: "deposit"; to: Wallet; cents: number; key: string | null }
  | { kind: "pay"; from: Wallet; to: Wallet; cents: number; key: string | null }
  | { kind: "reverse"; pick: number }
  | { kind: "retry"; pick: number; changeAmount: boolean };

const wallet = fc.constantFrom(...WALLETS);
const cents = fc.integer({ min: 1, max: 5_000 });
const key = fc.option(fc.uuid(), { nil: null });
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ kind: fc.constant("deposit" as const), to: wallet, cents, key }),
  fc.record({ kind: fc.constant("pay" as const), from: wallet, to: wallet, cents, key }).filter((p) => p.from !== p.to),
  fc.record({ kind: fc.constant("reverse" as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant("retry" as const), pick: fc.nat(), changeAmount: fc.boolean() }),
);

/** What the model remembers about each entry the ledger accepted. */
interface ModelEntry {
  id: string;
  postings: PostingInput[];
  description: string;
  key: string | null;
  reversed: boolean;
  isReversal: boolean;
}

const usd = (accountId: string, amount: bigint): PostingInput => ({ accountId, currency: "USD", amount });

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
});
afterAll(async () => db.close());

/** History is append-only, so each run starts from a new schema rather than deleting rows. */
async function freshLedger() {
  await db.exec("drop schema public cascade; create schema public;");
  await db.exec(SCHEMA);
  await createAccount(db, { id: "cash:usd", name: "Platform cash", currency: "USD", normalBalance: "debit" });
  for (const id of WALLETS) await createAccount(db, { id, name: id, currency: "USD", normalBalance: "credit", protected: true });
}

/** A wallet's balance in its normal direction, as the model sees it. Credits raise it. */
function applyToModel(balances: Map<string, bigint>, postings: PostingInput[]) {
  for (const p of postings) {
    const normal = p.accountId === "cash:usd" ? p.amount : -p.amount;
    balances.set(p.accountId, (balances.get(p.accountId) ?? 0n) + normal);
  }
}

function wouldOverdraw(balances: Map<string, bigint>, postings: PostingInput[]) {
  const after = new Map(balances);
  applyToModel(after, postings);
  return WALLETS.some((w) => (after.get(w) ?? 0n) < 0n);
}

/** The outcome the ledger reports, reduced to what the model can predict. */
async function outcome<T>(attempt: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await attempt };
  } catch (error) {
    if (error instanceof InsufficientFunds) return { ok: false, error: "insufficient" };
    if (error instanceof IdempotencyConflict) return { ok: false, error: "conflict" };
    if (error instanceof LedgerError) return { ok: false, error: "refused" };
    if (error instanceof Error && /unique/.test(error.message)) return { ok: false, error: "already-reversed" };
    throw error;
  }
}

const RUNS = Number(process.env.PROPERTY_RUNS ?? 40);

describe("the ledger against a model", () => {
  it("agrees with the model on every outcome and every balance, for any sequence of operations", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 25 }), async (ops) => {
        await freshLedger();
        const balances = new Map<string, bigint>();
        const entries: ModelEntry[] = [];

        for (const step of ops) {
          if (step.kind === "deposit" || step.kind === "pay") {
            const postings = step.kind === "deposit" ? [usd("cash:usd", BigInt(step.cents)), usd(step.to, -BigInt(step.cents))] : [usd(step.from, BigInt(step.cents)), usd(step.to, -BigInt(step.cents))];
            const description = step.kind;
            const reused = step.key !== null && entries.some((e) => e.key === step.key);
            const expected = reused ? "replay-or-conflict" : wouldOverdraw(balances, postings) ? "insufficient" : "ok";
            const result = await outcome(postEntry(db, { description, postings }, step.key ? { idempotencyKey: step.key } : {}));
            if (expected === "ok") {
              expect(result.ok, `${description} should succeed`).toBe(true);
              if (result.ok) {
                applyToModel(balances, postings);
                entries.push({ id: result.value.id, postings, description, key: step.key, reversed: false, isReversal: false });
              }
            } else if (expected === "insufficient") {
              expect(result).toEqual({ ok: false, error: "insufficient" });
            }
          }

          if (step.kind === "reverse" && entries.length > 0) {
            const target = entries[step.pick % entries.length]!;
            const postings = target.postings.map((p) => ({ ...p, amount: -p.amount }));
            const expected = target.isReversal ? "refused" : target.reversed ? "already-reversed" : wouldOverdraw(balances, postings) ? "insufficient" : "ok";
            const result = await outcome(reverseEntry(db, target.id));
            if (expected === "ok") {
              expect(result.ok, `reversing ${target.id} should succeed`).toBe(true);
              if (result.ok) {
                applyToModel(balances, postings);
                target.reversed = true;
                entries.push({ id: result.value.id, postings, description: result.value.description, key: null, reversed: false, isReversal: true });
              }
            } else {
              expect(result).toEqual({ ok: false, error: expected });
            }
          }

          if (step.kind === "retry") {
            const keyed = entries.filter((e) => e.key !== null);
            if (keyed.length > 0) {
              const original = keyed[step.pick % keyed.length]!;
              const postings = step.changeAmount ? original.postings.map((p) => ({ ...p, amount: p.amount * 2n })) : original.postings;
              const result = await outcome(postEntry(db, { description: original.description, postings }, { idempotencyKey: original.key! }));
              if (step.changeAmount) expect(result).toEqual({ ok: false, error: "conflict" });
              else expect(result.ok && result.value.replayed && result.value.id === original.id, "a retry returns the original").toBe(true);
            }
          }

          // After every step: the ledger's balances are the model's.
          for (const id of WALLETS) expect(await getBalance(db, id), id).toBe(balances.get(id) ?? 0n);
          expect(await getBalance(db, "cash:usd")).toBe(balances.get("cash:usd") ?? 0n);
        }

        expect(await balanceMismatches(db)).toEqual([]);
        const { rows } = await db.query<{ sum: string }>("select coalesce(sum(amount), 0)::text as sum from postings");
        expect(rows[0]!.sum).toBe("0");
      }),
      { numRuns: RUNS },
    );
  }, 600_000);
});
