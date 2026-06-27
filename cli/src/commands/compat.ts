import { Command } from "commander";
import { listTools, readResource } from "@mcpjam/sdk";
import {
  evaluateMarketHosts,
  scanWidgetUsage,
  type HostCompatToolsInput,
  type ReadResourceResult,
} from "@mcpjam/sdk/host-compat";
import { withEphemeralManager } from "../lib/ephemeral.js";
import {
  addRetryOptions,
  addSharedServerOptions,
  describeTarget,
  getGlobalOptions,
  parseRetryPolicy,
  parseServerConfig,
} from "../lib/server-config.js";
import { writeResult } from "../lib/output.js";

export function registerCompatCommands(program: Command): void {
  addRetryOptions(
    addSharedServerOptions(
      program
        .command("compat")
        .description(
          "Check whether an MCP server's tools and widgets work on each AI host (Claude, ChatGPT, Cursor, Copilot, Codex, Goose, …)",
        )
        .option(
          "--host <id>",
          "Only report this host id. Repeat for several. Default: all.",
          (value: string, previous: string[] = []) => [...previous, value],
          [],
        ),
    ),
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const retryPolicy = parseRetryPolicy(options);
    const config = parseServerConfig({
      ...options,
      timeout: globalOptions.timeout,
    });

    const result = await withEphemeralManager(
      config,
      async (manager, serverId) => {
        // Gather every tool (with its inline `_meta`) across all pages.
        const tools: Array<{ name: string; _meta?: Record<string, unknown> }> =
          [];
        let cursor: string | undefined;
        for (let page = 0; page < 50; page++) {
          const result = await listTools(manager, { serverId, cursor });
          tools.push(
            ...(result.tools as Array<{
              name: string;
              _meta?: Record<string, unknown>;
            }>),
          );
          cursor = result.nextCursor;
          if (!cursor) break;
        }
        const toolsData: HostCompatToolsInput = { tools };

        // Apps lane: read each widget's resource through the live connection
        // and scan it for the host APIs it uses.
        const widgetUsage = await scanWidgetUsage(toolsData, async (uri) => {
          // The SDK helper wraps the MCP read as `{ content }`; scanWidgetUsage
          // wants the inner result (with `contents`).
          const { content } = await readResource(manager, { serverId, uri });
          return content as ReadResourceResult;
        });

        const { requirements, reports } = evaluateMarketHosts(toolsData, {
          widgetUsage,
        });

        const hostFilter = new Set(options.host as string[]);
        const hosts = (
          hostFilter.size > 0
            ? reports.filter((r) => hostFilter.has(r.hostId))
            : reports
        ).map((r) => ({
          hostId: r.hostId,
          hostLabel: r.hostLabel,
          verdict: r.verdict,
          provenance: r.provenance,
          findings: r.findings,
        }));

        const summary = { works: 0, degraded: 0, blocked: 0, unknown: 0 };
        for (const h of hosts) summary[h.verdict] += 1;

        return {
          target: describeTarget(options),
          widgets: {
            total:
              requirements.widgets.mcpAppsOnly.length +
              requirements.widgets.openaiAppsOnly.length +
              requirements.widgets.dual.length,
            appOnly: requirements.appOnlyWidgets.length,
          },
          unknownDimensions: requirements.unknownDimensions,
          summary,
          hosts,
        };
      },
      {
        timeout: globalOptions.timeout,
        retryPolicy,
      },
    );

    writeResult(result, globalOptions.format);
  });
}
