export const createRenderEnv = (
  options: {
    stdinIsTTY: boolean | undefined;
    stdoutIsTTY: boolean | undefined;
  },
  baseEnv: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
) => {
  const stdinIsTTY = options.stdinIsTTY === true;
  const stdoutIsTTY = options.stdoutIsTTY === true;

  return {
    ...baseEnv,
    CODE_HELM_CLI_IS_TTY: stdinIsTTY && stdoutIsTTY ? "1" : "0",
    CODE_HELM_CLI_STDIN_IS_TTY: stdinIsTTY ? "1" : "0",
    CODE_HELM_CLI_STDOUT_IS_TTY: stdoutIsTTY ? "1" : "0",
  };
};
