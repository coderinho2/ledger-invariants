/** Anything that runs SQL: a pg PoolClient, a PGlite instance or transaction. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** A database that can run a callback in one transaction. PGlite fits as is; see `fromPgPool` for pg. */
export interface Database extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

export type NormalBalance = "debit" | "credit";

export interface NewAccount {
  id: string;
  name: string;
  /** ISO 4217 code, e.g. "USD". */
  currency: string;
  normalBalance: NormalBalance;
  /** Refuse any entry that would leave this account below zero, e.g. a customer's wallet. Default false. */
  protected?: boolean;
}

/** One side of an entry. Debits are positive, credits negative, in minor units (cents). */
export interface PostingInput {
  accountId: string;
  currency: string;
  amount: bigint;
}

export interface EntryInput {
  description: string;
  postings: PostingInput[];
}

export interface PostedEntry {
  id: string;
  description: string;
  postings: PostingInput[];
}
