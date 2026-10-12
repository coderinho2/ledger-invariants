import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";

const SCHEMA = readFileSync(new URL("../sql/schema.sql", import.meta.url), "utf8");

/** A fresh in-memory Postgres (PGlite) with the ledger schema loaded. */
export async function freshDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  return db;
}
