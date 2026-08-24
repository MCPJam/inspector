import { Command, CommanderError } from "commander";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import packageJson from "../package.json" with { type: "json" };
import { registerAppsCommands } from "./commands/apps.js";
import { registerCloudCommands } from "./commands/cloud.js";
import { registerCompatCommands } from "./commands/compat.js";
import { registerMcpCommands } from "./commands/mcp.js";
import { registerProtocolCommands } from "./commands/conformance.js";
import { registerConformanceRunCommand } from "./commands/conformance-run.js";
import { registerReadinessCommands } from "./commands/readiness.js";
import { registerOAuthCommands } from "./commands/oauth.js";
import { registerXaaCommands } from "./commands/xaa.js";
import { registerPromptCommands } from "./commands/prompts.js";
import { registerResourcesCommands } from "./commands/resources.js";
import { registerServerCommands } from "./commands/server.js";
import { registerSubscriptionsCommands } from "./commands/subscriptions.js";
import { registerTelemetryCommands } from "./commands/telemetry.js";
import { registerTasksCommands } from "./commands/tasks.js";
import { registerToolsCommands } from "./commands/tools.js";
import { registerInspectorCommands } from "./commands/inspector.js";
import { registerRegistryCommands } from "./commands/registry.js";
import {
  detectOutputFormatFromArgv,
  normalizeCliError,
  usageError,
  writeError,
} from "./lib/output.js";
import { addGlobalOptions } from "./lib/server-config.js";
import {
  captureCommandEvent,
  initTelemetry,
  type TelemetryOptions,
} from "./lib/telemetry.js";
import { checkForUpdates } from "./lib/update-notifier.js";

const pkgVersion = packageJson.version;

export interface CliMainResult {
  exitCode: number;
  shouldCheckForUpdates: boolean;
}

export interface CliMainDependencies {
  telemetry?: TelemetryOptions;
}

export interface CliEntrypointDependencies extends CliMainDependencies {
  checkForUpdates?: (currentVersion: string) => void;
}

export async function main(
  argv: readonly string[] = process.argv,
  dependencies: CliMainDependencies = {},
): Promise<CliMainResult> {
  // A command signals failure by setting `process.exitCode`, which this
  // function reads back below — so the channel is a GLOBAL that outlives the
  // call. Left alone, one command's exit 1 is still sitting there when the next
  // `main()` runs in the same process, and that run reports failure for work
  // that succeeded. Only the process entrypoint calls this once; tests,
  // embedders, and anything scripting the CLI in-process call it repeatedly.
  // Clearing here makes each invocation independent of whatever preceded it.
  process.exitCode = 0;

  const program = addGlobalOptions(
    new Command()
      .name("mcpjam")
      .version(pkgVersion, "-v, --version", "output the CLI version")
      .description(
        "Test, debug, and validate MCP servers locally, or manage MCPJam Cloud via `mcpjam cloud`. Health checks, OAuth conformance, tool-surface diffing, and structured triage from the terminal or CI.",
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
  const telemetry = initTelemetry(program, pkgVersion, dependencies.telemetry);

  program.commandsGroup("Local MCP testing:");
  registerServerCommands(program);
  registerToolsCommands(program);
  registerResourcesCommands(program);
  registerSubscriptionsCommands(program);
  registerCompatCommands(program);
  registerPromptCommands(program);
  registerAppsCommands(program);
  registerTasksCommands(program);
  registerOAuthCommands(program);
  registerXaaCommands(program);
  registerProtocolCommands(program);
  registerConformanceRunCommand(program);
  registerReadinessCommands(program);

  program.commandsGroup("MCPJam Cloud:");
  registerCloudCommands(program);
  registerRegistryCommands(program);

  program.commandsGroup("CLI:");
  registerInspectorCommands(program);
  registerMcpCommands(program);
  registerTelemetryCommands(program, dependencies.telemetry);

  if (argv.length <= 2) {
    program.outputHelp();
    return {
      exitCode: 0,
      shouldCheckForUpdates: false,
    };
  }

  try {
    await program.parseAsync(argv as string[]);
    const normalizedExitCode =
      typeof process.exitCode === "number" ? process.exitCode : 0;
    captureCommandEvent(
      normalizedExitCode,
      normalizedExitCode === 0 ? undefined : "UNKNOWN_ERROR",
    );
    await telemetry.flush();
    return {
      exitCode: normalizedExitCode,
      shouldCheckForUpdates: true,
    };
  } catch (error) {
    const format = detectOutputFormatFromArgv(argv);

    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version"
      ) {
        await telemetry.flush();
        return {
          exitCode: 0,
          shouldCheckForUpdates: false,
        };
      }

      writeError(usageError(error.message), format);
      captureCommandEvent(2, "USAGE_ERROR");
      await telemetry.flush();
      return {
        exitCode: 2,
        shouldCheckForUpdates: false,
      };
    }

    const normalizedError = normalizeCliError(error);
    writeError(normalizedError, format);
    captureCommandEvent(normalizedError.exitCode, normalizedError.code);
    await telemetry.flush();
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
  const result = await main(argv, dependencies);
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
