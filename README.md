# ledger-invariants

[![test](https://github.com/coderinho2/ledger-invariants/actions/workflows/test.yml/badge.svg)](https://github.com/coderinho2/ledger-invariants/actions/workflows/test.yml)

A double-entry ledger in Postgres where the rules that keep money correct are
enforced by the database itself, and proven with tests that try hard to
break them.

## Why this exists

The simplest ledger is a table of balances that code adds to and subtracts
from. It breaks in three ordinary ways:

- **A crash in the middle.** A transfer takes $50 from one balance, then the
  process dies before adding it to the other. The money is gone, and nothing
  records that it ever existed.
- **Two writers at once.** Two requests read the same balance, each subtracts
  from what it read, and one write overwrites the other. An account can pay
  out more than it holds.
- **Fixing the past.** Someone corrects an old amount in place. Every report
  that was right yesterday is now different, and there is no record of why.

Double-entry fixes the first and the third by construction: every movement
is one entry with two or more sides that must cancel out, so money can't
appear or vanish, and history only grows. This repo makes Postgres enforce
those rules itself, adds idempotency and safe concurrency for the second,
and tests each rule by trying to break it.

## The invariants

1. **Every entry balances.** The postings of a journal entry sum to zero in
   each currency. Postgres refuses to commit one that doesn't.
2. **History is append-only.** A posting is never updated or deleted. A
   mistake is corrected by a new, reversing entry.
3. **Posting is idempotent.** Sending the same entry twice, with the same
   key, records it once. The same key with a different entry is refused.
4. **Protected accounts can't go negative**, even with many concurrent
   writers.

## Use it

```ts
import pg from "pg";
import { createAccount, fromPgPool, getBalance, postEntry, reverseEntry, SCHEMA } from "ledger-invariants";

const db = fromPgPool(new pg.Pool());
await db.query(SCHEMA); // once

await createAccount(db, { id: "cash:usd", name: "Platform cash", currency: "USD", normalBalance: "debit" });
await createAccount(db, { id: "wallet:alice", name: "Alice", currency: "USD", normalBalance: "credit", protected: true });
await createAccount(db, { id: "wallet:bob", name: "Bob", currency: "USD", normalBalance: "credit", protected: true });

// Alice deposits $10: the platform's cash goes up, and so does what it owes Alice.
await postEntry(db, {
  description: "Alice deposits $10",
  postings: [
    { accountId: "cash:usd", currency: "USD", amount: 1000n }, // debit
    { accountId: "wallet:alice", currency: "USD", amount: -1000n }, // credit
  ],
}, { idempotencyKey: "dep_7Hq2" });

// Alice pays Bob $4. Retrying with the same key records it once.
await postEntry(db, {
  description: "Alice pays Bob",
  postings: [
    { accountId: "wallet:alice", currency: "USD", amount: 400n },
    { accountId: "wallet:bob", currency: "USD", amount: -400n },
  ],
}, { idempotencyKey: "pay_91xK" });

await getBalance(db, "wallet:alice"); // 600n — balances read in the account's normal direction
```

The same example runs end to end with `DATABASE_URL=postgres://... npm run example`
([examples/quickstart.ts](examples/quickstart.ts)).

Amounts are integers in minor units (cents), as `bigint`. Debits are
positive and credits negative, so an entry's amounts always sum to zero.

| Call | Does |
| --- | --- |
| `postEntry(db, entry, { idempotencyKey? })` | Records an entry in one transaction. Returns `{ id, postings, replayed }`. Throws `InsufficientFunds`, `IdempotencyConflict` or `LedgerError`. |
| `reverseEntry(db, entryId)` | Posts the mirror image of an entry, linked to it. Once per entry. |
| `getBalance(db, accountId)` | The running balance, in the account's normal direction. |
| `balanceMismatches(db)` | Accounts whose running balance disagrees with their postings. Always empty. |

## How each invariant is enforced

The rules live in Postgres ([sql/schema.sql](sql/schema.sql)), not only in
application code, so no client — and no hurried manual fix in a SQL console —
can get around them.

1. **Every entry balances.** A `DEFERRABLE INITIALLY DEFERRED` constraint
   trigger checks each entry when the transaction commits: its postings must
   exist and sum to zero in every currency. Deferring matters: postings
   arrive one insert at a time, and only the finished set has to balance. A
   composite foreign key on `(account_id, currency)` keeps each posting in
   its account's own currency.
2. **History is append-only.** Triggers refuse `UPDATE`, `DELETE` and
   `TRUNCATE` on entries and postings. `reverseEntry` corrects a mistake with
   a new entry, and a unique index on `reverses` lets an entry be reversed
   only once.
3. **Posting is idempotent.** `idempotency_key` is unique. The insert uses
   `ON CONFLICT DO NOTHING`, so when two retries race, the second waits for
   the first to commit and then finds its entry. A SHA-256 fingerprint of the
   entry (independent of posting order) tells a retry from a key reused for
   something else.
4. **Protected accounts can't go negative.** Each posting updates its
   account's row in `account_balances` in the same transaction. That update
   takes the row's lock, so writers on one account queue up and the second
   sees the first's result. A deferred trigger checks the final balance at
   commit. Postings are always written in account order, so two transfers
   between the same accounts take their locks in the same order and can't
   deadlock.

## How it's tested

```
npm test                                   # PGlite: Postgres compiled to WebAssembly, no server
DATABASE_URL=postgres://... npm test       # also the real-concurrency tests, as CI does
```

- **Each invariant on its own:** unbalanced, one-sided and empty entries;
  currencies that don't cancel separately; every kind of edit to history;
  retries, reordered retries and conflicting keys; reversals; overdrafts,
  including an entry that touches one account twice.
- **Against a model:** fast-check generates random sequences of deposits,
  payments, reversals and retried requests. A plain in-memory model predicts
  each outcome — accepted, or refused and why — and the balances after it.
  The ledger must agree after every step.
- **Under real concurrency**, on a Postgres server with 20 connections:
  - 50 simultaneous $1 payments from a $10 wallet: exactly 10 succeed.
  - 30 racing retries of one request: one entry.
  - 400 random transfers among 8 wallets: no deadlock, no wallet below zero,
    the total unchanged, and every running balance equal to its postings.

The tests were checked by breaking the code on purpose. Each of these makes
them fail:

- writing postings in arbitrary order (deadlocks);
- removing the overdraft check;
- allowing an entry to be reversed twice — fast-check shrinks it to
  "deposit 1 cent, reverse it, reverse it again";
- letting a reused key replay a different entry.

## Limits

- **One currency per account.** Converting between currencies is two
  entries through a conversion account, with the rate recorded by you.
- **Balances are kept, not cached.** Each write updates one row per account
  it touches, so a single very hot account serialises its writers. That's
  the price of the guarantee; splitting a hot account into sub-accounts is
  the usual way out.
- **Not published to npm.**

## License

MIT
