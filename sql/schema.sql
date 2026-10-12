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
  id              bigint generated always as identity primary key,
  description     text not null,
  -- Invariant 3: the caller's key for this entry. Unique, so a retried
  -- request can't record the same movement twice; request_hash is a
  -- fingerprint of the entry, so a reused key with a different entry is
  -- caught instead of silently returning the wrong one.
  idempotency_key text unique,
  request_hash    text,
  created_at      timestamptz not null default now(),
  check ((idempotency_key is null) = (request_hash is null))
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

-- ── Invariant 1: every entry balances ───────────────────────────────────────
-- Checked at COMMIT, not per row: an entry's postings arrive one insert at a
-- time, and only the finished set has to sum to zero. A constraint trigger
-- that is DEFERRABLE INITIALLY DEFERRED runs at commit, so a transaction that
-- leaves any entry unbalanced (or with no postings at all) is rolled back
-- whole: the money can't appear or vanish, even halfway through.
create function assert_entry_balanced(p_entry bigint) returns void
language plpgsql as $$
declare
  v_currency text;
begin
  if not exists (select 1 from postings where entry_id = p_entry) then
    raise exception 'journal entry % has no postings', p_entry using errcode = 'check_violation';
  end if;

  select currency into v_currency
    from postings
   where entry_id = p_entry
   group by currency
  having sum(amount) <> 0
   limit 1;

  if v_currency is not null then
    raise exception 'journal entry % does not balance in %', p_entry, v_currency using errcode = 'check_violation';
  end if;
end;
$$;

create function postings_balance() returns trigger
language plpgsql as $$
begin
  perform assert_entry_balanced(new.entry_id);
  return null;
end;
$$;

create function journal_entries_have_postings() returns trigger
language plpgsql as $$
begin
  perform assert_entry_balanced(new.id);
  return null;
end;
$$;

create constraint trigger postings_balance
  after insert on postings
  deferrable initially deferred
  for each row execute function postings_balance();

create constraint trigger journal_entries_have_postings
  after insert on journal_entries
  deferrable initially deferred
  for each row execute function journal_entries_have_postings();

-- ── Invariant 2: history is append-only ─────────────────────────────────────
-- Once committed, an entry and its postings never change and never go away.
-- A mistake is corrected by a new entry that reverses it, so the books can
-- always explain how they got to where they are. Truncate is refused too.
create function refuse_history_change() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only: % is not allowed; post a reversing entry instead', tg_table_name, lower(tg_op)
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger postings_append_only
  before update or delete on postings
  for each row execute function refuse_history_change();

create trigger journal_entries_append_only
  before update or delete on journal_entries
  for each row execute function refuse_history_change();

create trigger postings_no_truncate
  before truncate on postings
  for each statement execute function refuse_history_change();

create trigger journal_entries_no_truncate
  before truncate on journal_entries
  for each statement execute function refuse_history_change();
