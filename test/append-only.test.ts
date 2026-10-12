import { beforeEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { freshDatabase } from "./db.js";

let db: PGlite;

beforeEach(async () => {
  db = await freshDatabase();
  await db.exec(`
    insert into accounts (id, name, currency, normal_balance) values
      ('cash:usd', 'Platform cash', 'USD', 'debit'),
      ('wallet:alice', 'Alice''s wallet', 'USD', 'credit');
    begin;
    insert into journal_entries (description) values ('Alice deposits $10');
    insert into postings (entry_id, account_id, currency, amount) values (1, 'cash:usd', 'USD', 1000), (1, 'wallet:alice', 'USD', -1000);
    commit;
  `);
});

describe("invariant 2: history is append-only", () => {
  it("refuses to change a posting's amount", async () => {
    await expect(db.query("update postings set amount = 2000 where account_id = 'cash:usd'")).rejects.toThrow(/append-only: update is not allowed/);
  });

  it("refuses to delete a posting", async () => {
    await expect(db.query("delete from postings where account_id = 'wallet:alice'")).rejects.toThrow(/append-only: delete is not allowed/);
  });

  it("refuses to edit or delete an entry", async () => {
    await expect(db.query("update journal_entries set description = 'something else'")).rejects.toThrow(/append-only/);
    await expect(db.query("delete from journal_entries")).rejects.toThrow(/append-only/);
  });

  it("refuses to truncate either table", async () => {
    await expect(db.query("truncate postings")).rejects.toThrow(/append-only: truncate is not allowed/);
    await expect(db.query("truncate journal_entries cascade")).rejects.toThrow(/append-only/);
  });

  it("leaves the books exactly as they were after every refusal", async () => {
    await db.query("update postings set amount = 1 where true").catch(() => undefined);
    await db.query("delete from postings").catch(() => undefined);
    const { rows } = await db.query<{ account_id: string; amount: number }>("select account_id, amount::int from postings order by id");
    expect(rows).toEqual([
      { account_id: "cash:usd", amount: 1000 },
      { account_id: "wallet:alice", amount: -1000 },
    ]);
  });
});
