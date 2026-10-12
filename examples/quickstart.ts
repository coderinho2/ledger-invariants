// The README's example, runnable against a disposable database:
//   DATABASE_URL=postgres://... npm run example
// It drops and recreates the public schema.
import pg from "pg";
import { createAccount, fromPgPool, getBalance, InsufficientFunds, postEntry, reverseEntry, SCHEMA } from "../src/index.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const db = fromPgPool(pool);

await db.query("drop schema public cascade; create schema public;");
await db.query(SCHEMA);

await createAccount(db, { id: "cash:usd", name: "Platform cash", currency: "USD", normalBalance: "debit" });
await createAccount(db, { id: "wallet:alice", name: "Alice", currency: "USD", normalBalance: "credit", protected: true });
await createAccount(db, { id: "wallet:bob", name: "Bob", currency: "USD", normalBalance: "credit", protected: true });

const usd = (accountId: string, amount: bigint) => ({ accountId, currency: "USD", amount });

await postEntry(db, { description: "Alice deposits $10", postings: [usd("cash:usd", 1000n), usd("wallet:alice", -1000n)] }, { idempotencyKey: "dep_7Hq2" });
const payment = await postEntry(db, { description: "Alice pays Bob", postings: [usd("wallet:alice", 400n), usd("wallet:bob", -400n)] }, { idempotencyKey: "pay_91xK" });
const retry = await postEntry(db, { description: "Alice pays Bob", postings: [usd("wallet:alice", 400n), usd("wallet:bob", -400n)] }, { idempotencyKey: "pay_91xK" });
console.log(`payment ${payment.id}; retry replayed: ${retry.replayed}`);
console.log(`Alice ${await getBalance(db, "wallet:alice")}, Bob ${await getBalance(db, "wallet:bob")}`);

try {
  await postEntry(db, { description: "too much", postings: [usd("wallet:alice", 5000n), usd("wallet:bob", -5000n)] });
} catch (error) {
  console.log(error instanceof InsufficientFunds ? `refused: ${error.message}` : error);
}

await reverseEntry(db, payment.id);
console.log(`after reversing the payment: Alice ${await getBalance(db, "wallet:alice")}, Bob ${await getBalance(db, "wallet:bob")}`);

await pool.end();
