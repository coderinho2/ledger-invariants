# ledger-invariants

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

## Status

- [x] Skeleton and the invariants
- [ ] Schema: accounts, journal entries, postings; invariants 1 and 2 in Postgres
- [ ] Tests for invariants 1 and 2
- [ ] `postEntry()` with idempotency keys (invariant 3)
- [ ] Transfers that can't overdraw, safe under concurrency (invariant 4)
- [ ] Property test: random concurrent transfers, books always balance
- [ ] CI

## License

MIT
