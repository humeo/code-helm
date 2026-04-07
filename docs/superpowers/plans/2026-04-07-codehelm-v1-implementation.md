# CodeHelm v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build CodeHelm v1 as a Bun + TypeScript application that binds Discord threads to local Codex App Server sessions, supports idle-session import, live transcript sync, and Discord approvals for the initiating user.

**Architecture:** Use one Bun process with clear internal modules instead of multiple services. The process owns four responsibilities: local config and SQLite persistence, Codex App Server JSON-RPC subscription, Discord bot control/thread handling, and a domain service that enforces CodeHelm product rules such as workdir binding, session ownership, and read-only degradation.

**Tech Stack:** Bun, TypeScript, `discord.js`, `zod`, `bun:sqlite`, native WebSocket/EventTarget APIs, `bun test`

---

## File Map

### Runtime and Config

- Create: `package.json`
- Create: `tsconfig.json`
- Create: `bunfig.toml`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/index.ts`
- Create: `src/config.ts`
- Create: `src/logger.ts`

### Persistence

- Create: `src/db/client.ts`
- Create: `src/db/migrate.ts`
- Create: `src/db/migrations/001_init.sql`
- Create: `src/db/repos/workspaces.ts`
- Create: `src/db/repos/workdirs.ts`
- Create: `src/db/repos/sessions.ts`
- Create: `src/db/repos/approvals.ts`

### Domain

- Create: `src/domain/types.ts`
- Create: `src/domain/session-service.ts`
- Create: `src/domain/approval-service.ts`
- Create: `src/domain/external-modification.ts`

### Codex Integration

- Create: `src/codex/jsonrpc-client.ts`
- Create: `src/codex/event-router.ts`
- Create: `src/codex/session-controller.ts`
- Create: `src/codex/protocol-types.ts`

### Discord Integration

- Create: `src/discord/bot.ts`
- Create: `src/discord/commands.ts`
- Create: `src/discord/thread-handler.ts`
- Create: `src/discord/approval-ui.ts`
- Create: `src/discord/renderers.ts`
- Create: `src/discord/permissions.ts`

### Tests

- Create: `tests/config.test.ts`
- Create: `tests/db/session-repo.test.ts`
- Create: `tests/codex/jsonrpc-client.test.ts`
- Create: `tests/domain/session-service.test.ts`
- Create: `tests/discord/permissions.test.ts`
- Create: `tests/discord/thread-handler.test.ts`
- Create: `tests/domain/approval-service.test.ts`

### Docs

- Create: `README.md`

## Task 1: Bootstrap Bun Project and Runtime Configuration

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `bunfig.toml`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `src/index.ts`
- Create: `src/config.ts`
- Create: `src/logger.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing config test**

```ts
import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config";

describe("parseConfig", () => {
  test("requires Discord, Codex, and database settings", () => {
    expect(() => parseConfig({})).toThrow("DISCORD_BOT_TOKEN");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/config.test.ts`
Expected: FAIL because `parseConfig` does not exist yet.

- [ ] **Step 3: Add project scaffold and minimal config loader**

```ts
import { z } from "zod";

const ConfigSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APP_ID: z.string().min(1),
  CODEX_APP_SERVER_URL: z.string().url(),
  DATABASE_PATH: z.string().min(1),
});

export const parseConfig = (env: Record<string, string | undefined>) =>
  ConfigSchema.parse(env);
```

Add Bun scripts:

```json
{
  "scripts": {
    "dev": "bun run src/index.ts",
    "test": "bun test",
    "migrate": "bun run src/db/migrate.ts"
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/config.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json bunfig.toml .gitignore .env.example src/index.ts src/config.ts src/logger.ts tests/config.test.ts
git commit -m "chore: bootstrap Bun runtime and config loader"
```

## Task 2: Add SQLite Schema and Repository Layer

**Files:**
- Create: `src/db/client.ts`
- Create: `src/db/migrate.ts`
- Create: `src/db/migrations/001_init.sql`
- Create: `src/db/repos/workspaces.ts`
- Create: `src/db/repos/workdirs.ts`
- Create: `src/db/repos/sessions.ts`
- Create: `src/db/repos/approvals.ts`
- Test: `tests/db/session-repo.test.ts`

- [ ] **Step 1: Write the failing repository test**

```ts
import { describe, expect, test } from "bun:test";
import { createSessionRepo } from "../src/db/repos/sessions";

test("stores Discord thread to Codex session binding", () => {
  const repo = createSessionRepo(":memory:");
  repo.insert({
    discordThreadId: "123",
    codexThreadId: "abc",
    ownerDiscordUserId: "u1",
    workdirId: "wd1",
    state: "idle",
  });
  expect(repo.getByDiscordThreadId("123")?.codexThreadId).toBe("abc");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/db/session-repo.test.ts`
Expected: FAIL because repository and schema do not exist.

- [ ] **Step 3: Create schema and minimal repositories**

Schema should include:

