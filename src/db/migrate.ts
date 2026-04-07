import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { parseConfig } from "../config";
import { createDatabaseClient } from "./client";

const initMigration = readFileSync(
  new URL("./migrations/001_init.sql", import.meta.url),
  "utf8",
);

export const applyMigrations = (db: Database) => {
  db.exec(initMigration);
};

if (import.meta.main) {
  const { DATABASE_PATH } = parseConfig(Bun.env);
  const db = createDatabaseClient(DATABASE_PATH);

  applyMigrations(db);
  db.close();
  console.log(`Applied migrations to ${DATABASE_PATH}`);
}
