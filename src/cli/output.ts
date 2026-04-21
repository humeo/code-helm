export type CliCharset = "unicode" | "ascii";

type LinesSection = {
  title: string;
  lines: string[];
  kind?: "lines";
};

type KeyValueSection = {
  kind: "key-value";
  title: string;
  rows: Array<{ key: string; value: string }>;
};

type CommandListSection = {
  kind: "command-list";
  title: string;
  items: Array<{ command: string; description: string }>;
};

type StepsSection = {
  kind: "steps";
  title: string;
  items: string[];
};

type PathsSection = {
  kind: "paths";
  title: string;
  items: string[];
};

export type PanelSection =
  | LinesSection
  | KeyValueSection
  | CommandListSection
  | StepsSection
  | PathsSection;

export type RenderPanelOptions = {
  title: string;
  lines: string[];
  env: Record<string, string | undefined>;
};

export type RenderSemanticPanelOptions = {
  title: string;
  headline?: string;
  sections?: PanelSection[];
  diagnostics?: string;
  commandHints?: string[];
  env: Record<string, string | undefined>;
};

type CliScreenTone = "neutral" | "success" | "warning" | "error";

const localeVariables = ["LC_ALL", "LC_CTYPE", "LANG"] as const;
const ansiEscapePattern = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/gu;
const tabReplacement = "  ";
const unsafeControlPattern = /[\u0000-\u0008\u000B\u000C\u000D\u000E-\u001F\u007F]/gu;
const renderedSectionTitles = new Set([
  "Problem",
  "Details",
  "Usage",
  "Diagnostics",
  "Command Hints",
  "Status",
  "Result",
  "Changed",
  "Removed",
  "Failed",
  "Next Step",
  "Next steps",
  "Try next",
  "Configuration",
]);

const splitMultiline = (value: string) => {
  return value.split(/\r?\n/u);
};

const sanitizeRenderableText = (value: string) => {
  return value
    .replace(ansiEscapePattern, "")
    .replace(/\t/gu, tabReplacement)
    .replace(unsafeControlPattern, " ");
};

const toRenderableLines = (value: string) => {
  return value
    .split(/\r\n|\n|\r/u)
    .map((line) => sanitizeRenderableText(line));
};

const hasTruthyValue = (value: string | undefined) => {
  if (value === undefined) {
    return false;
  }

  const normalized = value.trim().toLowerCase();

  return normalized.length > 0 && normalized !== "0" && normalized !== "false";
};

const isCliColorEnabled = (env: Record<string, string | undefined>) => {
  if (env.NO_COLOR !== undefined) {
    return false;
  }

  if (detectCliCharset(env) === "ascii") {
    return false;
  }

  if (env.CLICOLOR === "0") {
    return false;
  }

  if (hasTruthyValue(env.FORCE_COLOR)) {
    return true;
  }

  return env.CODE_HELM_CLI_IS_TTY === "1";
};

const styleText = (
  value: string,
  env: Record<string, string | undefined>,
  sequence: string,
) => {
  if (!isCliColorEnabled(env) || value.length === 0) {
    return value;
  }

  return `\u001B[${sequence}m${value}\u001B[0m`;
};

const styleTitleLine = (
  value: string,
  tone: CliScreenTone,
  env: Record<string, string | undefined>,
) => {
  const sequence = (() => {
    switch (tone) {
      case "success":
        return "1;92";
      case "warning":
        return "1;93";
      case "error":
        return "1;91";
      case "neutral":
        return "1;96";
    }
  })();

  return styleText(value, env, sequence);
};

const styleHeadlineLine = (value: string, env: Record<string, string | undefined>) => {
  return styleText(value, env, "97");
};

const styleSectionTitleLine = (value: string, env: Record<string, string | undefined>) => {
  return styleText(value, env, "36");
};

const styleCommandToken = (value: string, env: Record<string, string | undefined>) => {
  return styleText(value, env, "96");
};

const styleCommandHintLine = (value: string, env: Record<string, string | undefined>) => {
  if (!isCliColorEnabled(env)) {
    return value;
  }

  if (value.startsWith("$ ")) {
    return `$ ${styleCommandToken(value.slice(2), env)}`;
  }

  return styleCommandToken(value, env);
};

const normalizeCharsetToken = (value: string) => {
  return value.trim().toLowerCase().replace(/[^a-z0-9]/gu, "");
};

const isUtf8CharsetToken = (value: string) => {
  return normalizeCharsetToken(value) === "utf8";
};

const looksLikeLocalePrefix = (value: string) => {
  return value === "c" || value === "posix" || /^[a-z]{2,3}(?:_[a-z0-9]+)*$/u.test(value);
};

const isUtf8Locale = (value: string) => {
  const explicitCharset = getExplicitCharsetToken(value);

  return explicitCharset ? isUtf8CharsetToken(explicitCharset) : false;
};

