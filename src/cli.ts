import { parseCliArgs } from "./cli/args";

const runCommand = async (_command: ReturnType<typeof parseCliArgs>) => {
  throw new Error("not implemented");
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
