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
  MCPTasksConformanceTest,
  OAuthConformanceTest,
  canRunConformance,
  normalizeCustomHeaders,
  type ConformanceResult as OAuthConformanceResult,
  type MCPAppsConformanceConfig,
  type MCPAppsConformanceResult,
  type MCPConformanceConfig,
  type MCPConformanceResult,
  type MCPServerConfig,
  type McpProtocolVersion,
  type MCPTasksConformanceConfig,
  type MCPTasksConformanceResult,
  type OAuthConformanceConfig,
  type OAuthConformanceProfile,
  type OpenAISubmissionMode,
} from "@mcpjam/sdk";
import {
  createSession,
  getSession,
  setSessionError,
  setSessionResult,
  submitAuthorizationCode,
  type OAuthConformanceSession,
} from "../../services/conformance-oauth-sessions.js";
import { createStreamingPinnedFetch } from "../../utils/pinned-fetch.js";
import {
  runDirectoryReadiness,
  type DirectoryReadinessResult,
  type ReadinessPublisher,
} from "../../services/readiness/runner.js";

/**
 * DNS + connect + response headers, across every hop of one request.
 *
 * Matched to undici's `headersTimeout`, which is what these runs got from the
 * global `fetch` before the transport swap. Closing an SSRF hole is not a
 * reason to start failing servers that were graded fine yesterday, and a cold
 * container answering its first `initialize` in forty seconds is slow, not
 * unreachable — the suite's own per-check timeout is what bounds a slow run.
 */
const CONFORMANCE_CHAIN_TIMEOUT_MS = 300_000;
/**
 * No bytes for this long on an OPEN stream ⇒ the stream is dead, not slow.
 *
 * Matched to undici's `bodyTimeout` for the same reason. It cannot be tight:
 * MCP requires no SSE keepalives, so a conforming notification stream is
 * allowed to say nothing at all while a long check or an interactive OAuth
 * wait runs, and killing it would fail the server for our impatience — and
 * without resumability, drop the notifications the suite is there to observe.
 */
const CONFORMANCE_BODY_IDLE_TIMEOUT_MS = 300_000;
/** Cumulative decompressed body cap for a single conformance request. */
const CONFORMANCE_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

/**
 * The one outbound transport every hosted conformance run dials through.
 *
 * `createGuardedFetch` — what this used to be — resolves the hostname to
 * classify it and then hands the URL to a client that resolves it a SECOND
 * time, which is the DNS-rebinding window itself: pass the check with a public
 * answer, serve `169.254.169.254` to the connection that actually happens. The
 * pinned transport resolves once, refuses the disallowed answers, and pins the
 * surviving addresses into the socket, re-running all of it on every redirect
 * hop.
 *
 * It is handed to the suites as `fetchFn`, which each runner now also threads
 * into the MCP transport as `baseFetch` — so the one real MCP connection a run
 * opens is under the same guard as the raw probes beside it, rather than
 * following its redirects unchecked as it did while this comment's predecessor
 * documented the gap.
 *
 * A no-op outside hosted mode, where reaching localhost is the point.
 */
export function createConformanceFetch(targetLabel: string): typeof fetch {
  return createStreamingPinnedFetch({
    targetLabel,
    // DNS + connect + headers, summed across the redirect chain. Deliberately
    // NOT a bound on an established body: an SSE stream is long-lived by
    // design, and killing one at 30s would fail conforming servers.
    chainTimeoutMs: CONFORMANCE_CHAIN_TIMEOUT_MS,
    // A stalled stream still has to die. This is the bound that can apply to
    // SSE without punishing a healthy stream for staying open.
    bodyIdleTimeoutMs: CONFORMANCE_BODY_IDLE_TIMEOUT_MS,
    maxResponseBytes: CONFORMANCE_MAX_RESPONSE_BYTES,
  });
}

// ── Result shapes shared with clients ───────────────────────────────────

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
    };

