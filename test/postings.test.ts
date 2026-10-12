import { describe, expect, it } from "vitest";
import { freshDatabase } from "./db.js";

async function withAccounts() {
  const db = await freshDatabase();
  await db.exec(`
    insert into accounts (id, name, currency, normal_balance) values
      ('cash:usd', 'Platform cash', 'USD', 'debit'),
      ('wallet:alice', 'Alice''s wallet', 'USD', 'credit'),
      ('wallet:bob:eur', 'Bob''s euro wallet', 'EUR', 'credit'),
      ('cash:eur', 'Platform euro cash', 'EUR', 'debit');
  `);
  return db;
}

/** One entry with the given postings, in one transaction, as an application would write it. */
async function post(db: Awaited<ReturnType<typeof withAccounts>>, postings: [account: string, currency: string, amount: number][]) {
  return db.transaction(async (tx) => {
    const { rows } = await tx.query<{ id: number }>("insert into journal_entries (description) values ('test') returning id");
    for (const [account, currency, amount] of postings) {
      await tx.query("insert into postings (entry_id, account_id, currency, amount) values ($1, $2, $3, $4)", [rows[0]!.id, account, currency, amount]);
    }
    return rows[0]!.id;
  });
}

const count = async (db: Awaited<ReturnType<typeof withAccounts>>, table: string) =>
  Number((await db.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n);

describe("postings", () => {
  it("record each side of an entry on its account", async () => {
    const db = await withAccounts();
    const entry = await post(db, [["cash:usd", "USD", 1000], ["wallet:alice", "USD", -1000]]);
    const sum = await db.query<{ total: string }>("select sum(amount)::text as total from postings where entry_id = $1", [entry]);
    expect(sum.rows[0]!.total).toBe("0");
  });

  it("must be in the account's own currency", async () => {
    const db = await withAccounts();
    await expect(post(db, [["wallet:bob:eur", "USD", 500], ["cash:usd", "USD", -500]])).rejects.toThrow(/foreign key/);
  });

  it("can't be for zero", async () => {
    const db = await withAccounts();
    await expect(post(db, [["cash:usd", "USD", 0]])).rejects.toThrow(/check constraint/);
  });
});

describe("invariant 1: every entry balances", () => {
  it("refuses an entry whose sides don't cancel out, and keeps none of it", async () => {
    const db = await withAccounts();
    await expect(post(db, [["cash:usd", "USD", 1000], ["wallet:alice", "USD", -999]])).rejects.toThrow(/does not balance in USD/);
    expect(await count(db, "journal_entries")).toBe(0);
    expect(await count(db, "postings")).toBe(0);
  });

  it("refuses a one-sided entry", async () => {
    const db = await withAccounts();
    await expect(post(db, [["cash:usd", "USD", 1000]])).rejects.toThrow(/does not balance/);
  });

  it("refuses an entry with no postings", async () => {
    const db = await withAccounts();
    await expect(post(db, [])).rejects.toThrow(/has no postings/);
  });

  it("balances each currency on its own: dollars can't pay for euros", async () => {
    const db = await withAccounts();
    // The totals across currencies happen to be zero, but each currency is not.
    await expect(post(db, [["cash:usd", "USD", 1000], ["wallet:bob:eur", "EUR", -1000]])).rejects.toThrow(/does not balance/);
    // An entry that balances in both currencies is fine.
    await post(db, [["cash:usd", "USD", 1000], ["wallet:alice", "USD", -1000], ["cash:eur", "EUR", 500], ["wallet:bob:eur", "EUR", -500]]);
    expect(await count(db, "journal_entries")).toBe(1);
  });

  it("allows many sides, as long as they cancel out", async () => {
    const db = await withAccounts();
    await post(db, [["cash:usd", "USD", 1000], ["wallet:alice", "USD", -700], ["wallet:alice", "USD", -300]]);
    expect(await count(db, "postings")).toBe(3);
  });
});
