import { Database } from "bun:sqlite";
export const createDatabaseClient = (target: string) => {
  const db = new Database(target);

  db.exec("PRAGMA foreign_keys = ON;");

  return db;
};
