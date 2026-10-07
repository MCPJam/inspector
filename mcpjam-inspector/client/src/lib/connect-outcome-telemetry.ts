/**
 * One `server_connect_outcome` event per finished connect attempt.
 *
 * `connecting_server` records a click on Connect; nothing recorded how the
 * attempt ended, so connect failures could only be counted by watching replays.
 * Every connect, reconnect and OAuth completion ends in a `CONNECT_SUCCESS` or
 * `CONNECT_FAILURE` dispatch, so wrapping `dispatch` once covers them all
 * without touching the call sites. The reducer is the wrong place: it must stay
 * pure, and StrictMode runs it twice.
 *
 * Cheap on purpose: one `track` (synchronous, batched by posthog-js) at the END
 * of an attempt, and a map entry per server in between. Flat properties only —
 * never a server name, URL or error text.
 */
import type { Dispatch } from "react";
import type { AppAction } from "@/state/app-types";
import type { MCPServerConfig } from "@mcpjam/sdk/browser";
import { track } from "@/lib/analytics";
import { HOSTED_MODE } from "@/lib/config";
import { OAUTH_AUTHORIZATION_CANCELLED_MESSAGE } from "@/lib/hosted-oauth-resume";

export type ConnectOutcome = "success" | "failure" | "timeout" | "cancelled";
type ConnectFlow = "connect" | "reconnect" | "background";

type PendingAttempt = {
  flow: Exclude<ConnectFlow, "background">;
  startedAt: number;
  transport: "http" | "stdio";
};

const TIMEOUT_SLUGS = new Set([
  "transport/etimedout",
  "jsonrpc/request_timeout",
]);
// The client's own connect deadline (`state/mcp-api.ts`,
// `lib/apis/web/servers-api.ts`), which reaches here only as text.
const CLIENT_TIMEOUT = /^Connection attempt timed out\b/;
// The Auto-OAuth prompt the user said no to.
const DECLINED_AUTHORIZATION =
  /requires authorization\. Reconnect to sign in with OAuth\.$/;

function transportOf(config: MCPServerConfig | undefined): "http" | "stdio" {
  return config && "url" in config && config.url ? "http" : "stdio";
}

/** How a failed attempt ended, from what the failure action carries. */
export function classifyConnectFailure(
  action: Extract<AppAction, { type: "CONNECT_FAILURE" }>,
): Exclude<ConnectOutcome, "success"> {
  const error = action.error ?? "";
  if (
    error === OAUTH_AUTHORIZATION_CANCELLED_MESSAGE ||
    DECLINED_AUTHORIZATION.test(error)
  )
    return "cancelled";
  if (
    (action.normalized?.slug && TIMEOUT_SLUGS.has(action.normalized.slug)) ||
    CLIENT_TIMEOUT.test(error)
  )
    return "timeout";
  return "failure";
}

export function createConnectOutcomeTracker(now: () => number = Date.now) {
  const pending = new Map<string, PendingAttempt>();

  function observe(action: AppAction): void {
    switch (action.type) {
      case "CONNECT_REQUEST":
      case "RECONNECT_REQUEST":
        pending.set(action.name, {
          flow: action.type === "CONNECT_REQUEST" ? "connect" : "reconnect",
          startedAt: now(),
          transport: transportOf(action.config),
        });
        return;
      case "CONNECT_SUCCESS":
      case "CONNECT_FAILURE": {
        const attempt = pending.get(action.name);
        pending.delete(action.name);
        const isSuccess = action.type === "CONNECT_SUCCESS";
        const rawCode = isSuccess ? undefined : action.normalized?.rawCode;
        track("server_connect_outcome", {
          outcome: isSuccess ? "success" : classifyConnectFailure(action),
          flow: attempt?.flow ?? "background",
          hosted: HOSTED_MODE,
          transport: isSuccess
            ? transportOf(action.config)
            : (attempt?.transport ?? null),
          ...(isSuccess && action.useOAuth !== undefined
            ? { auth: action.useOAuth ? "oauth" : "other" }
            : {}),
          ...(!isSuccess && action.normalized?.slug
            ? { error_slug: action.normalized.slug }
            : {}),
          ...(typeof rawCode === "number" ? { http_status: rawCode } : {}),
          ...(attempt ? { duration_ms: now() - attempt.startedAt } : {}),
        });
        return;
      }
      default:
        return;
    }
  }

  return {
    observe,
    wrapDispatch(dispatch: Dispatch<AppAction>): Dispatch<AppAction> {
      return (action) => {
        dispatch(action);
        try {
          observe(action);
        } catch {
          // Telemetry never breaks a connect.
        }
      };
    },
  };
}

/**
 * The app's one tracker. Shared so an outcome dispatched outside
 * `useServerState` (the hosted OAuth back-navigation cancel in
 * `use-app-state.ts`) closes the same attempt the hook opened.
 */
export const connectOutcomeTracker = createConnectOutcomeTracker();
