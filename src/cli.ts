import { parseCliArgs } from "./cli/args";
import { runCliCommand } from "./cli/commands";
import { renderCliCaughtError } from "./cli/output";
import { createRenderEnv } from "./cli/render-env";

const runCommand = async (command: ReturnType<typeof parseCliArgs>) => {
  const result = await runCliCommand(command, {
    env: createRenderEnv({
      stdinIsTTY: process.stdin.isTTY,
      stdoutIsTTY: process.stdout.isTTY,
    }),
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
    renderCliCaughtError(
      error,
      createRenderEnv({
        stdinIsTTY: process.stdin.isTTY,
        stdoutIsTTY: process.stderr.isTTY,
      }),
    ),
  );
  process.exitCode = 1;
});
