import { Database } from "bun:sqlite";

export type WorkdirRecord = {
  id: string;
  workspaceId: string;
  label: string;
  absolutePath: string;
  createdAt: string;
  updatedAt: string;
};

export type InsertWorkdirInput = {
  id: string;
  workspaceId: string;
  label: string;
  absolutePath: string;
};

type WorkdirRow = {
  id: string;
  workspace_id: string;
  label: string;
  absolute_path: string;
  created_at: string;
  updated_at: string;
};

const mapWorkdir = (row: WorkdirRow | null): WorkdirRecord | null => {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    workspaceId: row.workspace_id,
    label: row.label,
    absolutePath: row.absolute_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

const now = () => new Date().toISOString();

export const createWorkdirRepo = (db: Database) => {
  const insertStatement = db.prepare(
    `INSERT INTO workdirs (
      id,
      workspace_id,
      label,
      absolute_path,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const getByIdStatement = db.prepare("SELECT * FROM workdirs WHERE id = ?");

  return {
    insert(input: InsertWorkdirInput) {
      const timestamp = now();
      insertStatement.run(
        input.id,
        input.workspaceId,
        input.label,
        input.absolutePath,
        timestamp,
        timestamp,
      );
    },
    getById(id: string) {
      return mapWorkdir(getByIdStatement.get(id) as WorkdirRow | null);
    },
  };
};
