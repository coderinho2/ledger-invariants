-- ledger-invariants schema.
--
-- Amounts are integers in the currency's minor unit (cents for USD), never
-- floating point: 0.1 + 0.2 is not 0.3 in binary, and a ledger that rounds
-- has already lost money.

-- An account is anywhere money can sit: a customer's wallet, the platform's
-- bank account, a fees revenue account.
--
-- normal_balance says which side makes the account grow. Assets and expenses
-- grow with debits; liabilities, equity and revenue grow with credits. A
-- customer's wallet is a liability of the platform (money it owes), so it
-- is credit-normal: depositing $10 credits it.
create table accounts (
  id             text primary key,
  name           text not null,
  currency       char(3) not null check (currency ~ '^[A-Z]{3}$'),
  normal_balance text not null check (normal_balance in ('debit', 'credit')),
  created_at     timestamptz not null default now()
);
