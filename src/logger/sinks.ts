import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { formatLocalLogDate } from "./retention";

export type CodeHelmLogLevel =
  | "trace"
  | "debug"
  | "info"
  | "warn"
  | "error"
  | "fatal"
  | "silent";

export type DailyLogFileKind = "main" | "error";

export type DailyLogFilePathOptions = {
  logDir: string;
  kind: DailyLogFileKind;
  date: Date;
};

export type DailyJsonlSinkOptions = {
  logDir: string;
  kind: DailyLogFileKind;
  now?: () => Date;
};

export type DailyJsonlStreamsOptions = {
  logDir: string;
  level: CodeHelmLogLevel;
  now?: () => Date;
};

export type DailyJsonlWritable = {
  write(data: string | Uint8Array): boolean;
};

export const getDailyLogFilePath = ({
  logDir,
  kind,
  date,
}: DailyLogFilePathOptions) => {
  const suffix = formatLocalLogDate(date);
  const filename = kind === "error"
    ? `codehelm-error-${suffix}.jsonl`
    : `codehelm-${suffix}.jsonl`;

  return join(logDir, filename);
};

export class DailyJsonlSink implements DailyJsonlWritable {
  constructor(private readonly options: Required<DailyJsonlSinkOptions>) {}

  write(data: string | Uint8Array) {
    mkdirSync(this.options.logDir, { recursive: true });
    appendFileSync(
      getDailyLogFilePath({
        logDir: this.options.logDir,
        kind: this.options.kind,
        date: this.options.now(),
      }),
      typeof data === "string" ? data : Buffer.from(data),
    );

    return true;
  }
}

export const createDailyJsonlSink = ({
  now = () => new Date(),
  ...options
}: DailyJsonlSinkOptions) => {
  return new DailyJsonlSink({
    ...options,
    now,
  });
};

export const createDailyJsonlStreams = ({
  logDir,
  level,
  now = () => new Date(),
}: DailyJsonlStreamsOptions) => {
  const mainStream = createDailyJsonlSink({
    logDir,
    kind: "main",
    now,
  });
  const errorStream = createDailyJsonlSink({
    logDir,
    kind: "error",
    now,
  });

  return [
    {
      level,
      stream: mainStream,
    },
    {
      level: "error" as const,
      stream: errorStream,
    },
  ];
};
