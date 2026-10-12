import { describe, expect, it } from "vitest";
import { fromPgPool, SCHEMA } from "../src/index.js";

/** A stand-in pool that records what each connection was asked to do. */
function recordingPool(failOn?: string) {
  const log: string[] = [];
  let released = 0;
  const client = {
    async query(sql: string) {
      log.push(sql);
      if (failOn && sql.startsWith(failOn)) throw new Error(`refused: ${failOn}`);
      return { rows: [] };
    },
    release: () => void released++,
  };
  return { pool: { query: client.query, connect: async () => client }, log, released: () => released };
}

describe("fromPgPool", () => {
  it("wraps the work in begin and commit on one connection, then releases it", async () => {
    const { pool, log, released } = recordingPool();
    await fromPgPool(pool).transaction(async (tx) => tx.query("insert 1"));
    expect(log).toEqual(["begin", "insert 1", "commit"]);
    expect(released()).toBe(1);
  });

  it("rolls back and releases when the commit itself is refused", async () => {
    const { pool, log, released } = recordingPool("commit");
    await expect(fromPgPool(pool).transaction(async (tx) => tx.query("insert 1"))).rejects.toThrow("refused: commit");
    expect(log).toEqual(["begin", "insert 1", "commit", "rollback"]);
    expect(released()).toBe(1);
  });

  it("ships the schema with the package", () => {
    expect(SCHEMA).toContain("create table postings");
  });
});
