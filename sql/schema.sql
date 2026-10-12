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

-- Lets a posting reference (account, currency) together, so a posting can
-- only ever be in its account's own currency.
alter table accounts add constraint accounts_id_currency unique (id, currency);

-- A journal entry is one financial event: a deposit, a transfer, a fee.
create table journal_entries (
  id          bigint generated always as identity primary key,
  description text not null,
  created_at  timestamptz not null default now()
);

-- A posting is one side of an entry: an amount on one account.
-- Debits are positive and credits negative, so a balanced entry sums to 0.
create table postings (
  id         bigint generated always as identity primary key,
  entry_id   bigint not null references journal_entries (id),
  account_id text not null,
  currency   char(3) not null,
  amount     bigint not null check (amount <> 0),
  foreign key (account_id, currency) references accounts (id, currency)
);

create index postings_entry_id on postings (entry_id);
create index postings_account_id on postings (account_id);
