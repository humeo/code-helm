import { expect, test } from "bun:test";
import { parseCliArgs } from "../../src/cli/args";

test("parses supported cli commands", () => {
  expect(parseCliArgs(["onboard"])).toEqual({ kind: "onboard" });
  expect(parseCliArgs(["start"])).toEqual({ kind: "start", daemon: false });
  expect(parseCliArgs(["start", "--daemon"])).toEqual({
    kind: "start",
    daemon: true,
  });
  expect(parseCliArgs(["status"])).toEqual({ kind: "status" });
  expect(parseCliArgs(["stop"])).toEqual({ kind: "stop" });
  expect(parseCliArgs(["autostart", "enable"])).toEqual({
    kind: "autostart",
    action: "enable",
  });
  expect(parseCliArgs(["autostart", "disable"])).toEqual({
    kind: "autostart",
    action: "disable",
  });
  expect(parseCliArgs(["uninstall"])).toEqual({ kind: "uninstall" });
});

test("rejects unknown commands with a usage error", () => {
  expect(() => parseCliArgs(["wat"])).toThrow(/Usage: code-helm/);
});

test("rejects empty argv with a usage error", () => {
  expect(() => parseCliArgs([])).toThrow(/No command provided/);
});

test("rejects extra args for single-word commands", () => {
  expect(() => parseCliArgs(["onboard", "extra"])).toThrow(
    /Unknown arguments for onboard/,
  );
  expect(() => parseCliArgs(["status", "extra"])).toThrow(
    /Unknown arguments for status/,
  );
  expect(() => parseCliArgs(["stop", "extra"])).toThrow(
    /Unknown arguments for stop/,
  );
  expect(() => parseCliArgs(["uninstall", "extra"])).toThrow(
    /Unknown arguments for uninstall/,
  );
});

test("rejects invalid start flags and autostart arity", () => {
  expect(() => parseCliArgs(["start", "--bogus"])).toThrow(
    /Unknown arguments for start/,
  );
  expect(() => parseCliArgs(["start", "--daemon", "--extra"])).toThrow(
    /Unknown arguments for start/,
  );
  expect(() => parseCliArgs(["autostart"])).toThrow(/Usage: code-helm autostart/);
  expect(() => parseCliArgs(["autostart", "enable", "extra"])).toThrow(
    /Usage: code-helm autostart/,
  );
});
