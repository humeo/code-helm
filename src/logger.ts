import pino, { type Logger as PinoLogger } from "pino";
import pretty from "pino-pretty";
import { resolveCodeHelmPaths } from "./cli/paths";
import {
  createDailyJsonlStreams,
  type CodeHelmLogLevel,
  type DailyJsonlWritable,
} from "./logger/sinks";
import {
  startLogRetention,
  type LogRetentionResult,
  type RetentionLogger,
} from "./logger/retention";
import {
  normalizeLogArguments,
  sanitizeLogValue,
} from "./logger/sanitize";

export type { CodeHelmLogLevel };

export type CodeHelmLogger = {
  trace(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  fatal(...args: unknown[]): void;
  child(bindings: Record<string, unknown>): CodeHelmLogger;
};

export type CodeHelmLoggerRuntime = {
  logger: CodeHelmLogger;
  level: CodeHelmLogLevel;
  logDir: string;
  shutdown(): void;
};

export type LoggerConsoleMode = "pretty" | false;

export type CreateCodeHelmLoggerOptions = {
  env?: Record<string, string | undefined>;
  console?: LoggerConsoleMode;
  now?: () => Date;
  retainDays?: number;
  retentionIntervalMs?: number;
  listFiles?: (logDir: string) => string[];
  removeFile?: (path: string) => void;
  setIntervalFn?: (callback: () => void, intervalMs: number) => {
    unref?: () => void;
  };
  clearIntervalFn?: (timer: { unref?: () => void }) => void;
};

const defaultLogLevel: CodeHelmLogLevel = "info";
const acceptedLogLevels = new Set<CodeHelmLogLevel>([
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "fatal",
  "silent",
]);

const noopLogger: CodeHelmLogger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return noopLogger;
  },
};

let activeLogger: CodeHelmLogger = noopLogger;
let activeRuntime: CodeHelmLoggerRuntime | undefined;

export const parseLogLevel = (value: string | undefined): CodeHelmLogLevel => {
  if (value === undefined || value.trim() === "") {
    return defaultLogLevel;
  }

  const normalized = value.trim().toLowerCase();

  if (acceptedLogLevels.has(normalized as CodeHelmLogLevel)) {
    return normalized as CodeHelmLogLevel;
  }

  throw new Error(
    `Invalid CODE_HELM_LOG_LEVEL: ${value}. Expected one of: ${
      Array.from(acceptedLogLevels).join(", ")
    }`,
  );
};

class PinoCodeHelmLogger implements CodeHelmLogger {
  constructor(private readonly pinoLogger: PinoLogger) {}

  trace(...args: unknown[]) {
    this.write("trace", args);
  }

  debug(...args: unknown[]) {
    this.write("debug", args);
  }

  info(...args: unknown[]) {
    this.write("info", args);
  }

  warn(...args: unknown[]) {
    this.write("warn", args);
  }

  error(...args: unknown[]) {
    this.write("error", args);
  }

  fatal(...args: unknown[]) {
    this.write("fatal", args);
  }

  child(bindings: Record<string, unknown>) {
    return new PinoCodeHelmLogger(
      this.pinoLogger.child(sanitizeLogValue(bindings) as Record<string, unknown>),
    );
  }

  private write(level: Exclude<CodeHelmLogLevel, "silent">, args: unknown[]) {
    const { meta, msg } = normalizeLogArguments(args);

    if (msg === undefined) {
      this.pinoLogger[level](meta);
      return;
    }

    this.pinoLogger[level](meta, msg);
  }
}

const createPrettyConsoleStream = () => {
  return pretty({
    colorize: Boolean(process.stderr.isTTY),
    destination: 2,
    translateTime: "SYS:standard",
  }) as DailyJsonlWritable;
};

export const createCodeHelmLogger = ({
  env = process.env as Record<string, string | undefined>,
  console = "pretty",
  now = () => new Date(),
  retainDays = 14,
  retentionIntervalMs = 24 * 60 * 60 * 1000,
  listFiles,
  removeFile,
  setIntervalFn,
  clearIntervalFn,
}: CreateCodeHelmLoggerOptions = {}): CodeHelmLoggerRuntime => {
  const level = parseLogLevel(env.CODE_HELM_LOG_LEVEL);
  const logDir = resolveCodeHelmPaths({ env }).logDir;
  const streams: Array<{
    level: CodeHelmLogLevel;
    stream: DailyJsonlWritable;
  }> = [
    ...createDailyJsonlStreams({
      logDir,
      level,
      now,
    }),
  ];

  if (console === "pretty") {
    streams.push({
      level,
      stream: createPrettyConsoleStream(),
    });
  }

  const pinoLogger = pino(
    {
      base: {
        service: "code-helm",
      },
      level,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    pino.multistream(streams),
  );
  const logger = new PinoCodeHelmLogger(pinoLogger);
  const retentionLogger = logger.child({
    component: "logger",
    operation: "retention",
  }) as RetentionLogger;
  const retention = startLogRetention({
    logDir,
    retainDays,
    intervalMs: retentionIntervalMs,
    logger: retentionLogger,
    now,
    listFiles,
    removeFile,
    setIntervalFn,
    clearIntervalFn,
  });
  let stopped = false;

  return {
    logger,
    level,
    logDir,
    shutdown() {
      if (stopped) {
        return;
      }

      stopped = true;
      retention.stop();
    },
  };
};

export const initializeLogger = (options: CreateCodeHelmLoggerOptions = {}) => {
  shutdownLogger();
  activeRuntime = createCodeHelmLogger(options);
  activeLogger = activeRuntime.logger;
  return activeRuntime;
};

export const shutdownLogger = () => {
  activeRuntime?.shutdown();
  activeRuntime = undefined;
  activeLogger = noopLogger;
};

const delegate = <TLevel extends keyof Omit<CodeHelmLogger, "child">>(
  level: TLevel,
  args: unknown[],
) => {
  activeLogger[level](...args);
};

export const logger: CodeHelmLogger = {
  trace: (...args) => delegate("trace", args),
  debug: (...args) => delegate("debug", args),
  info: (...args) => delegate("info", args),
  warn: (...args) => delegate("warn", args),
  error: (...args) => delegate("error", args),
  fatal: (...args) => delegate("fatal", args),
  child(bindings) {
    return activeLogger.child(bindings);
  },
};