```sql
CREATE TABLE sessions (
  discord_thread_id TEXT PRIMARY KEY,
  codex_thread_id TEXT NOT NULL UNIQUE,
  owner_discord_user_id TEXT NOT NULL,
  workdir_id TEXT NOT NULL,
  state TEXT NOT NULL,
  degradation_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Also create:

- `workspaces`
- `workdirs`
- `approvals`

Use `bun:sqlite` and keep repo methods narrow:

- `insert`
- `getByDiscordThreadId`
- `getByCodexThreadId`
- `updateState`
- `markExternallyModified`

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/db/session-repo.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/db tests/db/session-repo.test.ts
git commit -m "feat: add persistent session registry"
```

## Task 3: Implement Codex App Server JSON-RPC Client

**Files:**
- Create: `src/codex/protocol-types.ts`
- Create: `src/codex/jsonrpc-client.ts`
- Create: `src/codex/event-router.ts`
- Create: `src/codex/session-controller.ts`
- Test: `tests/codex/jsonrpc-client.test.ts`

- [ ] **Step 1: Write the failing JSON-RPC test**

```ts
import { describe, expect, test } from "bun:test";
import { JsonRpcClient } from "../src/codex/jsonrpc-client";

test("routes requestApproval and resolved events to subscribers", async () => {
  const client = new JsonRpcClient("ws://example.test");
  client.handleMessage({
    method: "item/commandExecution/requestApproval",
    id: 7,
    params: { threadId: "t1", turnId: "turn1", itemId: "call1" },
  });
  expect(client.lastApprovalRequest?.requestId).toBe(7);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/codex/jsonrpc-client.test.ts`
Expected: FAIL because client does not exist.

- [ ] **Step 3: Implement minimal JSON-RPC client and session controller**

Core methods:

```ts
await client.initialize();
await client.startThread({ cwd });
await client.resumeThread({ threadId });
await client.startTurn({ threadId, input, approvalPolicy, sandboxPolicy });
await client.replyToServerRequest({ requestId, decision });
```

Expose event routing for:

- `turn/started`
- `turn/completed`
- `thread/status/changed`
- `item/started`
- `item/completed`
- `item/commandExecution/requestApproval`
- `serverRequest/resolved`

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/codex/jsonrpc-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/codex tests/codex/jsonrpc-client.test.ts
git commit -m "feat: add Codex App Server client"
```

## Task 4: Build Domain Services for Session Rules

**Files:**
- Create: `src/domain/types.ts`
- Create: `src/domain/session-service.ts`
- Create: `src/domain/approval-service.ts`
- Create: `src/domain/external-modification.ts`
- Test: `tests/domain/session-service.test.ts`
- Test: `tests/domain/approval-service.test.ts`

- [ ] **Step 1: Write the failing domain tests**

```ts
import { expect, test } from "bun:test";
import { canImportSession } from "../src/domain/session-service";

test("only idle sessions are importable", () => {
  expect(canImportSession({ runtimeState: "idle" })).toBe(true);
  expect(canImportSession({ runtimeState: "running" })).toBe(false);
});
```

```ts
import { expect, test } from "bun:test";
import { shouldShowApprovalControls } from "../src/domain/approval-service";

