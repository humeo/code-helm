import { expect, test } from "bun:test";
import { parseCliArgs } from "../../src/cli/args";

test("parses supported cli commands", () => {
  expect(parseCliArgs(["help"])).toEqual({ kind: "help" });
  expect(parseCliArgs(["-h"])).toEqual({ kind: "help" });
  expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
  expect(parseCliArgs(["onboard"])).toEqual({ kind: "onboard" });
  expect(parseCliArgs(["start"])).toEqual({ kind: "start", daemon: false });
  expect(parseCliArgs(["start", "--daemon"])).toEqual({
    kind: "start",
    daemon: true,
  });
  expect(parseCliArgs(["status"])).toEqual({ kind: "status" });
  expect(parseCliArgs(["stop"])).toEqual({ kind: "stop" });
  expect(parseCliArgs(["version"])).toEqual({ kind: "version" });
  expect(parseCliArgs(["-v"])).toEqual({ kind: "version" });
  expect(parseCliArgs(["--version"])).toEqual({ kind: "version" });
  expect(parseCliArgs(["check"])).toEqual({ kind: "check", yes: false });
  expect(parseCliArgs(["check", "--yes"])).toEqual({ kind: "check", yes: true });
  expect(parseCliArgs(["update"])).toEqual({ kind: "update" });
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
  expect(() => parseCliArgs(["wat"])).toThrow(
    /Usage: code-helm <help\|onboard\|start\|status\|stop\|version\|check\|update\|autostart\|uninstall>/,
  );
});

test("rejects empty argv with a usage error", () => {
  expect(() => parseCliArgs([])).toThrow(/No command provided/);
  expect(() => parseCliArgs([])).toThrow(
    /Usage: code-helm <help\|onboard\|start\|status\|stop\|version\|check\|update\|autostart\|uninstall>/,
  );
});

test("rejects extra args for single-word commands", () => {
  expect(() => parseCliArgs(["help", "extra"])).toThrow(
    /Unknown arguments for help/,
  );
  expect(() => parseCliArgs(["--help", "extra"])).toThrow(
    /Unknown arguments for help/,
  );
  expect(() => parseCliArgs(["onboard", "extra"])).toThrow(
    /Unknown arguments for onboard/,
  );
  expect(() => parseCliArgs(["status", "extra"])).toThrow(
    /Unknown arguments for status/,
  );
  expect(() => parseCliArgs(["stop", "extra"])).toThrow(
    /Unknown arguments for stop/,
  );
  expect(() => parseCliArgs(["version", "extra"])).toThrow(
    /Unknown arguments for version/,
  );
  expect(() => parseCliArgs(["check", "extra"])).toThrow(
    /Unknown arguments for check/,
  );
  expect(() => parseCliArgs(["check", "--yes", "extra"])).toThrow(
    /Unknown arguments for check/,
  );
  expect(() => parseCliArgs(["check", "--bogus"])).toThrow(
    /Unknown arguments for check/,
  );
  expect(() => parseCliArgs(["update", "extra"])).toThrow(
    /Unknown arguments for update/,
  );
  expect(() => parseCliArgs(["uninstall", "extra"])).toThrow(
    /Unknown arguments for uninstall/,
  );
});

test("rejects invalid start flags and autostart arity", () => {
  expect(() => parseCliArgs(["start", "--help"])).toThrow(
    /Unknown arguments for start/,
  );
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
