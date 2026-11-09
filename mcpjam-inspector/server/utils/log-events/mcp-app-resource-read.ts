/**
 * The `mcp_app.resource_read.failed` log event: an eval's widget render could
 * not read the MCP App's UI resource, so the run keeps no recorded render of
 * that App. Emitted by the hosted server only, with Sentry on: a local install
 * would report its user's server. The telemetry catalog reads payloads in
 * this folder as it reads `log-events.ts`, so this field reaches the log row.
 */
export type McpAppResourceReadFailedEvent = {
  durationMs: number;
};
