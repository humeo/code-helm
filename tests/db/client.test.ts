import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseClient } from "../../src/db/client";

const tempDirs: string[] = [];

const createTempDir = () => {
  const directory = mkdtempSync(join(tmpdir(), "codehelm-db-client-"));
  tempDirs.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("createDatabaseClient creates missing parent directories for file-backed databases", () => {
  const root = createTempDir();
  const databaseDir = join(root, "nested", "data");
  const databasePath = join(databaseDir, "codehelm.sqlite");

  expect(existsSync(databaseDir)).toBe(false);

  const db = createDatabaseClient(databasePath);

  db.exec("CREATE TABLE smoke_test (id INTEGER PRIMARY KEY);");
  db.close();

  expect(existsSync(databaseDir)).toBe(true);
  expect(existsSync(databasePath)).toBe(true);
});
