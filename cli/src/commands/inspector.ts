import { Command } from "commander";
import {
  ensureInspector,
  normalizeInspectorBaseUrl,
  stopInspector,
} from "../lib/inspector-api.js";
import { getGlobalOptions } from "../lib/server-config.js";
import { writeResult } from "../lib/output.js";

function addInspectorUrlOption(command: Command): Command {
  return command.option("--inspector-url <url>", "Local Inspector base URL");
}

function resolveInspectorBaseUrl(options: { inspectorUrl?: unknown }): string {
  return normalizeInspectorBaseUrl(
    typeof options.inspectorUrl === "string" ? options.inspectorUrl : undefined,
  );
}

export function registerInspectorCommands(program: Command): void {
  const inspector = program
    .command("inspector")
    .description("Start or attach to the local MCPJam Inspector");

  addInspectorUrlOption(
    inspector
      .command("open")
      .description("Start or attach to the local Inspector and open the UI"),
  )
    .option("--tab <tab>", "Open the Inspector on a specific tab")
    .action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);
      const baseUrl = resolveInspectorBaseUrl(options);
      const tab =
        typeof options.tab === "string" && options.tab.trim().length > 0
          ? options.tab.trim()
          : undefined;
      const result = await ensureInspector({
        baseUrl,
        openBrowser: true,
        startIfNeeded: true,
        tab,
        timeoutMs: globalOptions.timeout,
      });

      writeResult(
        {
          success: true,
          started: result.started,
          baseUrl: result.baseUrl,
          ...(result.frontendUrl ? { frontendUrl: result.frontendUrl } : {}),
          url: result.url,
          ...(tab ? { tab } : {}),
        },
        globalOptions.format,
      );
    });

  addInspectorUrlOption(
    inspector
      .command("start")
      .description(
        "Start the local Inspector in the background without opening a browser",
      ),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const baseUrl = resolveInspectorBaseUrl(options);
    const result = await ensureInspector({
      baseUrl,
      openBrowser: false,
      startIfNeeded: true,
      timeoutMs: globalOptions.timeout,
    });

    writeResult(
      {
        success: true,
        started: result.started,
        baseUrl: result.baseUrl,
      },
      globalOptions.format,
    );
  });

  addInspectorUrlOption(
    inspector
      .command("stop")
      .description("Stop the local Inspector if it is running"),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const baseUrl = resolveInspectorBaseUrl(options);
    const result = await stopInspector(baseUrl);

    writeResult(
      {
        success: true,
        stopped: result.stopped,
        baseUrl: result.baseUrl,
      },
      globalOptions.format,
    );
  });
}
