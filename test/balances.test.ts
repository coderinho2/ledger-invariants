import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { balanceMismatches, createAccount, getBalance, postEntry, reverseEntry } from "../src/index.js";
import { freshDatabase } from "./db.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDatabase();
  await createAccount(db, { id: "cash:usd", name: "Platform cash", currency: "USD", normalBalance: "debit" });
  await createAccount(db, { id: "wallet:alice", name: "Alice's wallet", currency: "USD", normalBalance: "credit" });
  await createAccount(db, { id: "wallet:bob", name: "Bob's wallet", currency: "USD", normalBalance: "credit" });
  await createAccount(db, { id: "revenue:fees", name: "Fee revenue", currency: "USD", normalBalance: "credit" });
});

const usd = (accountId: string, amount: bigint) => ({ accountId, currency: "USD", amount });

describe("running balances", () => {
  it("start at zero for a new account", async () => {
    expect(await getBalance(db, "wallet:alice")).toBe(0n);
  });

  it("read the way a person would: money in a wallet is a positive balance", async () => {
    await postEntry(db, { description: "Alice deposits $10", postings: [usd("cash:usd", 1000n), usd("wallet:alice", -1000n)] });
    expect(await getBalance(db, "cash:usd")).toBe(1000n);
    expect(await getBalance(db, "wallet:alice")).toBe(1000n);
  });

  it("follow transfers, fees and reversals, and always agree with the postings", async () => {
    await postEntry(db, { description: "deposit", postings: [usd("cash:usd", 1000n), usd("wallet:alice", -1000n)] });
    // Alice sends Bob $4 and pays a 30-cent fee: three sides, one entry.
    const payment = await postEntry(db, {
      description: "Alice pays Bob $4, fee 30c",
      postings: [usd("wallet:alice", 430n), usd("wallet:bob", -400n), usd("revenue:fees", -30n)],
    });
    expect(await getBalance(db, "wallet:alice")).toBe(570n);
    expect(await getBalance(db, "wallet:bob")).toBe(400n);
    expect(await getBalance(db, "revenue:fees")).toBe(30n);

    await reverseEntry(db, payment.id);
    expect(await getBalance(db, "wallet:alice")).toBe(1000n);
    expect(await getBalance(db, "wallet:bob")).toBe(0n);
    expect(await balanceMismatches(db)).toEqual([]);
  });

  it("do not move when an entry is refused", async () => {
    await expect(postEntry(db, { description: "to nobody", postings: [usd("cash:usd", 500n), usd("wallet:nobody", -500n)] })).rejects.toThrow();
    expect(await getBalance(db, "cash:usd")).toBe(0n);
    expect(await balanceMismatches(db)).toEqual([]);
  });

  it("say so for an account that doesn't exist", async () => {
    await expect(getBalance(db, "wallet:nobody")).rejects.toThrow(/does not exist/);
  });
});
