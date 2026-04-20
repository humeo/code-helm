export type CliCommand =
  | { kind: "help" }
  | { kind: "onboard" }
  | { kind: "start"; daemon: boolean }
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "version" }
  | { kind: "update" }
  | { kind: "autostart"; action: "enable" | "disable" }
  | { kind: "uninstall" };

const usage = "Usage: code-helm <help|onboard|start|status|stop|version|update|autostart|uninstall>";

const failUsage = (message: string): never => {
  throw new Error(`${message}\n${usage}`);
};

export const parseCliArgs = (argv: string[]): CliCommand => {
  const [rawCommand, ...rest] = argv;
  const command = rawCommand === "-h" || rawCommand === "--help"
    ? "help"
    : rawCommand === "-v" || rawCommand === "--version"
      ? "version"
      : rawCommand;

  switch (command) {
    case "help":
      if (rest.length > 0) {
        failUsage(`Unknown arguments for help: ${rest.join(" ")}`);
      }
      return { kind: "help" };
    case "onboard":
      if (rest.length > 0) {
        failUsage(`Unknown arguments for onboard: ${rest.join(" ")}`);
      }
      return { kind: "onboard" };
    case "start": {
      if (rest.length === 0) {
        return { kind: "start", daemon: false };
      }

      if (rest.length === 1 && rest[0] === "--daemon") {
        return { kind: "start", daemon: true };
      }

      failUsage(`Unknown arguments for start: ${rest.join(" ")}`);
    }
    case "status":
      if (rest.length > 0) {
        failUsage(`Unknown arguments for status: ${rest.join(" ")}`);
      }
      return { kind: "status" };
    case "stop":
      if (rest.length > 0) {
        failUsage(`Unknown arguments for stop: ${rest.join(" ")}`);
      }
      return { kind: "stop" };
    case "version":
      if (rest.length > 0) {
        failUsage(`Unknown arguments for version: ${rest.join(" ")}`);
      }
      return { kind: "version" };
    case "update":
      if (rest.length > 0) {
        failUsage(`Unknown arguments for update: ${rest.join(" ")}`);
      }
      return { kind: "update" };
    case "autostart":
      if (rest.length !== 1 || (rest[0] !== "enable" && rest[0] !== "disable")) {
        failUsage(`Usage: code-helm autostart <enable|disable>`);
      }
      const action = rest[0] as "enable" | "disable";
      return {
        kind: "autostart",
        action,
      };
    case "uninstall":
      if (rest.length > 0) {
        failUsage(`Unknown arguments for uninstall: ${rest.join(" ")}`);
      }
      return { kind: "uninstall" };
    case undefined:
      failUsage("No command provided");
  }

  return failUsage(`Unknown command: ${command}`);
};
