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
  expect(parseCliArgs(["uninstall"])).toEqual({ kind: "uninstall" });
});

test("rejects unknown commands with a usage error", () => {
  expect(() => parseCliArgs(["wat"])).toThrow(/Usage: code-helm/);
});
