import type { CodexThread } from "../codex/protocol-types";

export const MIN_PLAUSIBLE_THREAD_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
export const MAX_PLAUSIBLE_THREAD_TIMESTAMP_MS = Date.UTC(2100, 0, 1);
export const MIN_PLAUSIBLE_THREAD_TIMESTAMP_SECONDS = Math.trunc(
  MIN_PLAUSIBLE_THREAD_TIMESTAMP_MS / 1_000,
);
export const MIN_PLAUSIBLE_THREAD_TIMESTAMP_MICROSECONDS =
  MIN_PLAUSIBLE_THREAD_TIMESTAMP_MS * 1_000;

export const normalizeThreadTimestamp = (value?: number) => {
  if (value === undefined || !Number.isFinite(value)) {
    return null;
  }

  let normalized = Math.trunc(value);

  while (Math.abs(normalized) >= MIN_PLAUSIBLE_THREAD_TIMESTAMP_MICROSECONDS) {
    normalized = Math.trunc(normalized / 1_000);
  }

  const magnitude = Math.abs(normalized);

  if (magnitude >= MIN_PLAUSIBLE_THREAD_TIMESTAMP_MS) {
    // Already milliseconds.
  } else if (magnitude >= MIN_PLAUSIBLE_THREAD_TIMESTAMP_SECONDS) {
    normalized = Math.trunc(normalized * 1_000);
  } else {
    return null;
  }

  if (Math.abs(normalized) > MAX_PLAUSIBLE_THREAD_TIMESTAMP_MS) {
    return null;
  }

  return normalized;
};

export const getNormalizedThreadActivityTime = (thread: CodexThread) => {
  return normalizeThreadTimestamp(thread.updatedAt) ?? normalizeThreadTimestamp(thread.createdAt);
};

export const formatRelativeThreadTime = (timestampMs: number | null, now: number) => {
  if (timestampMs === null || !Number.isFinite(timestampMs)) {
    return "unknown time";
  }

  const diffMs = Math.max(0, now - timestampMs);

  if (diffMs < 60_000) {
    return "just now";
  }

  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 60) {
    return diffMinutes === 1 ? "1 minute ago" : `${diffMinutes} minutes ago`;
  }

  const diffHours = Math.floor(diffMs / 3_600_000);

  if (diffHours < 24) {
    return diffHours === 1 ? "1 hour ago" : `${diffHours} hours ago`;
  }

  const diffDays = Math.floor(diffMs / 86_400_000);

  return diffDays === 1 ? "1 day ago" : `${diffDays} days ago`;
};
