import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createAccount, postEntry, rawBalance, reverseEntry } from "../src/index.js";
import { freshDatabase } from "./db.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDatabase();
  await createAccount(db, { id: "cash:usd", name: "Platform cash", currency: "USD", normalBalance: "debit" });
  await createAccount(db, { id: "wallet:alice", name: "Alice's wallet", currency: "USD", normalBalance: "credit" });
});

const deposit = (cents: bigint) =>
  postEntry(db, {
    description: "Alice deposits",
    postings: [
      { accountId: "cash:usd", currency: "USD", amount: cents },
      { accountId: "wallet:alice", currency: "USD", amount: -cents },
    ],
  });

describe("correcting a mistake", () => {
  it("posts a mirror-image entry that brings the balances back, keeping both in the books", async () => {
    const mistake = await deposit(10_000n);
    const reversal = await reverseEntry(db, mistake.id);
    expect(reversal.description).toBe(`Reversal of entry ${mistake.id}: Alice deposits`);
    expect(await rawBalance(db, "wallet:alice")).toBe(0n);
    expect(await rawBalance(db, "cash:usd")).toBe(0n);
    const { rows } = await db.query<{ id: string; reverses: string | null }>("select id::text as id, reverses::text as reverses from journal_entries order by id");
    expect(rows).toEqual([
      { id: mistake.id, reverses: null },
      { id: reversal.id, reverses: mistake.id },
    ]);
  });

  it("can then record the right amount", async () => {
    const mistake = await deposit(10_000n);
    await reverseEntry(db, mistake.id);
    await deposit(1_000n);
    expect(await rawBalance(db, "wallet:alice")).toBe(-1_000n);
  });

  it("reverses an entry only once", async () => {
    const mistake = await deposit(10_000n);
    await reverseEntry(db, mistake.id);
    await expect(reverseEntry(db, mistake.id)).rejects.toThrow(/unique/);
    expect(await rawBalance(db, "wallet:alice")).toBe(0n);
  });

  it("returns the same reversal for a retried request", async () => {
    const mistake = await deposit(10_000n);
    const first = await reverseEntry(db, mistake.id, { idempotencyKey: "rev_1" });
    const again = await reverseEntry(db, mistake.id, { idempotencyKey: "rev_1" });
    expect(again).toMatchObject({ id: first.id, replayed: true });
  });

  it("won't reverse a reversal, or an entry that doesn't exist", async () => {
    const mistake = await deposit(10_000n);
    const reversal = await reverseEntry(db, mistake.id);
    await expect(reverseEntry(db, reversal.id)).rejects.toThrow(/itself a reversal/);
    await expect(reverseEntry(db, "999")).rejects.toThrow(/does not exist/);
  });
});
