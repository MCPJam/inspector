/**
 * Dual-era logging fixture.
 *
 * Extends the base dual-era idea (`dual-era-fixture.ts`) with a single
 * `emit-log` tool that streams `notifications/message` records at several
 * severities. It is the server-side counterpart to MCPJam's one-concept,
 * two-delivery logging model:
 *
 *   - **Modern (2026-07-28):** there is no session to carry a level, so the
 *     client rides its opt-in on every request as `_meta[LOG_LEVEL_META_KEY]`.
 *     The SDK lifts that reserved key into `ctx.mcpReq.envelope`, keyed by the
 *     full `LOG_LEVEL_META_KEY` string. When present, the handler filters the
 *     records it emits to that level and above — proving the injected level
 *     actually reached the server. Records are streamed via `ctx.mcpReq.notify`
 *     so they ride the ORIGINATING request's response stream (no session, no
 *     separate GET channel).
 *
 *   - **Legacy (2025-era):** requests carry no `_meta` envelope, so
 *     `ctx.mcpReq.envelope` is absent. The handler streams every severity via
 *     the same `notify` seam (the level was set once on connect via
 *     `logging/setLevel`; this fixture does not re-filter it server-side).
 *
 * Every era emits at least one record, so `MCPClientManager.onLogMessage`
 * receives notifications on both.
 */

import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  LOG_LEVEL_META_KEY,
  type LoggingLevel,
} from "@modelcontextprotocol/server";

export const LOGGING_FIXTURE_SERVER_INFO = {
  name: "mcpjam-logging-fixture",
  version: "1.0.0",
} as const;

export const EMIT_LOG_TOOL_NAME = "emit-log";

/**
 * The severities the `emit-log` tool walks, low→high. A modern opt-in level of
 * `warning` therefore drops `debug`/`info` and keeps `warning`/`error`.
 */
export const EMITTED_SEVERITIES: readonly LoggingLevel[] = [
  "debug",
  "info",
  "warning",
  "error",
] as const;

/** RFC 5424 severity ranking (lower = less severe), per MCP `LoggingLevel`. */
const SEVERITY_RANK: Record<LoggingLevel, number> = {
  debug: 0,
  info: 1,
  notice: 2,
  warning: 3,
  error: 4,
  critical: 5,
  alert: 6,
  emergency: 7,
};

/** Whether `level` is at least as severe as `threshold`. */
function atLeast(level: LoggingLevel, threshold: LoggingLevel): boolean {
  return SEVERITY_RANK[level] >= SEVERITY_RANK[threshold];
}

/**
 * Build a fresh logging fixture server. `createMcpHandler` calls this per
 * request, so it must be side-effect-free and register the same surface each
 * time.
 */
export function buildLoggingFixtureServer(): McpServer {
  const server = new McpServer(LOGGING_FIXTURE_SERVER_INFO, {
    // `logging` is what the manager's auto-`setLoggingLevel("debug")` gate keys
    // on; advertise it so the legacy path fires `logging/setLevel` on connect.
    capabilities: { tools: {}, logging: {} },
  });

  server.registerTool(
    EMIT_LOG_TOOL_NAME,
    {
      description:
        "Streams notifications/message records at several severities. On the " +
        "modern era, filters to the request's opt-in log level when present.",
      inputSchema: {},
    },
    async (_args, ctx) => {
      // The reserved `_meta` envelope only exists on the modern era; the SDK
      // lifts `LOG_LEVEL_META_KEY` into it keyed by the full string.
      const envelope = ctx.mcpReq.envelope as
        | Record<string, unknown>
        | undefined;
      const requested = envelope?.[LOG_LEVEL_META_KEY] as
        | LoggingLevel
        | undefined;

      for (const level of EMITTED_SEVERITIES) {
        // Modern opt-in: emit only records at or above the requested level.
        // Absent opt-in (modern opt-out or legacy): emit every severity.
        if (requested !== undefined && !atLeast(level, requested)) {
          continue;
        }
        // `notify` ties the notification to the current request so it rides the
        // originating response stream — no session channel required.
        await ctx.mcpReq.notify({
          method: "notifications/message",
          params: {
            level,
            logger: EMIT_LOG_TOOL_NAME,
            data: { text: `log:${level}` },
          },
        });
      }

      return {
        content: [
          {
            type: "text" as const,
            text: requested
              ? `emitted (filtered ≥ ${requested})`
              : "emitted (all)",
          },
        ],
      };
    },
  );

  return server;
}

/**
 * A `createMcpHandler` bound to the logging fixture. Serves the modern era
 * and, by default, the legacy-stateless era. Drive it with
 * `handler.fetch(request)` in-process, or over a loopback port via
 * `toNodeHandler`.
 */
export function createLoggingFixtureHandler() {
  return createMcpHandler(buildLoggingFixtureServer);
}
