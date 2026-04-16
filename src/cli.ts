import { parseCliArgs } from "./cli/args";
import { runCliCommand } from "./cli/commands";

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
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
