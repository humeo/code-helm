# Workspace Legacy Cleanup

Status: Deferred legacy cleanup item. Do not implement as part of the current flow.

## Summary

`WORKSPACE_ID`, `WORKSPACE_NAME`, the `workspaces` table, and the `workdirs` table appear to be leftovers from an older workspace-centric design.

The current product flow is workdir-first and session-first:

- current workdir is stored in `current_workdirs.cwd`
- sessions persist their own `cwd`
- Discord commands operate on the stored current workdir plus live Codex thread data

That means workspace metadata is no longer part of the normal user path.

## What Still Uses Workspace Metadata

As of the current codebase, `WORKSPACE_ID` and `WORKSPACE_NAME` are still used in two places:

1. Config parsing
   - `src/config.ts` still requires both fields.
2. Legacy bootstrap seeding
   - `seedLegacyWorkspaceBootstrap(...)` in `src/index.ts` inserts rows into `workspaces` and `workdirs` when `WORKSPACE_ROOT` and `WORKDIRS_JSON` are provided.

The `workspaces` repo is only used by that legacy bootstrap path and by tests covering the old schema.

## Evidence

- `src/config.ts`
  - requires `WORKSPACE_ID`
  - requires `WORKSPACE_NAME`
- `src/index.ts`
  - `seedLegacyWorkspaceBootstrap(...)` inserts `config.workspace.id` and `config.workspace.name`
- `src/db/migrations/001_init.sql`
  - still creates `workspaces` and `workdirs`
- `sessions` and `current_workdirs`
  - both persist `cwd` directly
  - current session flow does not need workspace name metadata

## Conclusion

`WORKSPACE_NAME` is not part of the current main runtime behavior. It is effectively a legacy compatibility field that survived the shift from workspace-based entry to workdir-based entry.

This likely means the old workspace design was not fully cleaned up.

## Deferred Cleanup Scope

When this legacy cleanup is scheduled, evaluate the following as one grouped change instead of removing only a single field:

1. Remove `WORKSPACE_ID` and `WORKSPACE_NAME` from user-facing configuration.
2. Remove or retire `WORKSPACE_ROOT` and `WORKDIRS_JSON`.
3. Delete `seedLegacyWorkspaceBootstrap(...)`.
4. Stop writing to `workspaces` and `workdirs`.
5. Decide whether the legacy tables stay temporarily for migration compatibility or can be removed outright.
6. Update tests, any legacy env-override documentation, onboarding, and README to reflect the simplified model.

## Non-Goal For Now

Do not change runtime behavior as part of the current work. This document is only a backlog/cleanup note so the legacy workspace layer is not mistaken for an active product requirement.
