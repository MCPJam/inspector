import { Command, CommanderError } from "commander";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import { registerAppsCommands } from "./commands/apps.js";
import { registerProtocolCommands } from "./commands/conformance.js";
import { registerOAuthCommands } from "./commands/oauth.js";
import { registerPromptCommands } from "./commands/prompts.js";
import { registerResourcesCommands } from "./commands/resources.js";
import { registerServerCommands } from "./commands/server.js";
import { registerToolsCommands } from "./commands/tools.js";
import { registerInspectorCommands } from "./commands/inspector.js";
import {
  detectOutputFormatFromArgv,
  normalizeCliError,
  usageError,
  writeError,
} from "./lib/output.js";
import { addGlobalOptions } from "./lib/server-config.js";
import { checkForUpdates } from "./lib/update-notifier.js";

const pkgVersion = packageJson.version;

export interface CliMainResult {
  exitCode: number;
  shouldCheckForUpdates: boolean;
}

export interface CliEntrypointDependencies {
  checkForUpdates?: (currentVersion: string) => void;
}

export async function main(
  argv: readonly string[] = process.argv,
): Promise<CliMainResult> {
  const program = addGlobalOptions(
    new Command()
      .name("mcpjam")
      .version(pkgVersion, "-v, --version", "output the CLI version")
      .description(
        "Test, debug, and validate MCP servers. Health checks, OAuth conformance, tool-surface diffing, and structured triage from the terminal or CI.",
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
  registerAppsCommands(program);
  registerOAuthCommands(program);
  registerProtocolCommands(program);
  registerInspectorCommands(program);

  if (argv.length <= 2) {
    program.outputHelp();
    return {
      exitCode: 0,
      shouldCheckForUpdates: false,
    };
  }

  try {
    await program.parseAsync(argv as string[]);
    const exitCode = process.exitCode;
    if (typeof exitCode === "number") {
      return {
        exitCode,
        shouldCheckForUpdates: true,
      };
    }

    return {
      exitCode: Number(exitCode ?? 0) || 0,
      shouldCheckForUpdates: true,
    };
  } catch (error) {
    const format = detectOutputFormatFromArgv(argv);

    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version"
      ) {
        return {
          exitCode: 0,
          shouldCheckForUpdates: false,
        };
      }

      writeError(usageError(error.message), format);
      return {
        exitCode: 2,
        shouldCheckForUpdates: false,
      };
    }

    const normalizedError = normalizeCliError(error);
    writeError(normalizedError, format);
    return {
      exitCode: normalizedError.exitCode,
      shouldCheckForUpdates: false,
    };
  }
}

export async function runCliEntrypoint(
  argv: readonly string[] = process.argv,
  dependencies: CliEntrypointDependencies = {},
): Promise<CliMainResult> {
  const result = await main(argv);
  process.exitCode = result.exitCode;

  if (result.exitCode === 0 && result.shouldCheckForUpdates) {
    (dependencies.checkForUpdates ?? checkForUpdates)(pkgVersion);
  }

  return result;
}

export function isDirectRun(
  importMetaUrl: string,
  argv: readonly string[] = process.argv,
): boolean {
  const entrypoint = argv[1];
  if (!entrypoint) {
    return false;
  }

  const entrypointUrl = pathToFileURL(entrypoint).href;
  if (importMetaUrl === entrypointUrl) {
    return true;
  }

  try {
    return importMetaUrl === pathToFileURL(realpathSync(entrypoint)).href;
  } catch {
    // If realpath resolution fails, fall back to the direct path comparison above.
    return false;
  }
}

if (isDirectRun(import.meta.url)) {
  void runCliEntrypoint();
}
