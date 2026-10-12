import { describe, expect, it } from "vitest";
import { freshDatabase } from "./db.js";

async function withAccounts() {
  const db = await freshDatabase();
  await db.exec(`
    insert into accounts (id, name, currency, normal_balance) values
      ('cash:usd', 'Platform cash', 'USD', 'debit'),
      ('wallet:alice', 'Alice''s wallet', 'USD', 'credit'),
      ('wallet:bob:eur', 'Bob''s euro wallet', 'EUR', 'credit');
  `);
  return db;
}

describe("postings", () => {
  it("record each side of an entry on its account", async () => {
    const db = await withAccounts();
    const { rows } = await db.query<{ id: number }>("insert into journal_entries (description) values ('Alice deposits $10') returning id");
    const entry = rows[0]!.id;
    await db.query("insert into postings (entry_id, account_id, currency, amount) values ($1, 'cash:usd', 'USD', 1000), ($1, 'wallet:alice', 'USD', -1000)", [entry]);
    const sum = await db.query<{ total: string }>("select sum(amount)::text as total from postings where entry_id = $1", [entry]);
    expect(sum.rows[0]!.total).toBe("0");
  });

  it("must be in the account's own currency", async () => {
    const db = await withAccounts();
    await db.query("insert into journal_entries (description) values ('wrong currency')");
    await expect(db.query("insert into postings (entry_id, account_id, currency, amount) values (1, 'wallet:bob:eur', 'USD', 500)")).rejects.toThrow(/foreign key/);
  });

  it("can't be for zero", async () => {
    const db = await withAccounts();
    await db.query("insert into journal_entries (description) values ('nothing')");
    await expect(db.query("insert into postings (entry_id, account_id, currency, amount) values (1, 'cash:usd', 'USD', 0)")).rejects.toThrow(/check constraint/);
  });
});
