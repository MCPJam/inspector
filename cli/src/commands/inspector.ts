import { Command } from "commander";
import {
  buildInspectorUrl,
  ensureInspector,
  normalizeInspectorBaseUrl,
} from "../lib/inspector-api.js";
import { getGlobalOptions } from "../lib/server-config.js";
import { writeResult } from "../lib/output.js";

export function registerInspectorCommands(program: Command): void {
  const inspector = program
    .command("inspector")
    .description("Start or attach to the local MCPJam Inspector");

  inspector
    .command("open")
    .description("Start or attach to the local Inspector and open the UI")
    .option("--inspector-url <url>", "Local Inspector base URL")
    .option("--tab <tab>", "Open the Inspector on a specific tab")
    .action(async (options, command) => {
      const globalOptions = getGlobalOptions(command);
      const baseUrl = normalizeInspectorBaseUrl(
        typeof options.inspectorUrl === "string"
          ? options.inspectorUrl
          : undefined,
      );
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
          url: buildInspectorUrl(result.baseUrl, tab),
          ...(tab ? { tab } : {}),
        },
        globalOptions.format,
      );
    });
}
