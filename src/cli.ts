import { parseCliArgs } from "./cli/args";
import { runCliCommand } from "./cli/commands";
import { renderCliCaughtError } from "./cli/output";

const createRenderEnv = (isTTY: boolean | undefined) => {
  return {
    ...(process.env as Record<string, string | undefined>),
    CODE_HELM_CLI_IS_TTY: isTTY ? "1" : "0",
  };
};

const runCommand = async (command: ReturnType<typeof parseCliArgs>) => {
  const result = await runCliCommand(command, {
    env: createRenderEnv(process.stdout.isTTY),
    emitOutput: (output) => console.log(output),
  });

  if (result.output.trim().length > 0) {
    console.log(result.output);
  }
};

const main = async () => {
  const command = parseCliArgs(process.argv.slice(2));
  await runCommand(command);
};

void main().catch((error: unknown) => {
  console.error(
    renderCliCaughtError(error, createRenderEnv(process.stderr.isTTY)),
  );
  process.exitCode = 1;
});
