/**
 * Transport-agnostic conformance handlers.
 *
 * Both the local-mode MCP routes (`/api/mcp/conformance/*`) and the hosted-mode
 * web routes (`/api/web/conformance/*`) resolve their server configs from
 * different places (local uses the in-process `MCPClientManager`, hosted talks
 * to Convex + OAuth proxy) but once a config is resolved the actual conformance
 * run is identical. This module centralises that second half so the SDK remains
 * the sole source of truth for check definitions AND orchestration.
 */

import {
  MCPAppsConformanceTest,
  MCPConformanceTest,
  OAuthConformanceTest,
  canRunConformance,
  normalizeCustomHeaders,
  renderConformanceReportJson,
  toConformanceReport,
  type ConformanceReport,
  type ConformanceResult as OAuthConformanceResult,
  type MCPAppsConformanceConfig,
  type MCPAppsConformanceResult,
  type MCPConformanceConfig,
  type MCPConformanceResult,
  type MCPServerConfig,
  type OAuthConformanceConfig,
  type OAuthConformanceProfile,
} from "@mcpjam/sdk";
import {
  createSession,
  getSession,
  setSessionError,
  setSessionResult,
  submitAuthorizationCode,
  type OAuthConformanceSession,
} from "../../services/conformance-oauth-sessions.js";

// ── Result shapes shared with clients ───────────────────────────────────

type SingleConformanceResult =
  | MCPConformanceResult
  | MCPAppsConformanceResult
  | OAuthConformanceResult;

export interface ConformanceRunResponse<T extends SingleConformanceResult> {
  result: T;
  report: ConformanceReport;
}

function createConformanceRunResponse<T extends SingleConformanceResult>(
  result: T,
): ConformanceRunResponse<T> {
  return {
    result,
    report: renderConformanceReportJson(toConformanceReport(result)),
  };
}

export type StartOAuthConformanceResult =
  | {
      phase: "authorization_needed";
      sessionId: string;
      authorizationUrl: string;
      completedSteps: OAuthConformanceSession["completedSteps"];
    }
  | {
      phase: "complete";
      result: OAuthConformanceResult;
      report: ConformanceReport;
    };

export type CompleteOAuthConformanceResult =
  | {
      phase: "complete";
      result: OAuthConformanceResult;
      report: ConformanceReport;
    }
  | {
      phase: "pending";
      completedSteps: OAuthConformanceSession["completedSteps"];
    };

// ── Protocol ────────────────────────────────────────────────────────────

export interface ResolvedHttpConfig {
  serverUrl: string;
  accessToken?: string;
  customHeaders?: Record<string, string>;
}

export class UnsupportedTransportError extends Error {
  readonly code = "unsupportedTransport" as const;
}

/** Throw if the caller handed us a non-HTTP config for an HTTP-only suite. */
export function assertHttpSupported(
  suite: "protocol" | "oauth",
  config: MCPServerConfig,
): void {
  const support = canRunConformance(suite, config);
  if (!support.supported) {
    throw new UnsupportedTransportError(support.reason ?? "Unsupported transport");
  }
}

export async function runProtocolConformance(
  input: ResolvedHttpConfig,
): Promise<ConformanceRunResponse<MCPConformanceResult>> {
  const config: MCPConformanceConfig = {
    serverUrl: input.serverUrl,
    accessToken: input.accessToken,
    customHeaders: input.customHeaders,
  };
  const test = new MCPConformanceTest(config);
  const result = await test.run();
  return createConformanceRunResponse(result);
}

// ── Apps ────────────────────────────────────────────────────────────────

export async function runAppsConformance(
  serverConfig: MCPAppsConformanceConfig,
): Promise<ConformanceRunResponse<MCPAppsConformanceResult>> {
  const test = new MCPAppsConformanceTest(serverConfig);
  const result = await test.run();
  return createConformanceRunResponse(result);
}

// ── OAuth (interactive, remote-browser) ─────────────────────────────────

export interface StartOAuthConformanceInput {
  /** Fallback server URL when `oauthProfile.serverUrl` is not set. */
  defaultServerUrl: string;
  /** Fallback headers when `oauthProfile.customHeaders` is not set. */
  defaultCustomHeaders?: Record<string, string>;
  /** Public callback URL that the authorization server will redirect to. */
  redirectUrl: string;
  oauthProfile?: OAuthConformanceProfile;
  runNegativeChecks?: boolean;
  /** How long to wait for the runner to produce an auth URL before assuming it
   * completed without needing user auth. Defaults to 3s. */
  authorizationUrlGraceMs?: number;
}

const DEFAULT_GRACE_MS = 3_000;

