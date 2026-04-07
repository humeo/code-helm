import { parseConfig } from "../config";
import { createDatabaseClient } from "./client";

export { applyMigrations } from "./client";

if (import.meta.main) {
  const { DATABASE_PATH } = parseConfig(Bun.env);
  const db = createDatabaseClient(DATABASE_PATH);

  db.close();
  console.log(`Applied migrations to ${DATABASE_PATH}`);
}
