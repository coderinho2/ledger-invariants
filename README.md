# ledger-invariants

A double-entry ledger in Postgres where the rules that keep money correct are
enforced by the database itself, and proven with tests that try hard to
break them.

## Why this exists

<!-- STEP 1 — Armin writes this section, in his own words (4–6 sentences).
     Answer: what goes wrong in a payments system when a ledger is just a
     table of balances that code adds to and subtracts from? Think about a
     crash halfway through a transfer, two requests at the same time, and
     someone "fixing" a past row. Why is double-entry the answer? -->

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
