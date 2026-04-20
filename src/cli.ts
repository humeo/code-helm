import { parseCliArgs } from "./cli/args";
import { runCliCommand } from "./cli/commands";
import { renderCliCaughtError } from "./cli/output";

const runCommand = async (command: ReturnType<typeof parseCliArgs>) => {
  const result = await runCliCommand(command, {
    env: process.env as Record<string, string | undefined>,
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
    renderCliCaughtError(error, process.env as Record<string, string | undefined>),
  );
  process.exitCode = 1;
});
