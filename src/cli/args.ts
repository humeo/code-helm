export type CliCommand =
  | { kind: "help" }
  | { kind: "onboard" }
  | { kind: "start"; daemon: boolean; port?: number }
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "version" }
  | { kind: "check"; yes: boolean }
  | { kind: "update" }
  | { kind: "autostart"; action: "enable" | "disable" }
  | { kind: "uninstall" };

const usage = "Usage: code-helm <help|onboard|start|status|stop|version|check|update|autostart|uninstall>";

const failUsage = (message: string): never => {
  throw new Error(`${message}\n${usage}`);
};

const parsePortValue = (value: string | undefined): number => {
  if (value === undefined) {
    return failUsage("Missing value for --port");
  }

  if (!/^\d+$/.test(value)) {
    failUsage(`Invalid value for --port: ${value}`);
  }

  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    failUsage(`Invalid value for --port: ${value}`);
  }

  return port;
};

const parseStartArgs = (rest: string[]): CliCommand => {
  let daemon = false;
  let port: number | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];

    if (token === "--daemon") {
      if (daemon) {
        failUsage("Duplicate --daemon for start");
      }

      daemon = true;
      continue;
    }

    if (token === "--port") {
      if (port !== undefined) {
        failUsage("Duplicate --port for start");
      }

      port = parsePortValue(rest[index + 1]);
      index += 1;
      continue;
    }

    failUsage(`Unknown arguments for start: ${rest.join(" ")}`);
  }

  return port === undefined
    ? { kind: "start", daemon }
    : { kind: "start", daemon, port };
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
    case "start":
      return parseStartArgs(rest);
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
    case "check":
      if (rest.length === 0) {
        return { kind: "check", yes: false };
      }

      if (rest.length === 1 && rest[0] === "--yes") {
        return { kind: "check", yes: true };
      }

      failUsage(`Unknown arguments for check: ${rest.join(" ")}`);
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