test("only owner sees approval controls in Discord", () => {
  expect(shouldShowApprovalControls({ viewerId: "u1", ownerId: "u1" })).toBe(true);
  expect(shouldShowApprovalControls({ viewerId: "u2", ownerId: "u1" })).toBe(false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/domain/session-service.test.ts tests/domain/approval-service.test.ts`
Expected: FAIL because domain services do not exist.

- [ ] **Step 3: Implement CodeHelm rule layer**

Implement:

- idle-only import validation
- immutable workdir validation
- Discord owner-only operations
- unsupported external modification detection
- Discord read-only degradation decision

Keep these pure where possible so they remain easy to test.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/domain/session-service.test.ts tests/domain/approval-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain tests/domain/session-service.test.ts tests/domain/approval-service.test.ts
git commit -m "feat: add session and approval domain rules"
```

## Task 5: Add Discord Control Channel Commands

**Files:**
- Create: `src/discord/bot.ts`
- Create: `src/discord/commands.ts`
- Create: `src/discord/permissions.ts`
- Test: `tests/discord/permissions.test.ts`

- [ ] **Step 1: Write the failing permissions test**

```ts
import { expect, test } from "bun:test";
import { canControlSession } from "../src/discord/permissions";

test("only thread owner can control the session", () => {
  expect(canControlSession({ actorId: "u1", ownerId: "u1" })).toBe(true);
  expect(canControlSession({ actorId: "u2", ownerId: "u1" })).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/discord/permissions.test.ts`
Expected: FAIL because permissions helpers do not exist.

- [ ] **Step 3: Implement control-channel command surface**

Support at minimum:

- `/workdir-list`
- `/session-new`
- `/session-import`
- `/session-list`

Set up Discord intents and behavior required for v1:

- guilds
- guild messages
- guild message reactions if needed later
- message content intent, because thread messages from the owner must become Codex user messages

The command handler should call domain services, not directly implement business rules.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/discord/permissions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/discord/bot.ts src/discord/commands.ts src/discord/permissions.ts tests/discord/permissions.test.ts
git commit -m "feat: add Discord control channel commands"
```

## Task 6: Bridge Session Threads to Codex Turns

**Files:**
- Create: `src/discord/thread-handler.ts`
- Create: `src/discord/renderers.ts`
- Test: `tests/discord/thread-handler.test.ts`

- [ ] **Step 1: Write the failing thread bridge test**

```ts
import { expect, test } from "bun:test";
import { normalizeOwnerThreadMessage } from "../src/discord/thread-handler";

test("owner thread message becomes Codex input", () => {
  const result = normalizeOwnerThreadMessage({
    authorId: "u1",
    ownerId: "u1",
    content: "fix the failing test",
  });
  expect(result).toEqual([{ type: "text", text: "fix the failing test" }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/discord/thread-handler.test.ts`
Expected: FAIL because thread handler does not exist.

- [ ] **Step 3: Implement thread bridge**

Rules:

- only owner messages advance the session
- non-owner messages are ignored or acknowledged as read-only
- one running turn at a time
- thread output is rendered from Codex events, not reconstructed from local guesses

Renderer responsibilities:

- session started message
- running status updates
- tool progress summaries
- final answer messages
- degradation banner when session becomes read-only

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/discord/thread-handler.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/discord/thread-handler.ts src/discord/renderers.ts tests/discord/thread-handler.test.ts
git commit -m "feat: bridge Discord threads to Codex turns"
```

## Task 7: Implement Approval Tracking and UI Resolution

**Files:**
- Modify: `src/domain/approval-service.ts`
- Modify: `src/db/repos/approvals.ts`
- Create: `src/discord/approval-ui.ts`
- Test: `tests/domain/approval-service.test.ts`

- [ ] **Step 1: Extend the failing approval test**

```ts
import { expect, test } from "bun:test";
import { reduceApprovalEvent } from "../src/domain/approval-service";

test("serverRequest/resolved closes pending approval", () => {
  const pending = reduceApprovalEvent(undefined, {
    type: "requestApproval",
    requestId: 9,
    ownerId: "u1",
  });
  const resolved = reduceApprovalEvent(pending, {
    type: "resolved",
    requestId: 9,
  });
  expect(resolved.status).toBe("resolved");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/domain/approval-service.test.ts`
Expected: FAIL because the reducer does not yet handle resolution.

- [ ] **Step 3: Implement approval state tracking**

Track by `requestId`:

- pending
- resolved
- approved
- declined
- canceled

Discord behavior:

- owner gets buttons
- non-owner gets status-only rendering
- on `serverRequest/resolved`, close the active Discord approval UI immediately

Do not attempt to force-close native Codex TUI approval screens.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/domain/approval-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/domain/approval-service.ts src/db/repos/approvals.ts src/discord/approval-ui.ts tests/domain/approval-service.test.ts
git commit -m "feat: add approval tracking and Discord resolution"
```

## Task 8: Compose App, Run End-to-End Smoke Tests, and Document Operation

**Files:**
- Modify: `src/index.ts`
- Create: `README.md`

- [ ] **Step 1: Write a minimal startup smoke test plan in README**

Document:

- required Discord app settings
- required privileged intent
- required local Codex App Server settings
- how to configure workdirs
- how to run the daemon
- how to attach local `codex --remote`

- [ ] **Step 2: Compose the production entrypoint**

`src/index.ts` should:

- load config
- run migrations
- create repositories
- connect to Codex App Server
- connect Discord bot
- register command handlers
- register Codex event subscriptions
- start clean shutdown hooks

- [ ] **Step 3: Run focused tests**

Run: `bun test`
Expected: PASS

- [ ] **Step 4: Run manual smoke flow**

Run:

```bash
bun install
bun run src/index.ts
```

Manual checklist:

1. Control channel lists configured workdirs.
2. Creating a session creates a Discord thread.
3. Owner message in thread starts a Codex turn.
4. Live output appears in Discord.
5. Approval appears only with actionable controls for the owner.
6. Resolving approval closes the Discord approval UI.
7. Import rejects a running session.
8. Import accepts an idle session.
9. Local `codex resume --remote ...` sees the same transcript as Discord.
10. Unsupported external modification degrades the thread to read-only.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts README.md
git commit -m "feat: wire CodeHelm v1 application"
```

## Notes for Execution

- Keep the app as one Bun process in v1.
- Do not add extra services, queues, or provider abstractions.
- Keep Codex integration isolated behind `src/codex/*` so later provider expansion remains possible.
- Treat the SQLite registry as the product control ledger and Codex App Server as runtime truth.
- When a requirement conflicts with native Codex client behavior, prefer surfacing the native limitation over inventing unsupported coordination.
