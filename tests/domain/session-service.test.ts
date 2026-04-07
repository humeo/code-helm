import { expect, test } from "bun:test";
import {
  canChangeSessionWorkdir,
  canControlSession,
  canImportSession,
} from "../../src/domain/session-service";
import type { SessionRuntimeState } from "../../src/domain/types";
import {
  isUnsupportedExternalModification,
  shouldDegradeDiscordToReadOnly,
} from "../../src/domain/external-modification";

test("only idle sessions are importable", () => {
  const states: Array<[SessionRuntimeState, boolean]> = [
    ["idle", true],
    ["running", false],
    ["waiting-approval", false],
    ["degraded", false],
  ];

  for (const [runtimeState, expected] of states) {
    expect(canImportSession({ runtimeState })).toBe(expected);
  }

  const runtimeState = "idle" as string;

  // @ts-expect-error runtimeState must be a SessionRuntimeState
  canImportSession({ runtimeState });
});

test("sessions keep the same workdir", () => {
  expect(
    canChangeSessionWorkdir({
      currentWorkdirId: "wd1",
      requestedWorkdirId: "wd1",
    }),
  ).toBe(true);
  expect(
    canChangeSessionWorkdir({
      currentWorkdirId: "wd1",
      requestedWorkdirId: "wd2",
    }),
  ).toBe(false);
});

test("only the owner can control the session", () => {
  expect(canControlSession({ viewerId: "u1", ownerId: "u1" })).toBe(true);
  expect(canControlSession({ viewerId: "u2", ownerId: "u1" })).toBe(false);
});

test("unsupported external modifications degrade Discord to read-only", () => {
  expect(isUnsupportedExternalModification({ controlSurface: "discord" })).toBe(
    false,
  );
  expect(
    isUnsupportedExternalModification({ controlSurface: "codex-remote" }),
  ).toBe(false);
  expect(
    isUnsupportedExternalModification({ controlSurface: "plain-codex" }),
  ).toBe(true);
  expect(isUnsupportedExternalModification({ controlSurface: "unknown" })).toBe(
    true,
  );

  expect(shouldDegradeDiscordToReadOnly({ controlSurface: "discord" })).toBe(
    false,
  );
  expect(
    shouldDegradeDiscordToReadOnly({ controlSurface: "codex-remote" }),
  ).toBe(false);
  expect(
    shouldDegradeDiscordToReadOnly({ controlSurface: "plain-codex" }),
  ).toBe(true);
  expect(shouldDegradeDiscordToReadOnly({ controlSurface: "unknown" })).toBe(
    true,
  );
});
