import { Database } from "bun:sqlite";

export type WorkspaceRecord = {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
};

export type InsertWorkspaceInput = {
  id: string;
  name: string;
  rootPath: string;
};

type WorkspaceRow = {
  id: string;
  name: string;
  root_path: string;
  created_at: string;
  updated_at: string;
};

const mapWorkspace = (row: WorkspaceRow | null): WorkspaceRecord | null => {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const now = () => new Date().toISOString();

export const createWorkspaceRepo = (db: Database) => {
  const insertStatement = db.prepare(
    `INSERT INTO workspaces (id, name, root_path, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`,
  );
  const getByIdStatement = db.prepare("SELECT * FROM workspaces WHERE id = ?");

  return {
    insert(input: InsertWorkspaceInput) {
      const timestamp = now();
      insertStatement.run(
        input.id,
        input.name,
        input.rootPath,
        timestamp,
        timestamp,
      );
    },
    getById(id: string) {
      return mapWorkspace(getByIdStatement.get(id) as WorkspaceRow | null);
    },
  };
};
