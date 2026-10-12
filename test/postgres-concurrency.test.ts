// The invariants under real concurrency: many connections to a real
// Postgres server writing at once. PGlite runs one query at a time, so only
// this file can show that two transfers racing for the same last dollar,
// or for the same idempotency key, still come out right — and that the
// fixed lock order means they never deadlock.
//
// Runs when DATABASE_URL points at a disposable database (CI provides one).
// It drops and recreates the public schema.
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { balanceMismatches, createAccount, fromPgPool, getBalance, InsufficientFunds, postEntry, SCHEMA } from "../src/index.js";
import type { Database } from "../src/index.js";

const url = process.env.DATABASE_URL;

describe.skipIf(!url)("on a real Postgres server, with concurrent writers", () => {
  const pool = new pg.Pool({ connectionString: url, max: 20 });
  const db: Database = fromPgPool(pool);
  const usd = (accountId: string, amount: bigint) => ({ accountId, currency: "USD", amount });
  const pay = (from: string, to: string, cents: bigint) => postEntry(db, { description: `${from} pays ${to}`, postings: [usd(from, cents), usd(to, -cents)] });

  beforeEach(async () => {
    await pool.query("drop schema public cascade; create schema public;");
    await pool.query(SCHEMA);
    await createAccount(db, { id: "cash:usd", name: "Platform cash", currency: "USD", normalBalance: "debit" });
  });
  afterAll(async () => pool.end());

  async function wallet(id: string, cents: bigint) {
    await createAccount(db, { id, name: id, currency: "USD", normalBalance: "credit", protected: true });
    if (cents > 0n) await postEntry(db, { description: `fund ${id}`, postings: [usd("cash:usd", cents), usd(id, -cents)] });
  }

  it("lets exactly ten of fifty simultaneous $1 payments through a $10 wallet", async () => {
    await wallet("wallet:alice", 1000n);
    await wallet("wallet:bob", 0n);
    const attempts = await Promise.allSettled(Array.from({ length: 50 }, () => pay("wallet:alice", "wallet:bob", 100n)));
    const unexpected = attempts.filter((a) => a.status === "rejected" && !(a.reason instanceof InsufficientFunds));
    expect(unexpected).toEqual([]);
    expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(10);
    expect(await getBalance(db, "wallet:alice")).toBe(0n);
    expect(await getBalance(db, "wallet:bob")).toBe(1000n);
  });

  it("records one entry when thirty retries of one request race each other", async () => {
    await wallet("wallet:alice", 0n);
    const entry = { description: "deposit", postings: [usd("cash:usd", 500n), usd("wallet:alice", -500n)] };
    const results = await Promise.all(Array.from({ length: 30 }, () => postEntry(db, entry, { idempotencyKey: "dep_race" })));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await getBalance(db, "wallet:alice")).toBe(500n);
  });

  it("keeps every invariant through 400 random transfers among 8 wallets, with no deadlock", async () => {
    const wallets = Array.from({ length: 8 }, (_, i) => `wallet:${i}`);
    for (const id of wallets) await wallet(id, 10_000n);

    // A small seeded generator, so a failure can be replayed exactly.
    let seed = 20261012;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const transfers = Array.from({ length: 400 }, () => {
      const from = wallets[Math.floor(random() * wallets.length)]!;
      let to = wallets[Math.floor(random() * wallets.length)]!;
      if (to === from) to = wallets[(wallets.indexOf(from) + 1) % wallets.length]!;
      return { from, to, cents: BigInt(1 + Math.floor(random() * 6_000)) };
    });

    const attempts = await Promise.allSettled(transfers.map((t) => pay(t.from, t.to, t.cents)));
    // The only acceptable failure is a refused overdraft: no deadlock, no serialisation error.
    const unexpected = attempts.filter((a) => a.status === "rejected" && !(a.reason instanceof InsufficientFunds));
    expect(unexpected.map((a) => (a as PromiseRejectedResult).reason?.message)).toEqual([]);
    expect(attempts.some((a) => a.status === "rejected")).toBe(true);

    // No protected wallet below zero, and money only moved, never appeared or vanished.
    let total = 0n;
    for (const id of wallets) {
      const balance = await getBalance(db, id);
      expect(balance, id).toBeGreaterThanOrEqual(0n);
      total += balance;
    }
    expect(total).toBe(80_000n);

    // Every entry balances, and every running balance agrees with its postings.
    const { rows } = await pool.query<{ sum: string }>("select coalesce(sum(amount), 0)::text as sum from postings");
    expect(rows[0]!.sum).toBe("0");
    expect(await balanceMismatches(db)).toEqual([]);
  });
});
