/**
 * Environment for the inspector's MCP Events services (contracts C5–C7,
 * `docs/plans/mcp-events-contracts.md`).
 *
 * Every secret here is read at call time, never cached at import, so a test
 * (or a rotated deployment secret) takes effect without a module reload. None
 * of these values is ever logged.
 *
 * | Variable | Used by | Meaning |
 * |---|---|---|
 * | `EVENTS_INBOX_URL` | inbox client, viewer token | Public origin of the inbox Worker. Default `https://hooks.mcpjam.com`. |
 * | `EVENTS_INBOX_ADMIN_TOKEN` | inbox client | `x-events-inbox-admin-token` for the C5 admin API. |
 * | `EVENTS_INBOX_VIEWER_KEY` | viewer token | HMAC key for feed viewer tokens (C7). The Worker verifies with the same key. |
 * | `EVENTS_INBOX_DISPATCH_TOKEN` | `/api/internal/events/enqueue` | `x-events-inbox-token` the Worker's dispatch alarm presents. |
 * | `EVENTS_KEEPER_ENABLED` | server/index.ts | `"1"` starts the hosted subscription keeper. |
 * | `EVENTS_EXECUTOR_ENABLED` | server/index.ts | `"1"` starts the event-job executor. |
 */

export const DEFAULT_EVENTS_INBOX_URL = "https://hooks.mcpjam.com";

/** Header the inbox admin API authenticates with (C5). */
export const EVENTS_INBOX_ADMIN_TOKEN_HEADER = "x-events-inbox-admin-token";

/** Header the inbox's dispatch alarm presents on enqueue (C5). */
export const EVENTS_INBOX_DISPATCH_TOKEN_HEADER = "x-events-inbox-token";

function trimmed(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}

export function getEventsInboxUrl(): string {
  return (trimmed(process.env.EVENTS_INBOX_URL) ?? DEFAULT_EVENTS_INBOX_URL).replace(
    /\/+$/,
    "",
  );
}

export function getEventsInboxAdminToken(): string | undefined {
  return trimmed(process.env.EVENTS_INBOX_ADMIN_TOKEN);
}

export function getEventsInboxViewerKey(): string | undefined {
  return trimmed(process.env.EVENTS_INBOX_VIEWER_KEY);
}

export function getEventsInboxDispatchToken(): string | undefined {
  return trimmed(process.env.EVENTS_INBOX_DISPATCH_TOKEN);
}

export function isEventsKeeperEnabled(): boolean {
  return process.env.EVENTS_KEEPER_ENABLED === "1";
}

export function isEventsExecutorEnabled(): boolean {
  return process.env.EVENTS_EXECUTOR_ENABLED === "1";
}

/** `inspector-<replica>` — the lease holder name both workers claim with. */
export function defaultEventsHolder(prefix: string): string {
  return `${prefix}-${process.env.RAILWAY_REPLICA_ID ?? process.pid}`;
}
