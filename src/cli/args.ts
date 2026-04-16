export type CliCommand =
  | { kind: "onboard" }
  | { kind: "start"; daemon: boolean }
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "autostart"; action: "enable" | "disable" }
  | { kind: "uninstall" };

const usage = "Usage: code-helm <onboard|start|status|stop|autostart|uninstall>";

const failUsage = (message: string): never => {
  throw new Error(`${message}\n${usage}`);
};

export const parseCliArgs = (argv: string[]): CliCommand => {
  const [command, ...rest] = argv;

  switch (command) {
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
