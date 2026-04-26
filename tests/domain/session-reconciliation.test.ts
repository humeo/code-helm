import { expect, test } from "bun:test";
import {
  limitThreadReadResultToRecentTurns,
  shouldWarmManagedSessionControlAtStartup,
} from "../../src/domain/session-reconciliation";
import type { ThreadReadResult } from "../../src/codex/protocol-types";

const makeSnapshot = (turnCount: number): ThreadReadResult => ({
  requestId: "read-1",
  thread: {
    id: "thread-1",
    cwd: "/tmp/project",
    preview: "project",
    status: { type: "idle" },
    name: "Project thread",
    turns: Array.from({ length: turnCount }, (_, index) => ({
      id: `turn-${index + 1}`,
      items: [],
    })),
  },
});

test("limitThreadReadResultToRecentTurns keeps the latest ten turns and preserves metadata", () => {
  const limited = limitThreadReadResultToRecentTurns(makeSnapshot(12));

  expect(limited.requestId).toBe("read-1");
  expect(limited.thread.id).toBe("thread-1");
  expect(limited.thread.cwd).toBe("/tmp/project");
  expect(limited.thread.name).toBe("Project thread");
  expect(limited.thread.turns?.map((turn) => turn.id)).toEqual([
    "turn-3",
    "turn-4",
    "turn-5",
    "turn-6",
    "turn-7",
    "turn-8",
    "turn-9",
    "turn-10",
    "turn-11",
    "turn-12",
  ]);
});

test("limitThreadReadResultToRecentTurns supports custom limits", () => {
  const limited = limitThreadReadResultToRecentTurns(makeSnapshot(5), 2);

  expect(limited.thread.turns?.map((turn) => turn.id)).toEqual([
    "turn-4",
    "turn-5",
  ]);
});

test("limitThreadReadResultToRecentTurns normalizes empty or missing turns", () => {
  expect(limitThreadReadResultToRecentTurns(makeSnapshot(0)).thread.turns)
    .toEqual([]);

  const { turns: _turns, ...threadWithoutTurns } = makeSnapshot(3).thread;
  const snapshotWithoutTurns: ThreadReadResult = {
    thread: threadWithoutTurns,
  };

  expect(limitThreadReadResultToRecentTurns(snapshotWithoutTurns).thread.turns)
    .toEqual([]);
});

test("shouldWarmManagedSessionControlAtStartup targets only active live sessions", () => {
  expect(shouldWarmManagedSessionControlAtStartup({
    lifecycleState: "active",
    state: "running",
  })).toBe(true);
  expect(shouldWarmManagedSessionControlAtStartup({
    lifecycleState: "active",
    state: "waiting-approval",
  })).toBe(true);
  expect(shouldWarmManagedSessionControlAtStartup({
    lifecycleState: "active",
    state: "idle",
  })).toBe(false);
  expect(shouldWarmManagedSessionControlAtStartup({
    lifecycleState: "archived",
    state: "running",
  })).toBe(false);
  expect(shouldWarmManagedSessionControlAtStartup({
    lifecycleState: "deleted",
    state: "waiting-approval",
  })).toBe(false);
});