const getExplicitCharsetToken = (value: string) => {
  const normalized = value.trim().toLowerCase();
  const modifierIndex = normalized.indexOf("@");
  const base = modifierIndex === -1 ? normalized : normalized.slice(0, modifierIndex);

  if (base.length === 0) {
    return undefined;
  }

  const dotIndex = base.indexOf(".");

  if (dotIndex !== -1) {
    if (dotIndex === base.length - 1) {
      return undefined;
    }

    const prefix = base.slice(0, dotIndex);
    const charset = base.slice(dotIndex + 1);

    if (looksLikeLocalePrefix(prefix)) {
      return charset.length > 0 ? charset : undefined;
    }

    return base;
  }

  if (looksLikeLocalePrefix(base)) {
    return undefined;
  }

  return base;
};

const isClearlyNonUtf8Locale = (value: string) => {
  const normalized = value.trim().toLowerCase();

  if (normalized.length === 0) {
    return false;
  }

  if (normalized === "c" || normalized === "posix") {
    return true;
  }

  const explicitCharset = getExplicitCharsetToken(normalized);

  if (!explicitCharset) {
    return false;
  }

  return !isUtf8CharsetToken(explicitCharset);
};

const isWideCodePoint = (codePoint: number) => {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f)
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0x303e)
    || (codePoint >= 0x3040 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
};

const isZeroWidthCharacter = (character: string, codePoint: number) => {
  if (character === "\u200D") {
    return true;
  }

  if (
    (codePoint >= 0x00 && codePoint <= 0x1f)
    || (codePoint >= 0x7f && codePoint <= 0x9f)
  ) {
    return true;
  }

  if ((codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)) {
    return true;
  }

  return /\p{Mark}/u.test(character);
};

const getDisplayWidth = (value: string) => {
  let width = 0;

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;

    if (isZeroWidthCharacter(character, codePoint)) {
      continue;
    }

    width += isWideCodePoint(codePoint) ? 2 : 1;
  }

  return width;
};

const padLine = (value: string, width: number) => {
  const displayWidth = getDisplayWidth(value);

  if (displayWidth >= width) {
    return value;
  }

  return value + " ".repeat(width - displayWidth);
};

const renderIndentedItems = (items: string[]) => {
  return items.flatMap((item) => {
    const [firstLine = "", ...extraLines] = toRenderableLines(item);

    return [
      `  ${firstLine}`,
      ...extraLines.map((line) => `  ${line}`),
    ];
  });
};

const renderSectionLines = (
  section: PanelSection,
  env: Record<string, string | undefined>,
) => {
  switch (section.kind) {
    case "key-value":
      return renderKeyValueRows(section.rows);
    case "command-list":
      return renderCommandList(section.items, env);
    case "steps":
      return renderStepList(section.items);
    case "paths":
      return renderPathList(section.items);
    case "lines":
    case undefined:
      return section.lines.flatMap((line) => toRenderableLines(line));
  }
};

const appendSectionLines = (
  lines: string[],
  section: PanelSection | undefined,
  env: Record<string, string | undefined>,
) => {
  if (!section) {
    return;
  }

  const sectionLines = renderSectionLines(section, env);

  if (sectionLines.length === 0) {
    return;
  }

  if (lines.length > 0) {
    lines.push("");
  }

  const renderedSectionLines = section.title === "Command Hints"
    ? sectionLines.map((line) => styleCommandHintLine(line, env))
    : sectionLines;

  lines.push(
    ...toRenderableLines(section.title).map((line) => styleSectionTitleLine(line, env)),
    ...renderedSectionLines,
  );
};

const renderCliScreen = (
  options: RenderSemanticPanelOptions,
  tone: CliScreenTone,
) => {
  const lines = toRenderableLines(options.title)
    .map((line) => styleTitleLine(line, tone, options.env));

  if (options.headline) {
    lines.push(...toRenderableLines(options.headline).map((line) => styleHeadlineLine(line, options.env)));
  }

  for (const section of options.sections ?? []) {
    appendSectionLines(lines, section, options.env);
  }

  appendSectionLines(lines, renderDiagnosticsSection(options.diagnostics), options.env);

  if (options.commandHints && options.commandHints.length > 0) {
    appendSectionLines(lines, {
      title: "Command Hints",
      lines: options.commandHints.map((command) => renderCommandHint(command, options.env)),
    }, options.env);
  }

  return lines.join("\n");
};

export const detectCliCharset = (env: Record<string, string | undefined>): CliCharset => {
  if (env.CODE_HELM_CLI_ASCII === "1") {
    return "ascii";
  }

  if (env.TERM?.toLowerCase() === "dumb") {
    return "ascii";
  }

  const effectiveLocale = localeVariables
    .map((key) => env[key])
    .find((locale): locale is string => Boolean(locale && locale.trim().length > 0));

  if (!effectiveLocale) {
    return "unicode";
  }

  if (isUtf8Locale(effectiveLocale)) {
    return "unicode";
  }

  if (isClearlyNonUtf8Locale(effectiveLocale)) {
    return "ascii";
  }

  return "unicode";
};

export const renderPanelFrame = (options: RenderPanelOptions) => {
  const lines = [...toRenderableLines(options.title)];
  const contentLines = options.lines.flatMap((line) => toRenderableLines(line));

  if (contentLines.length > 0) {
    lines.push(...contentLines);
  }

  return lines.join("\n");
};

