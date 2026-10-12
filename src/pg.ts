import { readFileSync } from "node:fs";
import type { Database, Queryable } from "./types.js";

/** The parts of a pg Pool this library uses. */
interface PoolLike extends Queryable {
  connect(): Promise<Queryable & { release(): void }>;
}

/** Wraps a `pg` Pool so each transaction runs on one pooled connection. */
export function fromPgPool(pool: PoolLike): Database {
  return {
    query: (sql, params) => pool.query(sql, params),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(client);
        // The deferred checks (balance, overdraft) run here and can still refuse.
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

/** sql/schema.sql, for setting up a database. */
export const SCHEMA = readFileSync(new URL("../sql/schema.sql", import.meta.url), "utf8");
