/**
 * Suite state shapes for the conformance run hook (`use-conformance-run.ts`).
 */

import type {
  MCPConformanceResult,
  MCPAppsConformanceResult,
  MCPTasksConformanceResult,
} from "@mcpjam/sdk";
import type { McpProtocolVersion } from "@mcpjam/sdk/browser";
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
