import { createHash } from "node:crypto";

export type SerializedLogError = {
  name: string;
  message: string;
  stack?: string;
  code?: string | number;
  cause?: unknown;
};

export type NormalizedLogArguments = {
  meta: Record<string, unknown>;
  msg?: string;
};

const redactedValue = "[REDACTED]";
const maxCommandPreviewLength = 500;
const maxStringLength = 2_000;
const maxArrayLength = 50;
const maxObjectDepth = 6;
const sensitiveFieldPattern =
  /(authorization|credential|password|secret|token|api_?key|api-?key|apikey)/i;
const userContentFieldNames = new Set([
  "content",
  "input",
  "justification",
  "messageContent",
  "prompt",
  "text",
  "userInput",
  "userMessage",
  "userPrompt",
]);
const commandPreviewFieldNames = new Set(["commandPreview"]);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isError = (value: unknown): value is Error => {
  return value instanceof Error;
};

const hashContent = (value: string) => {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
};

const summarizeUserContent = (value: string) => {
  return {
    redacted: true,
    length: value.length,
    sha256: hashContent(value),
  };
};

const truncateString = (value: string, maxLength: number) => {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}...`;
};

const normalizeStackName = (error: Error) => {
  if (!error.stack) {
    return undefined;
  }

  return error.name === "Error"
    ? error.stack
    : error.stack.replace(/^Error(?=:|\n)/, error.name);
};

export const serializeLogError = (
  error: Error,
  depth = 0,
  seen = new WeakSet<object>(),
): SerializedLogError => {
  const serialized: SerializedLogError = {
    name: error.name || "Error",
    message: error.message,
  };
  const stack = normalizeStackName(error);

  if (stack) {
    serialized.stack = stack;
  }

  const code = (error as Error & { code?: unknown }).code;

  if (typeof code === "string" || typeof code === "number") {
    serialized.code = code;
  }

  const cause = (error as Error & { cause?: unknown }).cause;

  if (cause !== undefined && depth < maxObjectDepth) {
    serialized.cause = isError(cause)
      ? serializeLogError(cause, depth + 1, seen)
      : sanitizeLogValue(cause, undefined, depth + 1, seen);
  }

  return serialized;
};

export const sanitizeLogValue = (
  value: unknown,
  key?: string,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown => {
  if (key && sensitiveFieldPattern.test(key)) {
    return redactedValue;
  }

  if (typeof value === "string") {
    if (key && userContentFieldNames.has(key)) {
      return summarizeUserContent(value);
    }

    if (key && commandPreviewFieldNames.has(key)) {
      return truncateString(value, maxCommandPreviewLength);
    }

    return truncateString(value, maxStringLength);
  }

  if (
    value === null
    || typeof value === "number"
    || typeof value === "boolean"
    || typeof value === "bigint"
    || typeof value === "undefined"
  ) {
    return value;
  }

  if (isError(value)) {
    return serializeLogError(value, depth, seen);
  }

  if (Array.isArray(value)) {
    if (depth >= maxObjectDepth) {
      return "[MaxDepth]";
    }

    return value
      .slice(0, maxArrayLength)
      .map((item) => sanitizeLogValue(item, undefined, depth + 1, seen));
  }

  if (!isRecord(value)) {
    return String(value);
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  if (depth >= maxObjectDepth) {
    return "[MaxDepth]";
  }

  seen.add(value);

  const sanitized: Record<string, unknown> = {};

  for (const [nextKey, nextValue] of Object.entries(value)) {
    sanitized[nextKey] = sanitizeLogValue(nextValue, nextKey, depth + 1, seen);
  }

  seen.delete(value);

  return sanitized;
};

const addExtra = (meta: Record<string, unknown>, value: unknown) => {
  const existingExtras = Array.isArray(meta.extra) ? meta.extra : [];
  meta.extra = [
    ...existingExtras,
    sanitizeLogValue(value),
  ];
};

const mergeMetaValue = (meta: Record<string, unknown>, value: unknown) => {
  if (value === undefined) {
    return;
  }

  if (isError(value)) {
    if (!meta.err) {
      meta.err = serializeLogError(value);
      return;
    }

    const existingErrors = Array.isArray(meta.errors) ? meta.errors : [];
    meta.errors = [
      ...existingErrors,
      serializeLogError(value),
    ];
    return;
  }

  if (isRecord(value) && !(value instanceof Date)) {
    Object.assign(meta, sanitizeLogValue(value));
    return;
  }

  addExtra(meta, value);
};

export const normalizeLogArguments = (args: unknown[]): NormalizedLogArguments => {
  const [first, second, ...rest] = args;
  const meta: Record<string, unknown> = {};
  let msg: string | undefined;

  if (typeof first === "string") {
    msg = first;
    for (const value of [second, ...rest]) {
      mergeMetaValue(meta, value);
    }
    return { meta, msg };
  }

  if (isRecord(first) && !isError(first)) {
    Object.assign(meta, sanitizeLogValue(first));

    if (typeof second === "string") {
      msg = second;
      for (const value of rest) {
        mergeMetaValue(meta, value);
      }
    } else {
      mergeMetaValue(meta, second);
      for (const value of rest) {
        mergeMetaValue(meta, value);
      }
    }

    return { meta, msg };
  }

  if (isError(first)) {
    meta.err = serializeLogError(first);
    msg = first.message;
    for (const value of [second, ...rest]) {
      mergeMetaValue(meta, value);
    }
    return { meta, msg };
  }

  if (first !== undefined) {
    msg = String(first);
  }

  for (const value of [second, ...rest]) {
    mergeMetaValue(meta, value);
  }

  return { meta, msg };
};
