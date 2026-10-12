import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createAccount, LedgerError, postEntry, rawBalance } from "../src/index.js";
import { freshDatabase } from "./db.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDatabase();
  await createAccount(db, { id: "cash:usd", name: "Platform cash", currency: "USD", normalBalance: "debit" });
  await createAccount(db, { id: "wallet:alice", name: "Alice's wallet", currency: "USD", normalBalance: "credit" });
  await createAccount(db, { id: "wallet:bob", name: "Bob's wallet", currency: "USD", normalBalance: "credit" });
});

describe("postEntry", () => {
  it("records a deposit: cash comes in, the platform owes Alice", async () => {
    const entry = await postEntry(db, {
      description: "Alice deposits $10",
      postings: [
        { accountId: "cash:usd", currency: "USD", amount: 1000n },
        { accountId: "wallet:alice", currency: "USD", amount: -1000n },
      ],
    });
    expect(entry.id).toBe("1");
    expect(await rawBalance(db, "cash:usd")).toBe(1000n);
    expect(await rawBalance(db, "wallet:alice")).toBe(-1000n);
  });

  it("records a transfer between wallets", async () => {
    await postEntry(db, { description: "deposit", postings: [{ accountId: "cash:usd", currency: "USD", amount: 1000n }, { accountId: "wallet:alice", currency: "USD", amount: -1000n }] });
    await postEntry(db, { description: "Alice pays Bob $4", postings: [{ accountId: "wallet:alice", currency: "USD", amount: 400n }, { accountId: "wallet:bob", currency: "USD", amount: -400n }] });
    expect(await rawBalance(db, "wallet:alice")).toBe(-600n);
    expect(await rawBalance(db, "wallet:bob")).toBe(-400n);
  });

  it("refuses an unbalanced entry before touching the database", async () => {
    await expect(
      postEntry(db, { description: "bad", postings: [{ accountId: "cash:usd", currency: "USD", amount: 1000n }, { accountId: "wallet:alice", currency: "USD", amount: -900n }] }),
    ).rejects.toThrow(LedgerError);
    expect(await rawBalance(db, "cash:usd")).toBe(0n);
  });

  it("refuses an entry with one posting or a zero posting", async () => {
    await expect(postEntry(db, { description: "bad", postings: [{ accountId: "cash:usd", currency: "USD", amount: 1000n }] })).rejects.toThrow(/at least two/);
    await expect(
      postEntry(db, { description: "bad", postings: [{ accountId: "cash:usd", currency: "USD", amount: 0n }, { accountId: "wallet:alice", currency: "USD", amount: 0n }] }),
    ).rejects.toThrow(/for zero/);
  });

  it("writes nothing when a posting names an account that doesn't exist", async () => {
    await expect(
      postEntry(db, { description: "bad", postings: [{ accountId: "cash:usd", currency: "USD", amount: 500n }, { accountId: "wallet:nobody", currency: "USD", amount: -500n }] }),
    ).rejects.toThrow(/foreign key/);
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from journal_entries");
    expect(rows[0]!.n).toBe(0);
  });

  it("keeps amounts exact beyond what a JavaScript number can hold", async () => {
    const huge = 2n ** 62n;
    await postEntry(db, { description: "big", postings: [{ accountId: "cash:usd", currency: "USD", amount: huge }, { accountId: "wallet:alice", currency: "USD", amount: -huge }] });
    expect(await rawBalance(db, "cash:usd")).toBe(huge);
  });
});
