import type { ErrorOrigin } from "@mcpjam/sdk";

/**
 * The `mcp_app.resource_read.failed` log event: an eval's widget render could
 * not read the MCP App's UI resource, so the run keeps no recorded render of
 * that App. The row carries whose fault the error is, its class and the
 * duration, never the error text. Only the hosted server sends it to Sentry,
 * and only for an error of ours. The telemetry catalog reads payloads in this
 * folder as it reads `log-events.ts`, so these fields reach the log row.
 */
export type McpAppResourceReadFailedEvent = {
  durationMs: number;
  origin: ErrorOrigin;
};
