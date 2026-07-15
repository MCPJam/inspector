import { Command } from "commander";
import { listTools, readResource } from "@mcpjam/sdk";
import {
  buildHostProfilesFromCatalog,
  buildMarketHostProfiles,
  evaluateMarketHosts,
  fetchHostCompatCatalog,
  scanWidgetUsage,
  type FetchHostCompatCatalogResult,
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

// Live host-catalog fetch budget. Short and silent: a slow/unreachable
// catalog must never delay or fail a compat run — the bundled catalog is
// always a correct (if possibly staler) fallback.
const CATALOG_FETCH_TIMEOUT_MS = 2_500;

/**
 * Live catalog fetch — never throws, never authenticates. `--offline` skips
 * the fetch entirely (zero MCPJam network); any failure silently falls back
 * to the SDK's bundled catalog.
 */
async function resolveHostCatalog(options: {
  offline?: boolean;
  catalogUrl?: string;
}): Promise<FetchHostCompatCatalogResult | null> {
  if (options.offline) return null;
  return fetchHostCompatCatalog({
    baseUrl: options.catalogUrl,
    timeoutMs: CATALOG_FETCH_TIMEOUT_MS,
  });
}

export function registerCompatCommands(program: Command): void {
  addRetryOptions(
    addSharedServerOptions(
      program
        .command("compat")
        .description(
          "Check whether an MCP server's tools and widgets work on each AI host (Claude, ChatGPT, Cursor, Copilot, Codex, Goose, …)"
        )
        .option(
          "--host <id>",
          "Only report this host id. Repeat for several. Default: all.",
          (value: string, previous: string[] = []) => [...previous, value],
          []
        )
        .option(
          "--offline",
          "Skip the live host-catalog fetch and use the bundled catalog (zero MCPJam network)."
        )
        .option(
          "--catalog-url <url>",
          "Base URL to fetch the live host catalog from. Default: the hosted MCPJam API."
        )
    )
  ).action(async (options, command) => {
    const globalOptions = getGlobalOptions(command);
    const retryPolicy = parseRetryPolicy(options);

    // Live catalog (unless --offline); silent bundled fallback on any failure.
    // A successful fetch can still carry `source: "bundled"` (the proxy served
    // its own bundled fallback) — that's the same data the SDK already bundles,
    // so treat only a `source: "live"` result as live for both the profiles and
    // the reported provenance.
    const catalogResult = await resolveHostCatalog(options);
    const liveCatalog =
      catalogResult?.ok && catalogResult.source === "live"
        ? catalogResult.catalog
        : undefined;
    const catalogSource = liveCatalog ? "live" : "bundled";

    // Validate --host up front (before connecting) so a typo fails fast with the
    // valid ids, instead of silently returning an empty report. Ids come from
    // the same catalog the verdicts will use — a host that only exists in the
    // live catalog is addressable the moment it's published.
    const validHostIds = (
      liveCatalog
        ? buildHostProfilesFromCatalog(liveCatalog)
        : buildMarketHostProfiles()
    ).map((p) => p.id);
    const requestedHosts = options.host as string[];
    const unknownHosts = requestedHosts.filter(
      (id) => !validHostIds.includes(id)
    );
    if (unknownHosts.length > 0) {
      throw usageError(
        `Unknown host id${
          unknownHosts.length === 1 ? "" : "s"
        }: ${unknownHosts.join(", ")}. Valid: ${validHostIds.join(", ")}`
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
            }>)
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
          catalog: liveCatalog,
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
          catalogSource,
          // Always present for a stable contract: the backend publish version
          // when live, else 0 (the "not a backend publish" sentinel) for the
          // bundled/offline fallback.
          catalogVersion:
            liveCatalog && catalogResult?.ok ? catalogResult.version : 0,
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
      }
    );

    // One dim status line on stderr (stdout stays pure result) so a human
    // knows which catalog produced these verdicts. Gated behind --quiet like
    // every other command's progress output.
    if (!globalOptions.quiet) {
      const catalogNote =
        liveCatalog && catalogResult?.ok
          ? `host catalog: live v${catalogResult.version}`
          : `host catalog: bundled${options.offline ? " (--offline)" : ""}`;
      process.stderr.write(`\x1b[2m${catalogNote}\x1b[0m\n`);
    }

    writeResult(result, globalOptions.format);
  });
}
