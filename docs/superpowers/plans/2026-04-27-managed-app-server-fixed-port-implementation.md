# Managed App Server Fixed Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CodeHelm's managed Codex App Server use `ws://127.0.0.1:4200` by default while supporting `code-helm start --port <port>` with clear foreground and daemon failure reporting.

**Architecture:** Replace ephemeral port allocation with a shared managed-address helper and thread the selected port from CLI parsing into foreground and daemon startup. For daemon startup failures, add a file-backed `startup-error.json` handoff alongside the existing `runtime.json` success handoff so the parent process can report managed app-server failures without waiting for a generic timeout.

**Tech Stack:** Bun, TypeScript, `bun:test`, Node child process APIs, file-backed JSON runtime state.

---

## Source Spec

- Spec: `docs/superpowers/specs/2026-04-27-managed-app-server-fixed-port-design.md`
- Current design commit: `08d6505 docs: specify fixed managed app server port`

## File Structure

- Modify `src/cli/args.ts`: parse `start --port <port>` and preserve existing `--daemon` behavior.
- Modify `tests/cli/args.test.ts`: cover valid and invalid start-port argument shapes.
- Modify `src/codex/supervisor.ts`: add the default port/address helpers and use a fixed port unless an explicit port is supplied.
- Modify `tests/codex/supervisor.test.ts`: cover default `4200`, custom port, and updated spawn args.
- Modify `src/cli/onboard.ts`: show `4200` instead of `<auto>`.
- Modify `tests/cli/onboard.test.ts`: update onboarding review expectations.
- Modify `src/cli/commands.ts`: thread the selected port through foreground/background startup, reject `--port` with external `CODE_HELM_CODEX_APP_SERVER_URL`, poll `startup-error.json`, and render port-aware startup failures.
- Modify `tests/cli/commands.test.ts`: cover port propagation, external URL rejection, daemon env handoff, daemon startup-error handling, and help output.
- Modify `src/cli/runtime-state.ts`: add typed `startup-error.json` read/write/clear helpers.
- Modify `tests/cli/runtime-state.test.ts`: cover startup-error lifecycle and stale cleanup helpers.
- Modify `src/index.ts`: accept the selected managed app-server port, pass it to the supervisor, and write `startup-error.json` for background managed-startup failures.
- Modify `tests/index.test.ts`: cover `startCodeHelm` port forwarding and background failure handoff ordering.
- Modify `README.md` and `README.zh-CN.md`: document the default port and `--port`.

## Implementation Notes

- Keep `CODE_HELM_CODEX_APP_SERVER_URL` behavior intact. If it is set, CodeHelm uses an external app-server URL and must reject `--port`.
- Do not add persistent port configuration to `config.toml`.
- Do not change macOS autostart. `code-helm start --daemon` should keep using default `4200`.
- Do not add random fallback. Port conflicts are explicit startup failures.
- Preserve the current Bun workflow: use `bun test` and `bun run typecheck`.

---

### Task 1: Parse `start --port`

**Files:**
- Modify: `src/cli/args.ts`
- Modify: `tests/cli/args.test.ts`

- [ ] **Step 1: Add failing parser tests**

Add expectations to `tests/cli/args.test.ts`:

```ts
expect(parseCliArgs(["start"])).toEqual({
  kind: "start",
  daemon: false,
});
expect(parseCliArgs(["start", "--daemon"])).toEqual({
  kind: "start",
  daemon: true,
});
expect(parseCliArgs(["start", "--port", "4201"])).toEqual({
  kind: "start",
  daemon: false,
  port: 4201,
});
expect(parseCliArgs(["start", "--daemon", "--port", "4201"])).toEqual({
  kind: "start",
  daemon: true,
  port: 4201,
});
expect(parseCliArgs(["start", "--port", "4201", "--daemon"])).toEqual({
  kind: "start",
  daemon: true,
  port: 4201,
});
```

Add invalid cases:

```ts
expect(() => parseCliArgs(["start", "--port"])).toThrow(/Missing value for --port/);
expect(() => parseCliArgs(["start", "--port", "abc"])).toThrow(/Invalid value for --port/);
expect(() => parseCliArgs(["start", "--port", "0"])).toThrow(/Invalid value for --port/);
expect(() => parseCliArgs(["start", "--port", "65536"])).toThrow(/Invalid value for --port/);
expect(() => parseCliArgs(["start", "--port", "4201", "--port", "4202"])).toThrow(/Duplicate --port/);
```

- [ ] **Step 2: Run parser tests and verify failure**

Run:

```bash
bun test tests/cli/args.test.ts
```

Expected: FAIL because `CliCommand` has no `port` field and `start --port` is rejected.

- [ ] **Step 3: Implement parser support**

Update `src/cli/args.ts`:

```ts
export type CliCommand =
  | { kind: "help" }
  | { kind: "onboard" }
  | { kind: "start"; daemon: boolean; port?: number }
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "version" }
  | { kind: "check"; yes: boolean }
  | { kind: "update" }
  | { kind: "autostart"; action: "enable" | "disable" }
  | { kind: "uninstall" };
```

Add focused helpers:

