import { expect, test } from "bun:test";
import {
  canChangeSessionWorkdir,
  canControlSession,
  canImportSession,
} from "../../src/domain/session-service";
import {
  isUnsupportedExternalModification,
  shouldDegradeDiscordToReadOnly,
} from "../../src/domain/external-modification";

test("only idle sessions are importable", () => {
  expect(canImportSession({ runtimeState: "idle" })).toBe(true);
  expect(canImportSession({ runtimeState: "running" })).toBe(false);
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
    isUnsupportedExternalModification({ controlSurface: "plain-codex" }),
  ).toBe(true);
  expect(
    shouldDegradeDiscordToReadOnly({
      unsupportedExternalModificationDetected: true,
    }),
  ).toBe(true);
  expect(
    shouldDegradeDiscordToReadOnly({
      unsupportedExternalModificationDetected: false,
    }),
  ).toBe(false);
});
