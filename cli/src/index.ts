import { Command, CommanderError } from "commander";
import { registerProtocolCommands } from "./commands/conformance";
import { registerOAuthCommands } from "./commands/oauth";
import { registerPromptCommands } from "./commands/prompts";
import { registerResourcesCommands } from "./commands/resources";
import { registerServerCommands } from "./commands/server";
import { registerToolsCommands } from "./commands/tools";
import {
  CliError,
  detectOutputFormatFromArgv,
  usageError,
  writeError,
} from "./lib/output";
import { addGlobalOptions } from "./lib/server-config";

async function main(argv: readonly string[] = process.argv): Promise<number> {
  const program = addGlobalOptions(
    new Command()
      .name("mcpjam")
      .description(
        "Stateless MCP inspection and OAuth conformance commands backed by @mcpjam/sdk",
      )
      .allowExcessArguments(false)
      .exitOverride()
      .configureOutput({
        writeOut: (value) => process.stdout.write(value),
        writeErr: () => {
          // Usage errors are emitted as structured JSON in the catch block.
        },
      }),
  );

  registerServerCommands(program);
  registerToolsCommands(program);
  registerResourcesCommands(program);
  registerPromptCommands(program);
  registerOAuthCommands(program);
  registerProtocolCommands(program);

  if (argv.length <= 2) {
    program.outputHelp();
    return 0;
  }

  try {
    await program.parseAsync(argv as string[]);
    const exitCode = process.exitCode;
    if (typeof exitCode === "number") {
      return exitCode;
    }

    return Number(exitCode ?? 0) || 0;
  } catch (error) {
    const format = detectOutputFormatFromArgv(argv);

    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version"
      ) {
        return 0;
      }

      writeError(usageError(error.message), format);
      return 2;
    }

    writeError(error, format);
    return error instanceof CliError ? error.exitCode : 1;
  }
}

void main().then((exitCode) => {
  process.exitCode = exitCode;
});