```ts
const parsePortValue = (value: string | undefined): number => {
  if (value === undefined) {
    failUsage("Missing value for --port");
  }

  if (!/^\d+$/.test(value)) {
    failUsage(`Invalid value for --port: ${value}`);
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    failUsage(`Invalid value for --port: ${value}`);
  }

  return port;
};

const parseStartArgs = (rest: string[]): CliCommand => {
  let daemon = false;
  let port: number | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (token === "--daemon") {
      daemon = true;
      continue;
    }

    if (token === "--port") {
      if (port !== undefined) {
        failUsage("Duplicate --port for start");
      }

      port = parsePortValue(rest[index + 1]);
      index += 1;
      continue;
    }

    failUsage(`Unknown arguments for start: ${rest.join(" ")}`);
  }

  return port === undefined
    ? { kind: "start", daemon }
    : { kind: "start", daemon, port };
};
```

Use it in the `start` branch:

```ts
case "start":
  return parseStartArgs(rest);
```

- [ ] **Step 4: Run parser tests and verify pass**

Run:

```bash
bun test tests/cli/args.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit parser task**

```bash
git add src/cli/args.ts tests/cli/args.test.ts
git commit -m "feat(cli): parse managed app server port"
```

---

### Task 2: Fix Managed App Server Address Selection

**Files:**
- Modify: `src/codex/supervisor.ts`
- Modify: `tests/codex/supervisor.test.ts`

- [ ] **Step 1: Add failing supervisor tests**

In `tests/codex/supervisor.test.ts`, update the existing command test to remove `allocatePort` and expect `4200`:

```ts
const server = await startManagedCodexAppServer({
  cwd: "/tmp/codehelm-app-server-workdir",
  resolveBinary: async () => "/usr/local/bin/codex",
  spawnProcess: (command, args, options) => {
    spawnCall = {
      command,
      args,
      stdio: options.stdio as string[],
      cwd: options.cwd as string | undefined,
    };
    return child;
  },
  waitForReady: async ({ address }) => {
    readyChecked = true;
    expect(address).toBe("ws://127.0.0.1:4200");
  },
});

expect(spawnCall?.args).toEqual([
  "app-server",
  "--listen",
  "ws://127.0.0.1:4200",
]);
expect(server.address).toBe("ws://127.0.0.1:4200");
```

Add a custom port test:

```ts
test("startManagedCodexAppServer uses a requested managed port", async () => {
  const child = new ChildProcessStub(4242);
  let spawnArgs: string[] | undefined;

  const server = await startManagedCodexAppServer({
    port: 4201,
    resolveBinary: async () => "/usr/local/bin/codex",
    spawnProcess: (_command, args) => {
      spawnArgs = args;
      return child;
    },
    waitForReady: async ({ address }) => {
      expect(address).toBe("ws://127.0.0.1:4201");
    },
  });

  expect(spawnArgs).toEqual(["app-server", "--listen", "ws://127.0.0.1:4201"]);
  expect(server.address).toBe("ws://127.0.0.1:4201");
});
```

Add helper tests:

```ts
expect(DEFAULT_MANAGED_CODEX_APP_SERVER_PORT).toBe(4200);
expect(formatManagedCodexAppServerAddress(4200)).toBe("ws://127.0.0.1:4200");
```

- [ ] **Step 2: Run supervisor tests and verify failure**

Run:

```bash
bun test tests/codex/supervisor.test.ts
```

Expected: FAIL because default startup still calls `allocatePort()`.

- [ ] **Step 3: Implement fixed-address helpers**

In `src/codex/supervisor.ts`, add:

```ts
export const DEFAULT_MANAGED_CODEX_APP_SERVER_PORT = 4200;

export const formatManagedCodexAppServerAddress = (port: number) => {
  return `ws://127.0.0.1:${port}`;
};
```

Update `StartManagedCodexAppServerOptions`:

```ts
export type StartManagedCodexAppServerOptions = {
  cwd?: string;
  port?: number;
  resolveBinary?: ResolveBinary;
  spawnProcess?: SpawnProcess;
  waitForReady?: WaitForReady;
};
```

Remove `AllocatePort`, `defaultAllocatePort`, and the `allocatePort` option unless another compile error proves a remaining test seam still needs it. In `startManagedCodexAppServer`, replace the old allocation:

```ts
const port = options.port ?? DEFAULT_MANAGED_CODEX_APP_SERVER_PORT;
const address = formatManagedCodexAppServerAddress(port);
```

Update structured managed app-server startup logs to include both fields:

```ts
log.info("Starting managed Codex App Server", {
  appServerAddress: address,
  appServerPort: port,
  cwd: options.cwd,
});
```

Do the same for readiness failure and ready logs where `appServerAddress` is already recorded.

- [ ] **Step 4: Update tests that still pass `allocatePort`**

Search:

```bash
rg -n "allocatePort" tests src
```

Remove `allocatePort` overrides from supervisor tests and use `port` only where the test needs a non-default address.

- [ ] **Step 5: Run supervisor tests and typecheck the touched module**

Run:

```bash
bun test tests/codex/supervisor.test.ts
bun run typecheck
```

Expected: supervisor tests PASS; typecheck PASS.

- [ ] **Step 6: Commit supervisor task**

```bash
git add src/codex/supervisor.ts tests/codex/supervisor.test.ts
git commit -m "feat(codex): use fixed managed app server port"
```

---

### Task 3: Update Onboarding, Help, And User Docs

**Files:**
- Modify: `src/cli/onboard.ts`
- Modify: `src/cli/commands.ts`
- Modify: `tests/cli/onboard.test.ts`
- Modify: `tests/cli/commands.test.ts`
- Modify: `README.md`
- Modify: `README.zh-CN.md`

- [ ] **Step 1: Add failing onboarding/help tests**

In `tests/cli/onboard.test.ts`, update the review summary expectations:

```ts
expect(lines[4]).toMatch(/^Codex App Server\s+managed \(loopback, default port 4200\)$/);
expect(lines[5]).toMatch(/^Codex address\s+ws:\/\/127\.0\.0\.1:4200$/);
expect(lines[6]).toMatch(/^Codex connect\s+codex --remote ws:\/\/127\.0\.0\.1:4200 -C "\$\(pwd\)"$/);
```

In `tests/cli/commands.test.ts`, update the help-output test to expect:

```ts
expect(result.output).toContain("start --port <port>");
expect(result.output).toContain("Start CodeHelm on a custom managed app-server port");
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
bun test tests/cli/onboard.test.ts tests/cli/commands.test.ts
```

Expected: FAIL because onboarding still shows `<auto>` and help does not list `--port`.

- [ ] **Step 3: Implement onboarding constants**

In `src/cli/onboard.ts`, import the shared helpers:

```ts
import {
  DEFAULT_MANAGED_CODEX_APP_SERVER_PORT,
  formatManagedCodexAppServerAddress,
} from "../codex/supervisor";
```

Replace:

```ts
const MANAGED_CODEX_APP_SERVER_ADDRESS = "ws://127.0.0.1:<auto>";
```

with:

```ts
const MANAGED_CODEX_APP_SERVER_ADDRESS = formatManagedCodexAppServerAddress(
  DEFAULT_MANAGED_CODEX_APP_SERVER_PORT,
);
```

Update the summary row:

```ts
{
  key: "Codex App Server",
  value: `managed (loopback, default port ${DEFAULT_MANAGED_CODEX_APP_SERVER_PORT})`,
}
```

- [ ] **Step 4: Update help output**

In `src/cli/commands.ts`, add a runtime command entry:

```ts
{
  command: "start --port <port>",
  description: "Start CodeHelm on a custom managed app-server port",
}
```

Keep `start` and `start --daemon` in place.

- [ ] **Step 5: Update README docs**

In `README.md`, add text like:

```text
By default, CodeHelm starts the managed Codex App Server at ws://127.0.0.1:4200.

