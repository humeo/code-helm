import { expect, test } from "bun:test";
import {
  formatRelativeThreadTime,
  normalizeThreadTimestamp,
} from "../../src/domain/session-time";

test("normalizeThreadTimestamp converts second-based provider timestamps to milliseconds", () => {
  expect(normalizeThreadTimestamp(1_744_750_000)).toBe(1_744_750_000_000);
});

test("normalizeThreadTimestamp preserves millisecond-based provider timestamps", () => {
  expect(normalizeThreadTimestamp(1_744_750_000_123)).toBe(1_744_750_000_123);
});

test("normalizeThreadTimestamp collapses oversized microsecond-like provider timestamps", () => {
  expect(normalizeThreadTimestamp(1_744_750_000_123_000)).toBe(1_744_750_000_123);
});

test("normalizeThreadTimestamp returns null for undefined provider timestamps", () => {
  expect(normalizeThreadTimestamp(undefined)).toBeNull();
});

test("normalizeThreadTimestamp returns null for implausible provider timestamps", () => {
  expect(normalizeThreadTimestamp(12)).toBeNull();
  expect(normalizeThreadTimestamp(123_456_789)).toBeNull();
  expect(normalizeThreadTimestamp(4_102_444_800_001)).toBeNull();
});

test("formatRelativeThreadTime renders the expected relative labels", () => {
  expect(formatRelativeThreadTime(0, 30_000)).toBe("just now");
  expect(formatRelativeThreadTime(60_000, 120_000)).toBe("1 minute ago");
  expect(formatRelativeThreadTime(3_600_000, 7_200_000)).toBe("1 hour ago");
  expect(formatRelativeThreadTime(7_200_000, 14_400_000)).toBe("2 hours ago");
  expect(formatRelativeThreadTime(86_400_000, 172_800_000)).toBe("1 day ago");
});

test("formatRelativeThreadTime returns unknown time when the timestamp is missing", () => {
  expect(formatRelativeThreadTime(null, 7_200_000)).toBe("unknown time");
});