export type CompleteOAuthConformanceResult =
  | {
      phase: "complete";
      result: OAuthConformanceResult;
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
  /** Pin the run to one protocol version; absent ⇒ adopt the negotiated one. */
  protocolVersion?: McpProtocolVersion;
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
): Promise<{ result: MCPConformanceResult }> {
  const config: MCPConformanceConfig = {
    serverUrl: input.serverUrl,
    accessToken: input.accessToken,
    customHeaders: input.customHeaders,
    protocolVersion: input.protocolVersion,
    // Checking the URL the caller named is not the same as checking the
    // addresses we end up dialing: a target can answer `302 Location:
    // http://169.254.169.254/`. This re-checks each hop. A no-op outside hosted
    // mode, where reaching localhost is the point.
    //
    // SCOPE, precisely: `fetchFn` is what the raw HTTP and SSE probes use. The
    // one real MCP connection this suite opens goes through MCPClientManager's
    // own transport fetch, which this does not reach — so a redirect returned by
    // the MCP endpoint itself is still followed unchecked. Closing that means
    // threading a base fetch through the client manager, which is a shared
    // connection path for every protocol version and every surface, and does not
    // belong in this change.
    fetchFn: createConformanceFetch("MCP server"),
  };
  const test = new MCPConformanceTest(config);
  const result = await test.run();
  return { result };
}

// ── Apps ────────────────────────────────────────────────────────────────

export async function runAppsConformance(
  serverConfig: MCPAppsConformanceConfig,
): Promise<{ result: MCPAppsConformanceResult }> {
  // The apps suite is entirely client-driven — it has no raw probes — so
  // before `baseFetch` existed there was no seam at all to guard it through,
  // and a hosted apps run dialled the target with nothing in front of it.
  const test = new MCPAppsConformanceTest({
    ...serverConfig,
    baseFetch: serverConfig.baseFetch ?? createConformanceFetch("MCP server"),
  });
  const result = await test.run();
  return { result };
}

// ── Directory readiness ─────────────────────────────────────────────────

/**
 * Run a deterministic readiness grade against a connected server.
 *
 * SYNCHRONOUS AND FREE, and both halves are deliberate. A local run is not
 * persisted, holds no lease and has no payer, so there is nothing for a
 * durable queue to own — and no `requestObservations` is passed, which means
 * this path structurally cannot spend. The hosted path is the one with a
 * lease, a heartbeat and a broker.
 *
 * The pinned transport is the same one every hosted conformance run dials
 * through: resolve once, refuse the disallowed answers, pin the surviving
 * addresses into the socket, re-run all of it on every redirect hop. A no-op
 * outside hosted mode, where reaching localhost is the point.
 */
export async function runLocalDirectoryReadiness(input: {
  publisher: ReadinessPublisher;
  target: string;
  submissionMode?: OpenAISubmissionMode;
  accessToken?: string;
  customHeaders?: Record<string, string>;
}): Promise<{ result: DirectoryReadinessResult }> {
  const headers: Record<string, string> = { ...(input.customHeaders ?? {}) };
  if (input.accessToken) headers.authorization = `Bearer ${input.accessToken}`;

  const { result } = await runDirectoryReadiness({
    publisher: input.publisher,
    target: input.target,
    submissionMode: input.submissionMode,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    fetchFn: createConformanceFetch("MCP server"),
  });
  return { result };
}

// ── Tasks ───────────────────────────────────────────────────────────────

export async function runTasksConformance(
  serverConfig: MCPTasksConformanceConfig,
): Promise<{ result: MCPTasksConformanceResult }> {
  const test = new MCPTasksConformanceTest({
    ...serverConfig,
    baseFetch: serverConfig.baseFetch ?? createConformanceFetch("MCP server"),
  });
  const result = await test.run();
  return { result };
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
    // The negative checks (invalid client, mismatched redirect, invalid token,
    // http:// DCR redirect) are part of the OAuth suite, not an opt-in extra:
    // verifying the server *rejects* bad input is half of OAuth conformance.
    // The runner only reaches them once the happy path passes end to end.
    oauthConformanceChecks: true,
    // The OAuth suite dials URLs it DISCOVERS — authorization, token,
    // registration and metadata endpoints all come out of the target's own
    // documents — so the profile URL it was handed is the one address here that
    // was ever checkable up front. Every request goes through the hop-checking
    // fetch instead. Requests that ask for `redirect: "manual"` keep their 3xx:
    // this suite grades redirects, and following one would erase the evidence.
    fetchFn: createConformanceFetch("OAuth endpoint"),
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
  return { phase: "complete", result };
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
    return { phase: "complete", result: session.result };
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
      return { phase: "complete", result: current.result };
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