export const renderKeyValueRows = (rows: Array<{ key: string; value: string }>) => {
  const normalizedRows = rows.map((row) => ({
    key: sanitizeRenderableText(row.key),
    value: sanitizeRenderableText(row.value),
  }));
  const keyWidth = normalizedRows.reduce((max, row) => Math.max(max, getDisplayWidth(row.key)), 0);
  return normalizedRows.map((row) => `${padLine(row.key, keyWidth)}  ${row.value}`);
};

export const renderCommandList = (
  items: Array<{ command: string; description: string }>,
  env?: Record<string, string | undefined>,
) => {
  const normalizedItems = items.map((item) => ({
    command: sanitizeRenderableText(item.command),
    description: sanitizeRenderableText(item.description),
  }));
  const commandWidth = normalizedItems.reduce((max, item) => {
    return Math.max(max, getDisplayWidth(item.command));
  }, 0);

  return normalizedItems.map((item) => {
    const paddedCommand = padLine(item.command, commandWidth);

    return `${env ? styleCommandToken(paddedCommand, env) : paddedCommand}  ${item.description}`;
  });
};

export const renderStepList = (items: string[]) => {
  return renderIndentedItems(items);
};

export const renderPathList = (items: string[]) => {
  return renderIndentedItems(items);
};

export const renderDiagnosticsSection = (details?: string): PanelSection | undefined => {
  if (details === undefined || details.length === 0) {
    return undefined;
  }

  return {
    title: "Diagnostics",
    lines: splitMultiline(details).flatMap((line) => toRenderableLines(line)),
  };
};

export const renderCommandHint = (
  command: string,
  env?: Record<string, string | undefined>,
) => {
  const commandLines = toRenderableLines(command.trim());
  const [firstLine, ...extraLines] = commandLines;

  if (!firstLine) {
    return "$";
  }

  const renderedCommand = env ? styleCommandToken(firstLine, env) : firstLine;
  const renderedExtraLines = extraLines.map((line) => env ? styleCommandToken(line, env) : line);

  return [`$ ${renderedCommand}`, ...renderedExtraLines].join("\n");
};

export const renderRuntimePanel = (options: RenderSemanticPanelOptions) => {
  return renderCliScreen(options, "neutral");
};

export const renderSuccessPanel = (options: RenderSemanticPanelOptions) => {
  return renderCliScreen(options, "success");
};

export const renderWarningPanel = (options: RenderSemanticPanelOptions) => {
  return renderCliScreen(options, "warning");
};

export const renderErrorPanel = (options: RenderSemanticPanelOptions) => {
  return renderCliScreen(options, "error");
};

const looksLikeRenderedScreen = (message: string) => {
  const lines = message.split(/\r\n|\n|\r/u);

  if (lines.length < 3) {
    return false;
  }

  const hasBlankSeparator = lines.some((line, index) => {
    return sanitizeRenderableText(line).trim().length === 0 && index > 0 && index < lines.length - 1;
  });
  const hasSectionTitle = lines.some((line) => renderedSectionTitles.has(sanitizeRenderableText(line).trim()));

  return hasBlankSeparator && hasSectionTitle;
};

const isCodeHelmUsageLine = (line: string) => {
  return /^Usage:\s*code-helm(?:\s|$)/u.test(line);
};

export const renderCliCaughtError = (
  error: unknown,
  env: Record<string, string | undefined>,
  diagnostics?: string,
) => {
  const message = error instanceof Error ? error.message : String(error);

  if (looksLikeRenderedScreen(message)) {
    return message;
  }

  const trimmedMessage = message.trim();

  if (looksLikeRenderedScreen(trimmedMessage)) {
    return trimmedMessage;
  }

  const finalMessage = trimmedMessage.length > 0 ? trimmedMessage : "Unknown CLI error.";
  const messageLines = finalMessage
    .split(/\r\n|\n|\r/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const firstUsageLineIndex = messageLines.findIndex((line) => line.startsWith("Usage:"));

  if (firstUsageLineIndex >= 0) {
    const problemLines = messageLines.slice(0, firstUsageLineIndex);
    const usageLines = messageLines.slice(firstUsageLineIndex);
    const hasOnlyCodeHelmUsageLines = usageLines.length > 0
      && usageLines.every((line) => isCodeHelmUsageLine(line));

    if (!hasOnlyCodeHelmUsageLines) {
      return renderErrorPanel({
        title: "Command Failed",
        sections: [
          { title: "Problem", lines: ["Unhandled CLI error."] },
          { title: "Details", lines: [finalMessage] },
        ],
        diagnostics,
        env,
      });
    }

    const problem = problemLines.join("\n").trim() || "Invalid command arguments.";

    return renderErrorPanel({
      title: "Invalid Arguments",
      sections: [
        { title: "Problem", lines: [problem] },
        { title: "Usage", lines: usageLines },
      ],
      diagnostics,
      env,
    });
  }

  return renderErrorPanel({
    title: "Command Failed",
    sections: [
      { title: "Problem", lines: ["Unhandled CLI error."] },
      { title: "Details", lines: [finalMessage] },
    ],
    diagnostics,
    env,
  });
};
