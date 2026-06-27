import { Command } from "commander";
import { listTools, readResource } from "@mcpjam/sdk";
import {
  buildMarketHostProfiles,
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
import { usageError, writeResult } from "../lib/output.js";

// Cap pagination so a pathological server can't loop forever; flag truncation
// rather than silently dropping later tools.
const TOOLS_PAGE_CAP = 50;

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

    // Validate --host up front (before connecting) so a typo fails fast with the
    // valid ids, instead of silently returning an empty report.
    const validHostIds = buildMarketHostProfiles().map((p) => p.id);
    const requestedHosts = options.host as string[];
    const unknownHosts = requestedHosts.filter(
      (id) => !validHostIds.includes(id),
    );
    if (unknownHosts.length > 0) {
      throw usageError(
        `Unknown host id${unknownHosts.length === 1 ? "" : "s"}: ${unknownHosts.join(
          ", ",
        )}. Valid: ${validHostIds.join(", ")}`,
      );
    }

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
        let truncated = false;
        for (let page = 0; page < TOOLS_PAGE_CAP; page++) {
          const result = await listTools(manager, { serverId, cursor });
          tools.push(
            ...(result.tools as Array<{
              name: string;
              _meta?: Record<string, unknown>;
            }>),
          );
          cursor = result.nextCursor;
          if (!cursor) break;
          // Cap hit with tools still pending — flag rather than drop them.
          if (page === TOOLS_PAGE_CAP - 1) truncated = true;
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

        // `toolsTruncated` makes the engine demote any `works` to `unknown` and
        // record why — so the summary below (and each verdict) reflects the
        // incomplete tool list, not just a top-level warning.
        const { requirements, reports } = evaluateMarketHosts(toolsData, {
          widgetUsage,
          toolsTruncated: truncated,
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
