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

const splitMultiline = (value: string) => {
  return value.split(/\r?\n/u);
};

const isUtf8Locale = (value: string) => {
  const normalized = value.trim().toLowerCase();

  return normalized.includes("utf-8") || normalized.includes("utf8");
};

const isClearlyNonUtf8Locale = (value: string) => {
  const normalized = value.trim().toLowerCase();

  if (normalized.length === 0) {
    return false;
  }

  if (normalized === "c" || normalized === "posix") {
    return true;
  }

  return !isUtf8Locale(normalized);
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

  lines.push(section.title, ...section.lines);
};

const renderSemanticPanel = (options: RenderSemanticPanelOptions) => {
  const lines: string[] = [];

  if (options.headline) {
    lines.push(options.headline);
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

  const locales = localeVariables
    .map((key) => env[key])
    .filter((locale): locale is string => Boolean(locale));

  if (locales.some((locale) => isUtf8Locale(locale))) {
    return "unicode";
  }

  if (locales.some((locale) => isClearlyNonUtf8Locale(locale))) {
    return "ascii";
  }

  return "unicode";
};

export const renderPanelFrame = (options: RenderPanelOptions) => {
  const charset = detectCliCharset(options.env);
  const chars = createFrameChars(charset);
  const contentLines = [options.title, ...options.lines];
  const width = contentLines.reduce((max, line) => Math.max(max, getDisplayWidth(line)), 0);
  const horizontal = chars.horizontal.repeat(width + 2);

  const framedLines = [
    `${chars.topLeft}${horizontal}${chars.topRight}`,
    `${chars.vertical} ${padLine(options.title, width)} ${chars.vertical}`,
    `${chars.sectionLeft}${horizontal}${chars.sectionRight}`,
    ...options.lines.map((line) => `${chars.vertical} ${padLine(line, width)} ${chars.vertical}`),
    `${chars.bottomLeft}${horizontal}${chars.bottomRight}`,
  ];

  return framedLines.join("\n");
};

export const renderKeyValueRows = (rows: Array<{ key: string; value: string }>) => {
  const keyWidth = rows.reduce((max, row) => Math.max(max, getDisplayWidth(row.key)), 0);
  return rows.map((row) => `${padLine(row.key, keyWidth)} : ${row.value}`);
};

export const renderDiagnosticsSection = (details?: string): PanelSection | undefined => {
  if (details === undefined || details.length === 0) {
    return undefined;
  }

  return {
    title: "Diagnostics",
    lines: splitMultiline(details),
  };
};

export const renderCommandHint = (command: string) => {
  return `$ ${command.trim()}`;
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
