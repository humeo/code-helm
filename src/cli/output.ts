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
  return value
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
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

const padLine = (value: string, width: number) => {
  if (value.length >= width) {
    return value;
  }

  return value + " ".repeat(width - value.length);
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

  for (const key of localeVariables) {
    const locale = env[key];

    if (!locale) {
      continue;
    }

    if (isUtf8Locale(locale)) {
      return "unicode";
    }

    if (isClearlyNonUtf8Locale(locale)) {
      return "ascii";
    }
  }

  return "unicode";
};

export const renderPanelFrame = (options: RenderPanelOptions) => {
  const charset = detectCliCharset(options.env);
  const chars = createFrameChars(charset);
  const contentLines = [options.title, ...options.lines];
  const width = contentLines.reduce((max, line) => Math.max(max, line.length), 0);
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
  const keyWidth = rows.reduce((max, row) => Math.max(max, row.key.length), 0);
  return rows.map((row) => `${row.key.padEnd(keyWidth)} : ${row.value}`);
};

export const renderDiagnosticsSection = (details?: string): PanelSection | undefined => {
  const trimmed = details?.trim();

  if (!trimmed) {
    return undefined;
  }

  return {
    title: "Diagnostics",
    lines: splitMultiline(trimmed),
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
