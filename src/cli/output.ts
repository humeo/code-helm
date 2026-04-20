export type CliCharset = "unicode" | "ascii";

export type PanelSection = {
  title: string;
  lines: string[];
};

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

const localeVariables = ["LC_ALL", "LC_CTYPE", "LANG"] as const;
const ansiEscapePattern = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/gu;
const tabReplacement = "  ";
const unsafeControlPattern = /[\u0000-\u0008\u000B\u000C\u000D\u000E-\u001F\u007F]/gu;

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

const isUtf8Locale = (value: string) => {
  const normalized = value.trim().toLowerCase();

  return normalized.includes("utf-8") || normalized.includes("utf8");
};

const getExplicitCharsetToken = (value: string) => {
  const normalized = value.trim().toLowerCase();
  const dotIndex = normalized.indexOf(".");

  if (dotIndex !== -1) {
    if (dotIndex === normalized.length - 1) {
      return undefined;
    }

    const charsetWithModifier = normalized.slice(dotIndex + 1);
    const modifierIndex = charsetWithModifier.indexOf("@");
    const charset = modifierIndex === -1
      ? charsetWithModifier
      : charsetWithModifier.slice(0, modifierIndex);

    return charset.length > 0 ? charset : undefined;
  }

  // Support direct charset declarations like ISO-8859-1, US-ASCII, or latin1.
  if (!normalized.includes("_") && !normalized.includes("@")) {
    return normalized;
  }

  return undefined;
};

const isExplicitNonUtf8CharsetToken = (token: string) => {
  if (token === "utf-8" || token === "utf8") {
    return false;
  }

  if (
    token === "ascii"
    || token === "us-ascii"
    || token === "latin1"
    || token === "latin-1"
  ) {
    return true;
  }

  return /^iso[-_]?8859-\d+$/u.test(token) || /^latin\d+$/u.test(token);
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

  return isExplicitNonUtf8CharsetToken(explicitCharset);
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

const createFrameChars = (charset: CliCharset) => {
  if (charset === "ascii") {
    return {
      topLeft: "+",
      topRight: "+",
      bottomLeft: "+",
      bottomRight: "+",
      horizontal: "-",
      vertical: "|",
      sectionLeft: "+",
      sectionRight: "+",
    };
  }

  return {
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    horizontal: "─",
    vertical: "│",
    sectionLeft: "├",
    sectionRight: "┤",
  };
};

const appendSectionLines = (
  lines: string[],
  section: PanelSection | undefined,
) => {
  if (!section || section.lines.length === 0) {
    return;
  }

  if (lines.length > 0) {
    lines.push("");
  }

  lines.push(
    ...toRenderableLines(section.title),
    ...section.lines.flatMap((line) => toRenderableLines(line)),
  );
};

const renderSemanticPanel = (options: RenderSemanticPanelOptions) => {
  const lines: string[] = [];

  if (options.headline) {
    lines.push(...toRenderableLines(options.headline));
  }

  for (const section of options.sections ?? []) {
    appendSectionLines(lines, section);
  }

  appendSectionLines(lines, renderDiagnosticsSection(options.diagnostics));

  if (options.commandHints && options.commandHints.length > 0) {
    appendSectionLines(lines, {
      title: "Command Hints",
      lines: options.commandHints.map((command) => renderCommandHint(command)),
    });
  }

  return renderPanelFrame({
    title: options.title,
    lines,
    env: options.env,
  });
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
  const charset = detectCliCharset(options.env);
  const chars = createFrameChars(charset);
  const titleLines = toRenderableLines(options.title);
  const sanitizedTitle = titleLines[0] ?? "";
  const sanitizedLines = [...titleLines.slice(1), ...options.lines.flatMap((line) => toRenderableLines(line))];
  const contentLines = [sanitizedTitle, ...sanitizedLines];
  const width = contentLines.reduce((max, line) => Math.max(max, getDisplayWidth(line)), 0);
  const horizontal = chars.horizontal.repeat(width + 2);

  const framedLines = [
    `${chars.topLeft}${horizontal}${chars.topRight}`,
    `${chars.vertical} ${padLine(sanitizedTitle, width)} ${chars.vertical}`,
    `${chars.sectionLeft}${horizontal}${chars.sectionRight}`,
    ...sanitizedLines.map((line) => `${chars.vertical} ${padLine(line, width)} ${chars.vertical}`),
    `${chars.bottomLeft}${horizontal}${chars.bottomRight}`,
  ];

  return framedLines.join("\n");
};

export const renderKeyValueRows = (rows: Array<{ key: string; value: string }>) => {
  const normalizedRows = rows.map((row) => ({
    key: sanitizeRenderableText(row.key),
    value: sanitizeRenderableText(row.value),
  }));
  const keyWidth = normalizedRows.reduce((max, row) => Math.max(max, getDisplayWidth(row.key)), 0);
  return normalizedRows.map((row) => `${padLine(row.key, keyWidth)} : ${row.value}`);
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

export const renderCommandHint = (command: string) => {
  const commandLines = toRenderableLines(command.trim());
  const [firstLine, ...extraLines] = commandLines;

  if (!firstLine) {
    return "$";
  }

  return [`$ ${firstLine}`, ...extraLines].join("\n");
};

export const renderRuntimePanel = (options: RenderSemanticPanelOptions) => {
  return renderSemanticPanel(options);
};

export const renderSuccessPanel = (options: RenderSemanticPanelOptions) => {
  return renderSemanticPanel(options);
};

export const renderWarningPanel = (options: RenderSemanticPanelOptions) => {
  return renderSemanticPanel(options);
};

export const renderErrorPanel = (options: RenderSemanticPanelOptions) => {
  return renderSemanticPanel(options);
};
