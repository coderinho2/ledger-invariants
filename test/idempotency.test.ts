import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createAccount, IdempotencyConflict, postEntry, rawBalance } from "../src/index.js";
import type { EntryInput } from "../src/index.js";
import { freshDatabase } from "./db.js";

let db: PGlite;

const deposit = (cents: bigint): EntryInput => ({
  description: "Alice deposits",
  postings: [
    { accountId: "cash:usd", currency: "USD", amount: cents },
    { accountId: "wallet:alice", currency: "USD", amount: -cents },
  ],
});

const entries = async () => Number((await db.query<{ n: number }>("select count(*)::int as n from journal_entries")).rows[0]!.n);

beforeEach(async () => {
  db = await freshDatabase();
  await createAccount(db, { id: "cash:usd", name: "Platform cash", currency: "USD", normalBalance: "debit" });
  await createAccount(db, { id: "wallet:alice", name: "Alice's wallet", currency: "USD", normalBalance: "credit" });
});

describe("invariant 3: posting is idempotent", () => {
  it("records a retried entry once and returns the original", async () => {
    const first = await postEntry(db, deposit(1000n), { idempotencyKey: "dep_1" });
    const retry = await postEntry(db, deposit(1000n), { idempotencyKey: "dep_1" });
    expect(first.replayed).toBe(false);
    expect(retry).toMatchObject({ id: first.id, replayed: true });
    expect(retry.postings).toEqual(first.postings);
    expect(await entries()).toBe(1);
    expect(await rawBalance(db, "wallet:alice")).toBe(-1000n);
  });

  it("treats the same postings listed in another order as the same request", async () => {
    await postEntry(db, deposit(1000n), { idempotencyKey: "dep_1" });
    const reordered = { ...deposit(1000n), postings: [...deposit(1000n).postings].reverse() };
    expect((await postEntry(db, reordered, { idempotencyKey: "dep_1" })).replayed).toBe(true);
  });

  it("refuses the same key for a different entry, and moves nothing", async () => {
    await postEntry(db, deposit(1000n), { idempotencyKey: "dep_1" });
    await expect(postEntry(db, deposit(5000n), { idempotencyKey: "dep_1" })).rejects.toThrow(IdempotencyConflict);
    expect(await entries()).toBe(1);
    expect(await rawBalance(db, "wallet:alice")).toBe(-1000n);
  });

  it("records entries with different keys, or no key, separately", async () => {
    await postEntry(db, deposit(1000n), { idempotencyKey: "dep_1" });
    await postEntry(db, deposit(1000n), { idempotencyKey: "dep_2" });
    await postEntry(db, deposit(1000n));
    await postEntry(db, deposit(1000n));
    expect(await entries()).toBe(4);
    expect(await rawBalance(db, "wallet:alice")).toBe(-4000n);
  });

  it("records one entry when the same request arrives many times at once", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => postEntry(db, deposit(1000n), { idempotencyKey: "dep_burst" })));
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await entries()).toBe(1);
  });
});
