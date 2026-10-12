import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { balanceMismatches, createAccount, getBalance, InsufficientFunds, postEntry } from "../src/index.js";
import { freshDatabase } from "./db.js";

let db: PGlite;

const usd = (accountId: string, amount: bigint) => ({ accountId, currency: "USD", amount });
const pay = (from: string, to: string, cents: bigint) => postEntry(db, { description: `${from} pays ${to}`, postings: [usd(from, cents), usd(to, -cents)] });

beforeEach(async () => {
  db = await freshDatabase();
  await createAccount(db, { id: "cash:usd", name: "Platform cash", currency: "USD", normalBalance: "debit" });
  await createAccount(db, { id: "wallet:alice", name: "Alice's wallet", currency: "USD", normalBalance: "credit", protected: true });
  await createAccount(db, { id: "wallet:bob", name: "Bob's wallet", currency: "USD", normalBalance: "credit", protected: true });
  await createAccount(db, { id: "clearing:usd", name: "Clearing", currency: "USD", normalBalance: "credit" });
  // Alice has $10.
  await postEntry(db, { description: "deposit", postings: [usd("cash:usd", 1000n), usd("wallet:alice", -1000n)] });
});

describe("invariant 4: protected accounts can't go negative", () => {
  it("lets a wallet spend down to exactly zero", async () => {
    await pay("wallet:alice", "wallet:bob", 1000n);
    expect(await getBalance(db, "wallet:alice")).toBe(0n);
    expect(await getBalance(db, "wallet:bob")).toBe(1000n);
  });

  it("refuses a payment that would overdraw, and records none of it", async () => {
    await expect(pay("wallet:alice", "wallet:bob", 1001n)).rejects.toThrow(InsufficientFunds);
    expect(await getBalance(db, "wallet:alice")).toBe(1000n);
    expect(await getBalance(db, "wallet:bob")).toBe(0n);
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from journal_entries");
    expect(rows[0]!.n).toBe(1);
  });

  it("judges an entry by where the account ends up, not by the order of its postings", async () => {
    // Alice spends $15 and receives a $6 refund in the same entry: she ends at $1.
    await postEntry(db, {
      description: "purchase with partial refund",
      postings: [usd("wallet:alice", 1500n), usd("wallet:alice", -600n), usd("clearing:usd", -900n)],
    });
    expect(await getBalance(db, "wallet:alice")).toBe(100n);
  });

  it("lets unprotected accounts go negative, as clearing accounts do", async () => {
    await postEntry(db, { description: "payout in flight", postings: [usd("clearing:usd", 5000n), usd("cash:usd", -5000n)] });
    expect(await getBalance(db, "clearing:usd")).toBe(-5000n);
  });

  it("lets only as many of many simultaneous $1 payments through as the $10 covers", async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 25 }, () => pay("wallet:alice", "wallet:bob", 100n)));
    const paid = attempts.filter((a) => a.status === "fulfilled").length;
    const refused = attempts.filter((a) => a.status === "rejected" && a.reason instanceof InsufficientFunds).length;
    expect([paid, refused]).toEqual([10, 15]);
    expect(await getBalance(db, "wallet:alice")).toBe(0n);
    expect(await getBalance(db, "wallet:bob")).toBe(1000n);
    expect(await balanceMismatches(db)).toEqual([]);
  });
});
