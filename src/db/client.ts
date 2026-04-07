import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";

const initMigration = readFileSync(
  new URL("./migrations/001_init.sql", import.meta.url),
  "utf8",
);

export type DatabaseTarget = Database | string;

export const applyMigrations = (db: Database) => {
  db.exec(initMigration);
};

export const createDatabaseClient = (target: DatabaseTarget) => {
  const db = typeof target === "string" ? new Database(target) : target;

  db.exec("PRAGMA foreign_keys = ON;");
  applyMigrations(db);

  return db;
};