If that port is already in use, choose another port for this run:

code-helm start --port 4201
code-helm start --daemon --port 4201
```

Mirror the same meaning in `README.zh-CN.md`.

- [ ] **Step 6: Run focused tests**

Run:

```bash
bun test tests/cli/onboard.test.ts tests/cli/commands.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit docs/UI task**

```bash
git add src/cli/onboard.ts src/cli/commands.ts tests/cli/onboard.test.ts tests/cli/commands.test.ts README.md README.zh-CN.md
git commit -m "docs(cli): show managed app server port"
```

---

### Task 4: Thread Port Through Foreground Startup

**Files:**
- Modify: `src/cli/commands.ts`
- Modify: `src/index.ts`
- Modify: `tests/cli/commands.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Add failing foreground tests**

In `tests/cli/commands.test.ts`, add:

```ts
test("start forwards --port to foreground startup", async () => {
  const services = createBaseServices();
  let receivedPort: number | undefined;

  services.startForeground = async (options) => {
    receivedPort = options.managedAppServerPort;
    return {
      config: createConfig("ws://127.0.0.1:4201"),
      stop: async () => {},
    };
  };

  const result = await runCliCommand(
    { kind: "start", daemon: false, port: 4201 },
    services,
  );

  expect(receivedPort).toBe(4201);
  expect(result.output).toContain("ws://127.0.0.1:4201");
});
```

Add external URL rejection:

```ts
test("start rejects --port when an external app-server URL is configured", async () => {
  const services = createBaseServices();
  services.env = {
    CODE_HELM_CODEX_APP_SERVER_URL: "ws://127.0.0.1:4999",
  };

  await expect(
    runCliCommand({ kind: "start", daemon: false, port: 4201 }, services),
  ).rejects.toThrow(/--port.*CODE_HELM_CODEX_APP_SERVER_URL/i);
});
```

In `tests/index.test.ts`, add or update a `startCodeHelm` test:

```ts
test("startCodeHelm forwards the requested managed app-server port", async () => {
  let receivedPort: number | undefined;

  const handle = await startCodeHelm({
    ...createAppConfig(),
    codex: {
      appServerUrl: DEFAULT_CODEX_APP_SERVER_URL,
    },
  }, {
    installSignalHandlers: false,
    managedAppServerPort: 4201,
    startManagedCodexAppServer: async (options = {}) => {
      receivedPort = options.port;
      return {
        pid: 999,
        address: "ws://127.0.0.1:4201",
        stop: async () => {},
      };
    },
    startRuntime: async (config) => ({
      config,
      stop: async () => {},
    }),
  });

  await handle.stop();
  expect(receivedPort).toBe(4201);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
bun test tests/cli/commands.test.ts tests/index.test.ts
```

Expected: FAIL because the command and runtime option types do not carry `managedAppServerPort`.

- [ ] **Step 3: Extend command service types and foreground startup**

In `src/cli/commands.ts`, extend `CommandServices["startForeground"]`:

```ts
startForeground: (options: {
  config: AppConfig;
  legacyWorkspaceBootstrap: ReturnType<typeof resolveLegacyWorkspaceBootstrap>;
  managedAppServerPort?: number;
  stateDir: string;
}) => Promise<StartHandle>;
```

Pass it in `defaultStartForeground`:

```ts
const defaultStartForeground: CommandServices["startForeground"] = ({
  config,
  legacyWorkspaceBootstrap,
  managedAppServerPort,
  stateDir,
}) => {
  // Keep the existing logger setup and stop/shutdown wrapper.
return startCodeHelm(config, {
  legacyWorkspaceBootstrap,
  managedAppServerPort,
  mode: "foreground",
  stateDir,
});
};
```

In the `start` foreground branch, pass:

```ts
managedAppServerPort: command.port,
```

- [ ] **Step 4: Reject `--port` with explicit external app-server URL**

After `ensureConfiguredStore(services)` and before foreground/background startup, add:

```ts
if (command.port !== undefined && services.env.CODE_HELM_CODEX_APP_SERVER_URL) {
  throw new Error(
    "--port only applies to CodeHelm's managed Codex App Server. Remove CODE_HELM_CODEX_APP_SERVER_URL or omit --port.",
  );
}
```

This is intentionally keyed to the explicit env override from the spec.

- [ ] **Step 5: Extend `startCodeHelm` options**

In `src/index.ts`, add `managedAppServerPort?: number` to `StartCodeHelmOptions`.

When starting the managed server, pass:

```ts
managedCodexAppServer = await startManagedServer({
  cwd: managedAppServerCwd,
  port: options.managedAppServerPort,
});
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
bun test tests/cli/commands.test.ts tests/index.test.ts
```

Expected: PASS for new foreground-port tests.

- [ ] **Step 7: Commit foreground task**

```bash
git add src/cli/commands.ts src/index.ts tests/cli/commands.test.ts tests/index.test.ts
git commit -m "feat(runtime): pass managed app server port to foreground"
```

---

### Task 5: Pass Port Into Background Daemon

**Files:**
- Modify: `src/cli/commands.ts`
- Modify: `src/index.ts`
- Modify: `tests/cli/commands.test.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Add failing background handoff tests**

In `tests/cli/commands.test.ts`, update the existing background start test or add a focused one:

```ts
test("start --daemon passes --port through the daemon environment", async () => {
  const services = createBaseServices();
  let spawnedEnv: Record<string, string | undefined> | undefined;

  services.spawnBackgroundProcess = ({ env }) => {
    spawnedEnv = env;
    return {
      pid: 4321,
      unref() {},
    };
  };

  await runCliCommand({ kind: "start", daemon: true, port: 4201 }, services);

  expect(spawnedEnv?.CODE_HELM_MANAGED_APP_SERVER_PORT).toBe("4201");
});
```

Add a stale-env guard test:

```ts
test("start --daemon clears inherited managed port env when --port is omitted", async () => {
  const services = createBaseServices();
  let spawnedEnv: Record<string, string | undefined> | undefined;

  services.env = {
    CODE_HELM_MANAGED_APP_SERVER_PORT: "4201",
  };
  services.spawnBackgroundProcess = ({ env }) => {
    spawnedEnv = env;
    return {
      pid: 4321,
      unref() {},
    };
  };

  await runCliCommand({ kind: "start", daemon: true }, services);

  expect(spawnedEnv?.CODE_HELM_MANAGED_APP_SERVER_PORT).toBeUndefined();
});
```

If practical, add the same stale-env assertion with `process.env.CODE_HELM_MANAGED_APP_SERVER_PORT` temporarily set and restored in `finally`, because the production env construction spreads both `process.env` and `services.env`.

In `tests/index.test.ts`, add tests for env parsing by exporting a small helper from `src/index.ts`:

```ts
test("resolveManagedAppServerPortFromEnv reads a daemon port override", () => {
  expect(resolveManagedAppServerPortFromEnv({
    CODE_HELM_MANAGED_APP_SERVER_PORT: "4201",
  })).toBe(4201);
});

test("resolveManagedAppServerPortFromEnv rejects invalid daemon port overrides", () => {
  expect(() =>
    resolveManagedAppServerPortFromEnv({
      CODE_HELM_MANAGED_APP_SERVER_PORT: "abc",
    }),
  ).toThrow(/CODE_HELM_MANAGED_APP_SERVER_PORT/);
});
```

Add one integration-style assertion for the process entrypoint:

```ts
test("loadAndStartCodeHelmFromProcess passes daemon port env to startCodeHelm", async () => {
  let receivedPort: number | undefined;

  const handle = await loadAndStartCodeHelmFromProcess({
    CODE_HELM_DAEMON_MODE: "background",
    CODE_HELM_MANAGED_APP_SERVER_PORT: "4201",
    CODE_HELM_CONFIG: "/tmp/config.toml",
    CODE_HELM_SECRETS: "/tmp/secrets.toml",
  }, {
    parseConfig: () => createAppConfig(),
    startCodeHelm: async (_config, options) => {
      receivedPort = options.managedAppServerPort;
      return {
        config: createAppConfig(),
        stop: async () => {},
      };
    },
  });

  await handle.stop();
  expect(receivedPort).toBe(4201);
});
```

If `loadAndStartCodeHelmFromProcess` does not currently have dependency injection, add the smallest test seam needed:

```ts
export const loadAndStartCodeHelmFromProcess = async (
  env: Record<string, string | undefined> = Bun.env,
  dependencies: {
    parseConfig?: typeof parseConfig;
    startCodeHelm?: typeof startCodeHelm;
  } = {},
) => {
```

Use `dependencies.parseConfig ?? parseConfig` and `dependencies.startCodeHelm ?? startCodeHelm` internally. Keep production behavior unchanged when dependencies are omitted.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
bun test tests/cli/commands.test.ts tests/index.test.ts
```

Expected: FAIL because background env does not include the port and the env helper does not exist.

- [ ] **Step 3: Add background env handoff**

In `src/cli/commands.ts`, update `startInBackground` signature:

```ts
const startInBackground = async (
  store: LoadedConfigStore,
  services: CommandServices,
  options: { managedAppServerPort?: number } = {},
) => {
```

Build the env with a conditional field:

```ts
const env: Record<string, string | undefined> = {
  ...process.env,
  ...services.env,
  CODE_HELM_CONFIG: store.paths.configPath,
  CODE_HELM_SECRETS: store.paths.secretsPath,
  CODE_HELM_DAEMON_MODE: "background",
};

if (options.managedAppServerPort === undefined) {
  delete env.CODE_HELM_MANAGED_APP_SERVER_PORT;
} else {
  env.CODE_HELM_MANAGED_APP_SERVER_PORT = String(options.managedAppServerPort);
}
```

This explicit delete is required because `CODE_HELM_MANAGED_APP_SERVER_PORT` is an internal parent-to-daemon handoff. A stale value in `process.env` or `services.env` must not affect `code-helm start --daemon` when the user did not pass `--port`.

Pass it from the start branch:

```ts
const backgroundRuntime = await startInBackground(configuredStore, services, {
  managedAppServerPort: command.port,
});
```

- [ ] **Step 4: Add daemon env parser**

In `src/index.ts`, export:

```ts
export const resolveManagedAppServerPortFromEnv = (
  env: Record<string, string | undefined>,
) => {
  const rawPort = env.CODE_HELM_MANAGED_APP_SERVER_PORT;

  if (rawPort === undefined || rawPort.trim().length === 0) {
    return undefined;
  }

  if (!/^\d+$/.test(rawPort)) {
    throw new Error(`CODE_HELM_MANAGED_APP_SERVER_PORT must be an integer from 1 to 65535: ${rawPort}`);
  }

  const port = Number(rawPort);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`CODE_HELM_MANAGED_APP_SERVER_PORT must be an integer from 1 to 65535: ${rawPort}`);
  }

  return port;
};
```

In `loadAndStartCodeHelmFromProcess`, compute:

```ts
const managedAppServerPort = resolveManagedAppServerPortFromEnv(env);
```

Pass it to `startCodeHelm`:

```ts
managedAppServerPort,
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
bun test tests/cli/commands.test.ts tests/index.test.ts
```

Expected: PASS for background env handoff and parser tests.

- [ ] **Step 6: Commit background port handoff**

```bash
git add src/cli/commands.ts src/index.ts tests/cli/commands.test.ts tests/index.test.ts
git commit -m "feat(runtime): pass managed app server port to daemon"
```

---

### Task 6: Add Typed `startup-error.json` Runtime State

**Files:**
- Modify: `src/cli/runtime-state.ts`
- Modify: `tests/cli/runtime-state.test.ts`

- [ ] **Step 1: Add failing runtime-state tests**

In `tests/cli/runtime-state.test.ts`, add:

```ts
test("writes reads and clears startup-error.json", () => {
  const directory = createTempDir();

  writeStartupError({
    stateDir: directory,
    error: {
      stage: "managed-app-server",
      appServerAddress: "ws://127.0.0.1:4201",
      message: "Managed Codex App Server failed to start.",
      diagnostics: "address already in use",
      occurredAt: "2026-04-27T12:00:00.000Z",
    },
  });

  expect(readStartupError({ stateDir: directory })).toEqual({
    stage: "managed-app-server",
    appServerAddress: "ws://127.0.0.1:4201",
    message: "Managed Codex App Server failed to start.",
    diagnostics: "address already in use",
    occurredAt: "2026-04-27T12:00:00.000Z",
  });

  clearStartupError({ stateDir: directory });
  expect(readStartupError({ stateDir: directory })).toBeUndefined();
});
```

Add an invalid-file cleanup test:

```ts
test("readStartupError removes invalid startup-error state", () => {
  const directory = createTempDir();
  writeFileSync(join(directory, "startup-error.json"), "{bad json");

  expect(readStartupError({ stateDir: directory })).toBeUndefined();
  expect(existsSync(join(directory, "startup-error.json"))).toBe(false);
});
```

- [ ] **Step 2: Run runtime-state tests and verify failure**

Run:

```bash
bun test tests/cli/runtime-state.test.ts
```

Expected: FAIL because startup-error helpers do not exist.

- [ ] **Step 3: Implement startup-error schema and helpers**

In `src/cli/runtime-state.ts`, add:

```ts
const startupErrorSchema = z.object({
  stage: z.enum(["managed-app-server"]),
  appServerAddress: wsUrlSchema,
  message: z.string().min(1),
  diagnostics: z.string().optional(),
  occurredAt: z.string().datetime(),
});

export type StartupError = z.infer<typeof startupErrorSchema>;
```

Add path and helper functions:

```ts
export const resolveStartupErrorPath = ({ stateDir }: RuntimeStateOptions) => {
  return join(stateDir, "startup-error.json");
};

export const writeStartupError = (
  options: RuntimeStateOptions & {
    error: StartupError;
  },
) => {
  ensureStateDir(options.stateDir);
  writeJsonFileAtomically(
    resolveStartupErrorPath({ stateDir: options.stateDir }),
    startupErrorSchema.parse(options.error),
  );
};

export const readStartupError = ({ stateDir }: RuntimeStateOptions) => {
  const startupErrorPath = resolveStartupErrorPath({ stateDir });

  if (!existsSync(startupErrorPath)) {
    return undefined;
  }

  try {
    return startupErrorSchema.parse(readJsonFile(startupErrorPath));
  } catch {
    removeFileIfExists(startupErrorPath);
    return undefined;
  }
};

export const clearStartupError = ({ stateDir }: RuntimeStateOptions) => {
  removeFileIfExists(resolveStartupErrorPath({ stateDir }));
};
```

Do not modify `clearRuntimeState` to delete `startup-error.json`. The parent explicitly clears stale startup errors before launching, and the current-attempt failure handoff must survive daemon cleanup.

- [ ] **Step 4: Run runtime-state tests**

Run:

```bash
bun test tests/cli/runtime-state.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit startup-error state helpers**

```bash
git add src/cli/runtime-state.ts tests/cli/runtime-state.test.ts
git commit -m "feat(cli): persist daemon startup errors"
```

---

### Task 7: Report Background Startup Failures From `startup-error.json`

**Files:**
- Modify: `src/cli/commands.ts`
- Modify: `tests/cli/commands.test.ts`

- [ ] **Step 1: Add failing parent-side failure tests**

Extend `CommandServices` test stubs as needed with `readStartupError`, `clearStartupError`, and `waitForBackgroundStartup`.

Important: `startInBackground` will move from the old `waitForBackgroundRuntime` success-only seam to a new `waitForBackgroundStartup` seam. Keep `waitForBackgroundRuntime` for update/restart flows, but update `createBaseServices()` so daemon-start tests still get a ready default:

```ts
waitForBackgroundStartup: async () => ({
  kind: "ready",
  runtime: createRuntimeSummary(),
}),
```

Any existing `start --daemon` test that currently overrides `waitForBackgroundRuntime` to control startup should be changed to override `waitForBackgroundStartup` instead. Update/restart tests should continue using `waitForBackgroundRuntime`.

Add:

```ts
test("start --daemon reports startup-error state instead of generic runtime timeout", async () => {
  const services = createBaseServices();
  const clearedStartupErrorDirs: string[] = [];
  let thrown: unknown;

  services.spawnBackgroundProcess = () => ({
    pid: 5555,
    unref() {},
  });
  services.waitForBackgroundStartup = async () => ({
    kind: "failed",
    error: {
      stage: "managed-app-server",
      appServerAddress: "ws://127.0.0.1:4201",
      message: "Managed Codex App Server failed to start.",
      diagnostics: "address already in use",
      occurredAt: "2026-04-27T12:00:00.000Z",
    },
  });
  services.clearStartupError = ({ stateDir }) => {
    clearedStartupErrorDirs.push(stateDir);
  };

  try {
    await runCliCommand({ kind: "start", daemon: true, port: 4201 }, services);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  const message = (thrown as Error).message;
  expect(message).toMatch(/ws:\/\/127\.0\.0\.1:4201/);
  expect(message).toMatch(/lsof -nP -iTCP:4201 -sTCP:LISTEN/);

  expect(clearedStartupErrorDirs).toContain(services.loadConfigStore().paths.stateDir);
});
```

Add:

```ts
test("start --daemon clears stale startup-error state before launch", async () => {
  const services = createBaseServices();
  const paths = createPaths();
  const clearedStartupErrorDirs: string[] = [];

  services.loadConfigStore = () => ({
    ...createBaseServices().loadConfigStore(),
    paths,
  });
  services.clearStartupError = ({ stateDir }) => {
    clearedStartupErrorDirs.push(stateDir);
  };

  await runCliCommand({ kind: "start", daemon: true, port: 4201 }, services);

  expect(clearedStartupErrorDirs).toContain(paths.stateDir);
});
```

Keep existing generic timeout tests. They should still pass when no startup error is present.

- [ ] **Step 2: Run command tests and verify failure**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: FAIL because services do not include startup-error helpers and background startup only waits for `runtime.json`.

- [ ] **Step 3: Extend command services**

In `src/cli/commands.ts`, import:

```ts
import {
  clearStartupError,
  readStartupError,
  type StartupError,
} from "./runtime-state";
```

Add the startup wait result type near the other command-local types:

```ts
type BackgroundStartupWaitResult =
  | { kind: "ready"; runtime: RuntimeSummary }
  | { kind: "failed"; error: StartupError }
  | { kind: "timeout" };
```

Extend `CommandServices`:

```ts
readStartupError: (options: { stateDir: string }) => StartupError | undefined;
clearStartupError: (options: { stateDir: string }) => void;
waitForBackgroundStartup: (options: {
  stateDir: string;
  isPidAlive: (pid: number) => boolean;
  timeoutMs?: number;
}) => Promise<BackgroundStartupWaitResult>;
```

Add defaults in `createDefaultServices`:

```ts
readStartupError,
clearStartupError,
waitForBackgroundStartup: (options) =>
  waitForBackgroundStartup({
    stateDir: options.stateDir,
    isPidAlive: options.isPidAlive,
    timeoutMs: options.timeoutMs,
  }, {
    readRuntimeSummary,
    readStartupError,
  }),
```

Update all test `createBaseServices()` stubs to provide no-op/read-undefined implementations and a ready `waitForBackgroundStartup` default.

- [ ] **Step 4: Add a parent-side startup wait helper**

In `src/cli/commands.ts`, add this helper. Keep it separate from `waitForBackgroundRuntime`; update/restart flows still use the old success-only wait. Reuse the `BackgroundStartupWaitResult` type added in Step 3.

```ts
const waitForBackgroundStartup = async (
  options: {
    stateDir: string;
    isPidAlive: (pid: number) => boolean;
    timeoutMs?: number;
  },
  services: Pick<CommandServices, "readRuntimeSummary" | "readStartupError">,
): Promise<BackgroundStartupWaitResult> => {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const startupError = services.readStartupError({ stateDir: options.stateDir });

    if (startupError) {
      return { kind: "failed", error: startupError };
    }

    const runtime = services.readRuntimeSummary(options);

    if (runtime) {
      return { kind: "ready", runtime };
    }

    await Bun.sleep(50);
  }

  return { kind: "timeout" };
};
```

- [ ] **Step 5: Render startup-error with address and lsof hint**

Add:

```ts
const formatPortInspectionCommand = (appServerAddress: string) => {
  const port = new URL(appServerAddress).port;
  return `lsof -nP -iTCP:${port} -sTCP:LISTEN`;
};

const renderStartupErrorState = (
  error: StartupError,
  env: Record<string, string | undefined>,
) => {
  return renderErrorPanel({
    title: "Startup Failed",
    headline: error.message,
    sections: [
      {
        kind: "key-value",
        title: "Managed Codex App Server",
        rows: [
          { key: "Address", value: error.appServerAddress },
        ],
      },
      {
        kind: "steps",
        title: "Try next",
        items: [
          "The selected port may already be in use.",
          formatPortInspectionCommand(error.appServerAddress),
          "Stop the conflicting process or choose another port with code-helm start --port <port>.",
        ],
      },
    ],
    diagnostics: trimDiagnostics(error.diagnostics),
    env,
  });
};
```

- [ ] **Step 6: Use the startup wait service in `startInBackground`**

Before spawning:

```ts
services.clearStartupError({ stateDir: store.paths.stateDir });
```

Replace the old `services.waitForBackgroundRuntime(...)` call:

```ts
const startup = await services.waitForBackgroundStartup({
  stateDir: store.paths.stateDir,
  isPidAlive: services.isPidAlive,
  timeoutMs: services.backgroundRuntimeTimeoutMs,
});

if (startup.kind === "ready") {
  return startup.runtime;
}

if (startup.kind === "failed") {
  try {
    services.signalProcess(child.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
  } finally {
    services.clearStartupError({ stateDir: store.paths.stateDir });
  }

  throw new Error(renderStartupErrorState(startup.error, services.env));
}
```

Leave the existing timeout branch behavior intact for `startup.kind === "timeout"`.

After this change, run through `tests/cli/commands.test.ts` and update any `start --daemon` test that still sets `services.waitForBackgroundRuntime` for startup behavior. Those tests should set `services.waitForBackgroundStartup` instead. Keep `services.waitForBackgroundRuntime` overrides in update/restart tests.

- [ ] **Step 7: Run command tests**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit parent failure reporting**

```bash
git add src/cli/commands.ts tests/cli/commands.test.ts
git commit -m "feat(cli): report daemon startup errors"
```

---

### Task 8: Write Startup Errors From The Daemon Child

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/index.test.ts`

- [ ] **Step 1: Add failing child-side startup-error tests**

In `tests/index.test.ts`, add:

```ts
test("background start writes startup-error after managed app-server startup failure", async () => {
  const calls: string[] = [];
  let writtenError:
    | {
      stage: "managed-app-server";
      appServerAddress: string;
      message: string;
      diagnostics?: string;
      occurredAt: string;
    }
    | undefined;

  await expect(
    startCodeHelm({
      ...createAppConfig(),
      codex: {
        appServerUrl: DEFAULT_CODEX_APP_SERVER_URL,
      },
    }, {
      installSignalHandlers: false,
      mode: "background",
      stateDir: "/tmp/codehelm-state",
      managedAppServerPort: 4201,
      acquireInstanceLock: () => ({
        pid: process.pid,
        cleanedStaleState: false,
      }),
      clearRuntimeState: () => {
        calls.push("clear-runtime-state");
      },
      writeStartupError: ({ error }) => {
        calls.push("write-startup-error");
        writtenError = error;
      },
      startManagedCodexAppServer: async () => {
        throw new CodexSupervisorError(
          "CODEX_APP_SERVER_FAILED_TO_START",
          "Managed Codex App Server failed to start.",
          {
            startupDisposition: "failed",
            diagnostics: "address already in use",
          },
        );
      },
      startRuntime: async () => {
        throw new Error("runtime should not start");
      },
    }),
  ).rejects.toMatchObject({
    code: "CODEX_APP_SERVER_FAILED_TO_START",
  });

  expect(calls).toEqual(["clear-runtime-state", "write-startup-error"]);
  expect(writtenError).toMatchObject({
    stage: "managed-app-server",
    appServerAddress: "ws://127.0.0.1:4201",
    message: "Managed Codex App Server failed to start.",
    diagnostics: "address already in use",
  });
});
```

Also add a control test that foreground failure does not write `startup-error.json`.

- [ ] **Step 2: Run index tests and verify failure**

Run:

```bash
bun test tests/index.test.ts
```

Expected: FAIL because `StartCodeHelmOptions` has no `writeStartupError` seam and no startup-error handoff.

- [ ] **Step 3: Add write seam and imports**

In `src/index.ts`, import:

```ts
import {
  writeStartupError,
  type StartupError,
} from "./cli/runtime-state";
import {
  DEFAULT_MANAGED_CODEX_APP_SERVER_PORT,
  formatManagedCodexAppServerAddress,
} from "./codex/supervisor";
```

Add to `StartCodeHelmOptions`:

```ts
managedAppServerPort?: number;
writeStartupError?: typeof writeStartupError;
```

Inside `startCodeHelm`, define:

```ts
const publishStartupError = options.writeStartupError ?? writeStartupError;
const selectedManagedAppServerPort =
  options.managedAppServerPort ?? DEFAULT_MANAGED_CODEX_APP_SERVER_PORT;
const selectedManagedAppServerAddress = formatManagedCodexAppServerAddress(
  selectedManagedAppServerPort,
);
```

- [ ] **Step 4: Write current-attempt startup error last**

In the `catch` block of `startCodeHelm`, keep runtime/managed-server cleanup first. After `clearState({ stateDir })`, write startup error only when all conditions are true:

- `mode === "background"`
- `options.stateDir` exists
- config was using managed startup (`config.codex.appServerUrl === DEFAULT_CODEX_APP_SERVER_URL`)
- error is `CodexSupervisorError` with `code === "CODEX_APP_SERVER_FAILED_TO_START"`

Code shape:

```ts
const shouldPublishStartupError =
  mode === "background"
  && options.stateDir
  && config.codex.appServerUrl === DEFAULT_CODEX_APP_SERVER_URL
  && error instanceof CodexSupervisorError
  && error.code === "CODEX_APP_SERVER_FAILED_TO_START";

if (shouldPublishStartupError) {
  publishStartupError({
    stateDir: options.stateDir,
    error: {
      stage: "managed-app-server",
      appServerAddress: selectedManagedAppServerAddress,
      message: "Managed Codex App Server failed to start.",
      diagnostics: error.diagnostics ?? error.message,
      occurredAt: new Date().toISOString(),
    } satisfies StartupError,
  });
}
```

This write must remain after cleanup so the child does not delete its own handoff.

- [ ] **Step 5: Run index tests**

Run:

```bash
bun test tests/index.test.ts
```

Expected: PASS for startup-error handoff tests.

- [ ] **Step 6: Commit child failure handoff**

```bash
git add src/index.ts tests/index.test.ts
git commit -m "feat(runtime): publish daemon startup failures"
```

---

### Task 9: Port-Aware Foreground Startup Failure Output

**Files:**
- Modify: `src/cli/commands.ts`
- Modify: `tests/cli/commands.test.ts`

- [ ] **Step 1: Add failing foreground failure output test**

In `tests/cli/commands.test.ts`, update or add a startup failure test:

```ts
test("start reports managed app-server port guidance on foreground startup failure", async () => {
  const services = createBaseServices();
  let thrown: unknown;

  services.startForeground = async () => {
    throw new CodexSupervisorError(
      "CODEX_APP_SERVER_FAILED_TO_START",
      "Managed Codex App Server failed to start.",
      {
        startupDisposition: "failed",
        diagnostics: "address already in use",
      },
    );
  };

  try {
    await runCliCommand({ kind: "start", daemon: false, port: 4201 }, services);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  const message = (thrown as Error).message;
  expect(message).toMatch(/ws:\/\/127\.0\.0\.1:4201/);
  expect(message).toMatch(/lsof -nP -iTCP:4201 -sTCP:LISTEN/);
});
```

- [ ] **Step 2: Run command tests and verify failure**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: FAIL because `formatStartupFailure` does not include selected address or `lsof`.

- [ ] **Step 3: Pass selected address to `formatStartupFailure`**

In `src/cli/commands.ts`, import:

```ts
import {
  DEFAULT_MANAGED_CODEX_APP_SERVER_PORT,
  formatManagedCodexAppServerAddress,
} from "../codex/supervisor";
```

Update `formatStartupFailure` signature:

```ts
const formatStartupFailure = (
  error: unknown,
  options: {
    appServerAddress?: string;
    env: Record<string, string | undefined>;
  },
) => {
```

In the failed managed app-server branch, include an address section and port command when `options.appServerAddress` is available:

```ts
const portHint = options.appServerAddress
  ? formatPortInspectionCommand(options.appServerAddress)
  : undefined;
```

Add the address row and `portHint` to the `Try next` items. Keep certificate-specific rendering unchanged.

In the foreground catch:

```ts
const appServerAddress = formatManagedCodexAppServerAddress(
  command.port ?? DEFAULT_MANAGED_CODEX_APP_SERVER_PORT,
);
const formattedStartupFailure = formatStartupFailure(error, {
  appServerAddress,
  env: services.env,
});
```

- [ ] **Step 4: Run command tests**

Run:

```bash
bun test tests/cli/commands.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit foreground failure output**

```bash
git add src/cli/commands.ts tests/cli/commands.test.ts
git commit -m "fix(cli): show managed port startup guidance"
```

---

### Task 10: Final Verification

**Files:**
- Verify all changed files

- [ ] **Step 1: Run focused test set**

Run:

```bash
bun test tests/cli/args.test.ts tests/codex/supervisor.test.ts tests/cli/onboard.test.ts tests/cli/runtime-state.test.ts tests/cli/commands.test.ts tests/index.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run full test suite**

Run:

```bash
bun test
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Inspect git status and log**

Run:

```bash
git status --short
git log --oneline -8
```

Expected:

- no unrelated files staged
- commits are scoped and conventional
- no generated browser/test artifacts are included

- [ ] **Step 5: Manual smoke command without Discord secrets**

Run parser-only help smoke:

```bash
bun run src/cli.ts help
```

Expected:

- output includes `start`
- output includes `start --daemon`
- output includes `start --port <port>`

- [ ] **Step 6: Report completion**

Summarize:

- default managed app-server port is now `4200`
- `--port` works for foreground and daemon startup
- daemon startup failures use `startup-error.json`
- tests and typecheck run results