export async function startOAuthConformance(
  input: StartOAuthConformanceInput,
): Promise<StartOAuthConformanceResult> {
  const serverUrl = input.oauthProfile?.serverUrl || input.defaultServerUrl;
  const customHeaders =
    normalizeCustomHeaders(input.oauthProfile?.customHeaders) ??
    input.defaultCustomHeaders;

  const session = createSession({ redirectUrl: input.redirectUrl });
  const { controller } = session;

  const oauthConfig: OAuthConformanceConfig = {
    serverUrl,
    protocolVersion: input.oauthProfile?.protocolVersion ?? "2025-11-25",
    registrationStrategy: input.oauthProfile?.registrationStrategy ?? "cimd",
    auth: {
      mode: "interactive",
      // openUrl is intentionally a no-op: the remote-browser controller
      // surfaces the auth URL via `awaitAuthorizationUrl`, not by opening a
      // local browser. The actual "open in a new window" happens client-side.
      openUrl: async () => {},
    },
    client: input.oauthProfile?.clientId
      ? {
          preregistered: {
            clientId: input.oauthProfile.clientId,
            clientSecret: input.oauthProfile.clientSecret,
          },
        }
      : undefined,
    scopes: input.oauthProfile?.scopes,
    customHeaders,
    redirectUrl: input.redirectUrl,
    oauthConformanceChecks: input.runNegativeChecks ?? false,
  };

  const test = new OAuthConformanceTest(oauthConfig, {
    createInteractiveAuthorizationSession: () => controller.createSession(),
  });

  const runnerPromise = test.run().then(
    (result) => {
      setSessionResult(session.id, result);
      return result;
    },
    (err) => {
      setSessionError(
        session.id,
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    },
  );
  session.runnerPromise = runnerPromise;
  // Don't let an unhandled rejection propagate while we wait.
  runnerPromise.catch(() => undefined);

  // Race the runner against `awaitAuthorizationUrl`: whichever settles first
  // tells us whether user authorization is needed.
  const graceMs = input.authorizationUrlGraceMs ?? DEFAULT_GRACE_MS;
  const graceTimer = new Promise<"grace">((resolve) => {
    setTimeout(() => resolve("grace"), graceMs);
  });

  const outcome = await Promise.race([
    controller.awaitAuthorizationUrl.then(() => "authorization_needed" as const),
    runnerPromise.then(() => "complete" as const, () => "complete" as const),
    graceTimer,
  ]);

  if (outcome === "authorization_needed" && session.authorizationUrl) {
    return {
      phase: "authorization_needed",
      sessionId: session.id,
      authorizationUrl: session.authorizationUrl,
      completedSteps: session.completedSteps,
    };
  }

  // Either the runner finished without needing user auth, or we hit the grace
  // deadline. In either case, awaiting the runner either gives us a result or
  // surfaces its error.
  const result = await runnerPromise;
  return { phase: "complete", ...createConformanceRunResponse(result) };
}

export interface SubmitOAuthConformanceCodeInput {
  sessionId: string;
  code: string;
  state?: string;
}

/** Returns whether a session accepted the code (false when unknown/expired). */
export function submitOAuthConformanceCode(
  input: SubmitOAuthConformanceCodeInput,
): boolean {
  return submitAuthorizationCode(input.sessionId, input.code, input.state);
}

export interface CompleteOAuthConformanceInput {
  sessionId: string;
  /** How long to long-poll before returning `pending`. Defaults to 25s. */
  pollTimeoutMs?: number;
  /** Interval between polls. Defaults to 500ms. */
  pollIntervalMs?: number;
}

export class OAuthConformanceSessionNotFoundError extends Error {
  readonly code = "notFound" as const;
}

export class OAuthConformanceSessionFailedError extends Error {
  readonly code = "runnerFailed" as const;
}

export async function completeOAuthConformance(
  input: CompleteOAuthConformanceInput,
): Promise<CompleteOAuthConformanceResult> {
  const session = getSession(input.sessionId);
  if (!session) {
    throw new OAuthConformanceSessionNotFoundError(
      "Session not found or expired",
    );
  }
  if (session.result) {
    return {
      phase: "complete",
      ...createConformanceRunResponse(session.result),
    };
  }
  if (session.error) {
    throw new OAuthConformanceSessionFailedError(session.error);
  }

  const pollTimeoutMs = input.pollTimeoutMs ?? 25_000;
  const pollIntervalMs = input.pollIntervalMs ?? 500;
  const deadline = Date.now() + pollTimeoutMs;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    const current = getSession(input.sessionId);
    if (!current) {
      throw new OAuthConformanceSessionNotFoundError("Session expired");
    }
    if (current.result) {
      return {
        phase: "complete",
        ...createConformanceRunResponse(current.result),
      };
    }
    if (current.error) {
      throw new OAuthConformanceSessionFailedError(current.error);
    }
  }

  return {
    phase: "pending",
    completedSteps: session.completedSteps,
  };
}
