/**
 * The state a conformance run reports per suite, and what a run covers.
 * Split from `use-conformance-run` so the hook file holds only the run;
 * the hook re-exports everything here, so importers keep one path.
 */

import type {
  MCPAppsCheckId,
  MCPCheckId,
  MCPConformanceResult,
  MCPAppsConformanceResult,
  MCPTasksCheckId,
  MCPTasksConformanceResult,
} from "@mcpjam/sdk";
// Browser-safe SDK entry: the top-level `@mcpjam/sdk` pulls Node-only
// transitive deps that break the Vite browser bundle.
import {
  canRunConformance,
  CHECK_ERAS,
  MCP_APPS_CHECK_IDS,
  MCP_CHECK_IDS,
  MCP_TASKS_CHECK_IDS,
  PROTOCOL_VERSION_ERAS,
  type McpProtocolVersion,
} from "@mcpjam/sdk/browser";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { OAuthConformanceStartResult } from "@/lib/apis/mcp-conformance-api";

export type SuiteStatus =
  | "idle"
  | "running"
  /**
   * The OAuth suite reached the authorization step and is holding: it has a
   * session and a URL, and is waiting for an explicit go-ahead. Only reachable
   * under `deferOAuthAuthorization`.
   */
  | "needs-authorization"
  | "done"
  | "error"
  | "unavailable";

/** "auto" ⇒ no pin: the run adopts whatever version the server negotiates. */
export type ProtocolVersionPin = "auto" | McpProtocolVersion;

export interface SuiteState {
  status: SuiteStatus;
  error?: string;
  unavailableReason?: string;
  /** Left out of this run before Run: never run, so never scored. */
  notSelected?: boolean;
  /**
   * The verdict of a finished run. "Done" only says the run ended — a suite
   * that finished with failures must not read as green.
   */
  verdict?: "passed" | "failed" | "incomplete";
}

export interface ProtocolSuiteState extends SuiteState {
  result?: MCPConformanceResult;
}

export interface AppsSuiteState extends SuiteState {
  result?: MCPAppsConformanceResult;
}

export interface TasksSuiteState extends SuiteState {
  result?: MCPTasksConformanceResult;
}

export interface OAuthSuiteState extends SuiteState {
  result?: OAuthConformanceStartResult["result"];
  sessionId?: string;
  waitingForAuth?: boolean;
  /**
   * The authorization URL while the suite needs or waits for the browser:
   * the explicit authorize step opens it, and a waiting suite offers it again
   * in case the popup never appeared.
   */
  authorizationUrl?: string;
  /**
   * The browser refused to open the authorization popup. Opening it runs
   * after several awaits, outside the click that started the run, which is
   * exactly what popup blockers refuse; without this the suite waited on a
   * window that never existed until the session expired.
   */
  popupBlocked?: boolean;
  /**
   * The user chose Skip OAuth. The suite reads "unavailable" like a server
   * that needs no auth, but its checks were never run, not ruled out.
   */
  skipped?: boolean;
}

export function isHttpServer(server: ServerWithName): boolean {
  // `server.config` is typed required but can be undefined during hosted
  // hydration — guard before using the `in` operator to avoid a TypeError.
  return !!server.config && "url" in server.config;
}

function suiteState(
  suite: "protocol" | "oauth" | "apps" | "tasks",
  server: ServerWithName,
): SuiteState {
  // The SDK's `canRunConformance` is the source of truth for which suites
  // support which transports. It handles null/undefined configs gracefully.
  const support = canRunConformance(
    suite,
    server.config as Parameters<typeof canRunConformance>[1],
  );
  return support.supported
    ? { status: "idle" }
    : { status: "unavailable", unavailableReason: support.reason };
}

export function createProtocolState(
  server: ServerWithName,
): ProtocolSuiteState {
  return suiteState("protocol", server);
}

export function createAppsState(server: ServerWithName): AppsSuiteState {
  return suiteState("apps", server);
}

export function createTasksState(server: ServerWithName): TasksSuiteState {
  return suiteState("tasks", server);
}

export function createOAuthState(server: ServerWithName): OAuthSuiteState {
  return suiteState("oauth", server);
}

/** Every suite reports the same three-value outcome; render it, don't flatten it. */
export function verdictOf(result: {
  outcome?: string;
  passed?: boolean;
}): "passed" | "failed" | "incomplete" {
  if (result.outcome === "incomplete") return "incomplete";
  return result.passed ? "passed" : "failed";
}

/**
 * A server that requires no authorization has no OAuth obligations to test —
 * authorization is OPTIONAL in every MCP revision — so the suite reports
 * `not-applicable`. That is not a result to render as red: it reuses the same
 * "unavailable" treatment as a transport that cannot run the suite.
 */
export function oauthStateFromResult(
  result: NonNullable<OAuthConformanceStartResult["result"]>,
): OAuthSuiteState {
  if (result.outcome === "not-applicable") {
    return {
      status: "unavailable",
      unavailableReason: result.summary,
      // Kept so the score pool can see the run: a not-applicable OAuth run
      // contributes its "nothing to score here" tally instead of vanishing.
      result,
    };
  }
  return {
    status: "done",
    result,
    // OAuth reports the same three-value verdict as the other suites (plus its
    // own not-applicable, handled above), so an incomplete flow is badged
    // amber rather than flattened to failed.
    verdict: verdictOf(result),
  };
}

/**
 * The checks a run covers. A missing list runs the whole suite, so a check
 * added later still runs; an empty one, or `oauth: false`, leaves the suite
 * out. OAuth runs as one flow, so it is all or nothing.
 */
export interface ConformanceSelection {
  protocol?: MCPCheckId[];
  apps?: MCPAppsCheckId[];
  tasks?: MCPTasksCheckId[];
  oauth?: boolean;
}

export const NOT_SELECTED = {
  status: "unavailable",
  unavailableReason: "Not selected for this run, so it is not scored.",
  notSelected: true,
} as const;

export const isSelected = (checkIds: readonly string[] | undefined) =>
  checkIds === undefined || checkIds.length > 0;

function knownIds<T extends string>(
  picked: readonly string[] | undefined,
  known: readonly T[],
): T[] | undefined {
  return picked === undefined
    ? undefined
    : known.filter((id) => picked.includes(id));
}

/**
 * The selection with each suite list cut to ids this build knows: saved
 * defaults are plain strings, so an id renamed or removed since would get the
 * whole suite refused. A pinned version also drops protocol checks outside
 * its era, which would only run as skips.
 */
export function runnableSelection(
  selection: ConformanceSelection | undefined,
  versionPin: ProtocolVersionPin,
): ConformanceSelection | undefined {
  if (!selection) return undefined;
  const pinnedEra =
    versionPin === "auto" ? undefined : PROTOCOL_VERSION_ERAS[versionPin];
  const protocolIds = MCP_CHECK_IDS.filter(
    (id) =>
      pinnedEra === undefined ||
      (CHECK_ERAS[id] as readonly string[]).includes(pinnedEra),
  );
  return {
    ...selection,
    protocol: knownIds(selection.protocol, protocolIds),
    apps: knownIds(selection.apps, MCP_APPS_CHECK_IDS),
    tasks: knownIds(selection.tasks, MCP_TASKS_CHECK_IDS),
  };
}
