import { describe, expect, it } from "vitest";
import { freshDatabase } from "./db.js";

describe("accounts", () => {
  it("are created with a currency and a normal balance", async () => {
    const db = await freshDatabase();
    await db.query("insert into accounts (id, name, currency, normal_balance) values ($1, $2, $3, $4)", ["wallet:alice", "Alice's wallet", "USD", "credit"]);
    const { rows } = await db.query<{ currency: string; normal_balance: string }>("select currency, normal_balance from accounts where id = 'wallet:alice'");
    expect(rows).toEqual([{ currency: "USD", normal_balance: "credit" }]);
  });

  it("refuse a currency that isn't a three-letter code", async () => {
    const db = await freshDatabase();
    await expect(db.query("insert into accounts (id, name, currency, normal_balance) values ('x', 'X', 'us$', 'debit')")).rejects.toThrow(/check constraint/);
  });

  it("refuse a normal balance other than debit or credit", async () => {
    const db = await freshDatabase();
    await expect(db.query("insert into accounts (id, name, currency, normal_balance) values ('x', 'X', 'USD', 'up')")).rejects.toThrow(/check constraint/);
  });
});
