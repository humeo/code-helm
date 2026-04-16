import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const isSpecialDatabaseTarget = (target: string) => {
  return target === ":memory:" || target.startsWith("file:");
};

export const createDatabaseClient = (target: string) => {
  if (!isSpecialDatabaseTarget(target)) {
    mkdirSync(dirname(target), { recursive: true });
  }

  const db = new Database(target);

  db.exec("PRAGMA foreign_keys = ON;");

  return db;
};
