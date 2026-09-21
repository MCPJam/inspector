/**
 * `runEmulatedOAuthPreflight` — execute an emulated client's authentication
 * ladder against a real MCP server, headlessly (HP-43 step 5).
 *
 * Node-only: outbound requests default to the hardened OAuth networking path
 * (`executeOAuthProxy` — DNS pinning, total-deadline timeouts, response-body
 * caps, redirect caps, cross-origin credential stripping), which is where the
 * SSRF hardening for server-controlled metadata URLs already lives.
 *
 * Three properties this runner is built around:
 *
 *  1. **Completion-first.** Every attempt is allowed to finish with a real
 *     token; the emulation shapes the wire, it never sabotages the dance.
 *     "Completed" means a token AND a valid authenticated JSON-RPC response,
 *     not a bare 2xx.
 *  2. **Bounded side effects.** DCR creates a client on someone's server and
 *     a token exchange issues a credential. A run performs at most two
 *     registrations (the second only after a structured `invalid_redirect_uri`
 *     rejection) and reports what it caused in `sideEffects`.
 *  3. **Credentials out of diagnostics.** Secrets are returned once, in
 *     `credentials`. Everything else — traces, attempt histories — is redacted,
 *     including the caller's own static-credential header, whose name this
 *     runner cannot know in advance.
 */

import { executeOAuthProxy } from "../../oauth-proxy.js";
import { redactForTelemetry } from "../../telemetry-redaction.js";
import {
  DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
  getConformanceAuthCodeDynamicRegistrationMetadata,
} from "../client-identity.js";
import { assertOutboundOAuthUrlAllowed } from "../ssrf-guard.js";
import { getSupportedRegistrationStrategies } from "../state-machines/factory.js";
import {
  resolveAuthorizationPlan,
  type OAuthRegistrationStrategy,
  type ResolvedAuthorizationPlan,
} from "../authorization-plan.js";
import { runOAuthStateMachine } from "../state-machines/runner.js";
import {
  buildInitializeRequestBody,
  buildStatelessVerifyRequestBody,
  resolveInitializeProtocolVersion,
} from "../state-machines/shared/initialize.js";
import { resolveEmulatedMcpVersion } from "../state-machines/shared/emulation.js";
import {
  EMPTY_OAUTH_FLOW_STATE,
  type HttpHistoryEntry,
  type OAuthFlowState,
  type OAuthHttpRequest,
  type OAuthProtocolVersion,
  type OAuthRequestExecutor,
  type OAuthRequestResult,
} from "../state-machines/types.js";
import type { DerivedOAuthEmulation } from "./derive.js";
import {
  isInvalidRedirectUriRejection,
  planCompletionSafeRedirects,
} from "./redirects.js";
import type {
  EmulatedAuthAttempt,
  EmulatedRegistrationPreference,
  OAuthEmulationConfig,
  OAuthEmulationCoverage,
  OAuthEmulationDivergence,
} from "./types.js";

/**
 * Drift guard: `EmulatedRegistrationPreference` is spelled independently in
 * `emulation/types.ts` so that module stays free of any import that would
 * close a cycle (authorization-plan → state-machines/types → emulation/types).
 * This assertion — in a module that already imports both — fails to compile if
 * the two unions ever diverge, which is the only real risk of the duplication.
 */
type _RegistrationPreferenceInSync =
  EmulatedRegistrationPreference extends OAuthRegistrationStrategy
    ? OAuthRegistrationStrategy extends EmulatedRegistrationPreference
      ? true
      : never
    : never;
const _registrationPreferenceInSync: _RegistrationPreferenceInSync = true;
void _registrationPreferenceInSync;

const DEFAULT_CLIENT_NAME = "MCPJam Emulated Client";
const DEFAULT_CLIENT_VERSION = "1.0.0";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_STEPS = 40;

export interface EmulatedOAuthPreflightConfig {
  serverUrl: string;
  serverName?: string;
  /** The compiled profile from `deriveOAuthEmulation`. */
  emulation: DerivedOAuthEmulation;
  /**
   * The callback MCPJam controls. Authorization and token legs always use it;
   * registration replays the captured list with it appended.
   */
  callbackUrl: string;
  /** MCPJam-controlled client-ID metadata document, for CIMD attempts. */
  clientIdMetadataUrl?: string;
  /** MCPJam-controlled pre-registered credentials. */
  preregistered?: { clientId: string; clientSecret?: string };
  /**
   * The static credential an `api-key` rung sends. Absent means the rung is
   * skipped and declared — this runner never invents a credential.
   */
  staticCredential?: { headerName: string; value: string };
  customHeaders?: Record<string, string>;
  customScopes?: string;
  timeoutMs?: number;
  maxSteps?: number;
  /**
   * Completes the human leg headlessly (a compliant/mock AS that auto-consents).
   * Absent → the run stops at the authorization redirect and reports the URL.
   */
  completeAuthorization?: (input: {
    authorizationUrl: string;
    callbackUrl: string;
  }) => Promise<{ code: string }>;
  /** Override the hardened default executor (tests, alternate transports). */
  requestExecutor?: OAuthRequestExecutor;
  allowLoopbackMetadataFetch?: boolean;
  /**
   * Permit private destinations (loopback, RFC 1918, CGNAT, unique-local).
   * The LOCAL inspector's default; hosted surfaces leave it unset. Link-local
   * and cloud-metadata destinations stay refused either way.
   */
  allowPrivateMetadataFetch?: boolean;
  /**
   * Defaults to "warn": emulation is an observational surface, and rejecting
   * an odd resource indicator would hide the very server behavior the run
   * exists to expose.
   */
  resourceIndicatorEnforcement?: "warn" | "reject" | "reject-rfc9728";
}

export type EmulatedOAuthPreflightOutcome =
  /** Real token AND a valid authenticated JSON-RPC response. */
  | "completed"
  /** Ladder reached the human leg; no `completeAuthorization` supplied. */
  | "stopped_at_redirect"
  /** Server accepted the emulated client's static credential. */
  | "static_credential_ok"
  /** Server served an unauthenticated request (client models no auth). */
  | "unauthenticated_ok"
  /** The ladder ran out of usable mechanisms. */
  | "blocked"
  | "error";

export interface EmulatedAuthAttemptResult {
  kind: EmulatedAuthAttempt["kind"];
  status:
    | "ok"
    | "unauthorized"
    | "skipped"
    | "redirected"
    | "blocked"
    | "error";
  /** Which registration strategy actually ran, for `oauth` attempts. */
  registrationStrategy?: EmulatedRegistrationPreference;
  plan?: ResolvedAuthorizationPlan;
  /** Redacted. Never carries tokens, codes, secrets, or PKCE values. */
  httpHistory?: HttpHistoryEntry[];
  detail?: string;
}

export interface EmulatedOAuthPreflightResult {
  serverUrl: string;
  protocolVersion: OAuthProtocolVersion;
  outcome: EmulatedOAuthPreflightOutcome;
  /** Per-field enforcement, carried through from the compiler. */
  coverage: OAuthEmulationCoverage;
  coverageSummary: "complete" | "partial";
  /**
   * Third, independent dimension. Golden-trace comparison is a later step; a
   * run never claims a match on its own.
   */
  comparison: "not_compared";
  attempts: EmulatedAuthAttemptResult[];
  authorizationUrl?: string;
  /** Compile-time divergences plus everything this run declared. */
  divergences: OAuthEmulationDivergence[];
  /** What this run caused on the target. */
  sideEffects: { dcrRegistrations: number; tokensIssued: number };
  /** Secrets, returned once and kept out of every diagnostic surface. */
  credentials?: {
    accessToken?: string;
    refreshToken?: string;
    clientId?: string;
    clientSecret?: string;
  };
  error?: { message: string };
}

/**
 * The hardened default executor. Runs every OAuth and MCP request through the
 * SSRF-hardened proxy path rather than a bare `fetch`.
 */
function createHardenedExecutor(
  timeoutMs: number,
  allowPrivateNetwork: boolean
): OAuthRequestExecutor {
  return async (request: OAuthHttpRequest): Promise<OAuthRequestResult> => {
    const response = await executeOAuthProxy({
      url: request.url,
      method: request.method,
      body: request.body,
      headers: request.headers,
      redirect: request.redirect,
      timeoutMs,
      allowPrivateNetwork,
    });
    return {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body: response.body,
      ok: response.status >= 200 && response.status < 300,
    };
  };
}

/**
 * Redact a diagnostic payload.
 *
 * The shared redactor knows the conventional credential shapes. It cannot know
 * that THIS caller's static credential rides in, say, `X-Acme-Key`, so that
 * header name and value are scrubbed explicitly before the generic pass.
 */
function redactDiagnostics<T>(
  value: T,
  staticCredential?: { headerName: string; value: string }
): T {
  let working: unknown = value;
  if (staticCredential) {
    const headerNeedle = staticCredential.headerName.toLowerCase();
    const scrub = (input: unknown): unknown => {
      if (Array.isArray(input)) return input.map(scrub);
      if (input && typeof input === "object") {
        return Object.fromEntries(
          Object.entries(input as Record<string, unknown>).map(([key, val]) => [
            key,
            key.toLowerCase() === headerNeedle ? "[REDACTED]" : scrub(val),
          ])
        );
      }
      if (typeof input === "string" && staticCredential.value) {
        return input.split(staticCredential.value).join("[REDACTED]");
      }
      return input;
    };
    working = scrub(working);
  }
  return redactForTelemetry(working) as T;
}

/**
 * Extract the JSON-RPC message from a response body.
 *
 * Streamable-HTTP MCP servers answer with `text/event-stream`, and the
 * hardened proxy buffers that as a raw string — so a body is legitimately an
 * object, a JSON string, or a set of SSE frames. Only after decoding all three
 * can "did the server answer a real MCP call" be judged; treating an SSE frame
 * as a non-answer would fail every streaming server.
 */
function extractJsonRpcMessage(body: unknown): Record<string, unknown> | undefined {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  if (typeof body !== "string") return undefined;

  const text = body.trim();
  if (!text) return undefined;

  if (!/^(event|data|id|retry):/m.test(text)) {
    try {
      const parsed = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  // SSE: take the last `data:` payload that parses as a JSON-RPC message.
  for (const line of text.split(/\r?\n/).reverse()) {
    if (!line.startsWith("data:")) continue;
    try {
      const parsed = JSON.parse(line.slice(5).trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Keep scanning: a multi-frame stream may carry non-JSON keepalives.
    }
  }
  return undefined;
}

/** A token alone is not success — the server must answer a real MCP call. */
function isValidAuthenticatedJsonRpc(state: OAuthFlowState): boolean {
  const message = extractJsonRpcMessage(state.lastResponse?.body);
  if (!message) return false;
  if (message.jsonrpc !== "2.0") return false;
  if (message.error !== undefined) return false;
  return message.result !== undefined;
}

function countRegistrationRequests(state: OAuthFlowState): number {
  return (state.httpHistory ?? []).filter(
    (entry) => entry.step === "request_client_registration"
  ).length;
}

function registrationResponse(
  state: OAuthFlowState
): { status: number; body: unknown } | undefined {
  const entry = [...(state.httpHistory ?? [])]
    .reverse()
    .find((item) => item.step === "request_client_registration");
  if (!entry?.response) return undefined;
  return { status: entry.response.status, body: entry.response.body };
}

/**
 * Did this attempt commit anything the ladder must not repeat?
 *
 * Falling through to the next registration strategy is only safe while nothing
 * is on the wire. Once a registration request has been sent (a client may now
 * exist on the server) or authorization has begun, a failure stops the ladder
 * rather than silently creating more clients or restarting a half-finished
 * dance.
 */
function hasCommittedSideEffects(state: OAuthFlowState): boolean {
  return countRegistrationRequests(state) > 0 || Boolean(state.authorizationUrl);
}

interface AttemptRunOutput {
  result: EmulatedAuthAttemptResult;
  state?: OAuthFlowState;
  outcome?: EmulatedOAuthPreflightOutcome;
  authorizationUrl?: string;
  divergences: OAuthEmulationDivergence[];
  registrations: number;
  tokensIssued: number;
  stop: boolean;
}

export async function runEmulatedOAuthPreflight(
  config: EmulatedOAuthPreflightConfig
): Promise<EmulatedOAuthPreflightResult> {
  const {
    serverUrl,
    serverName = "Emulated OAuth Preflight",
    emulation: derived,
    callbackUrl,
    // CIMD asserts identity through a fetchable document, which must be one
    // MCPJam controls — the real client's document is not ours to claim. Every
    // CIMD attempt therefore declares an `identity-substituted` divergence.
    clientIdMetadataUrl = DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
    preregistered,
    staticCredential,
    customHeaders,
    customScopes,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxSteps = DEFAULT_MAX_STEPS,
    completeAuthorization,
    allowLoopbackMetadataFetch,
    allowPrivateMetadataFetch,
    resourceIndicatorEnforcement = "warn",
  } = config;

  const executor =
    config.requestExecutor ??
    createHardenedExecutor(timeoutMs, allowPrivateMetadataFetch ?? false);
  const protocolVersion = derived.protocolVersion;
  const divergences: OAuthEmulationDivergence[] = [...derived.divergences];
  const attempts: EmulatedAuthAttemptResult[] = [];
  const sideEffects = { dcrRegistrations: 0, tokensIssued: 0 };

  const redirectPlan = planCompletionSafeRedirects({
    capturedRedirectUris: derived.capturedRedirectUris,
    callbackUrl,
  });

  let outcome: EmulatedOAuthPreflightOutcome = "blocked";
  let authorizationUrl: string | undefined;
  let credentials: EmulatedOAuthPreflightResult["credentials"];
  let error: { message: string } | undefined;
  let redirectDivergencesDeclared = false;

  // ── direct MCP probe, shared by the `api-key` and `none` rungs ───────────
  // These rungs bypass the state machines, so they also bypass the factory's
  // outbound guard. Apply it here: a caller-supplied executor must not turn
  // these paths into an SSRF hole the OAuth path is closed against.
  const probeMcp = async (
    extraHeaders: Record<string, string>
  ): Promise<OAuthRequestResult> => {
    assertOutboundOAuthUrlAllowed(serverUrl, {
      allowLoopback: allowLoopbackMetadataFetch ?? false,
      allowPrivateNetwork: allowPrivateMetadataFetch ?? false,
    });
    const mcpVersion = resolveEmulatedMcpVersion(
      derived.emulation,
      resolveInitializeProtocolVersion(protocolVersion)
    );
    const headerVersion = resolveEmulatedMcpVersion(
      derived.emulation,
      protocolVersion
    );
    const body =
      protocolVersion === "2026-07-28"
        ? buildStatelessVerifyRequestBody({
            protocolVersion: mcpVersion,
            clientName: derived.emulation.dcrClientName ?? DEFAULT_CLIENT_NAME,
            clientVersion: DEFAULT_CLIENT_VERSION,
            id: 1,
          })
        : buildInitializeRequestBody({
            protocolVersion: mcpVersion,
            clientName: derived.emulation.dcrClientName ?? DEFAULT_CLIENT_NAME,
            clientVersion: DEFAULT_CLIENT_VERSION,
            id: 1,
          });
    return executor({
      url: serverUrl,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": headerVersion,
        ...(derived.emulation.userAgent
          ? { "User-Agent": derived.emulation.userAgent }
          : {}),
        ...(customHeaders ?? {}),
        ...extraHeaders,
      },
      body,
    });
  };

  const runOAuthAttempt = async (
    attempt: Extract<EmulatedAuthAttempt, { kind: "oauth" }>
  ): Promise<AttemptRunOutput> => {
    const preference = attempt.registrationPreference;
    const attemptDivergences: OAuthEmulationDivergence[] = [];
    let registrations = 0;
    let lastBlockedPlan: ResolvedAuthorizationPlan | undefined;
    // Diagnostics from strategies that failed WITHOUT committing anything and
    // were fallen through. Without these, a ladder that tried CIMD then DCR
    // and exhausted both reports "blocked" with no trace of either failure.
    const fallenThrough: Array<{
      strategy: EmulatedRegistrationPreference;
      detail: string;
      httpHistory: HttpHistoryEntry[];
    }> = [];

    // `dcrRedirectUris` is the completion-safe list, never the raw capture.
    let wireEmulation: OAuthEmulationConfig = {
      ...derived.emulation,
      dcrRedirectUris: redirectPlan.registrationRedirectUris,
    };

    // One pass per usable strategy. Fall-through is permitted only while
    // nothing has been committed on the wire (see hasCommittedSideEffects).
    //
    // With no profile preference (`authModel` not_modeled) the ladder is
    // MCPJam's own AUTO precedence — pre-registered, then CIMD, then DCR —
    // filtered to what this era supports, rather than a hardcoded strategy.
    // Discovery is not pre-fetched: a strategy the server turns out not to
    // support fails during discovery, BEFORE any registration, so the
    // uncommitted-fallback rule moves to the next one without creating a
    // client or repeating a committed step.
    const eraStrategies = getSupportedRegistrationStrategies(protocolVersion);
    const autoOrder = (
      ["preregistered", "cimd", "dcr"] as EmulatedRegistrationPreference[]
    ).filter((strategy) => eraStrategies.includes(strategy));
    const strategyQueue: EmulatedRegistrationPreference[] =
      preference.length > 0 ? [...preference] : autoOrder;

    for (const strategy of strategyQueue) {
      const plan = resolveAuthorizationPlan({
        serverUrl,
        protocolVersion,
        registrationMode: "auto",
        registrationPreference: [strategy],
        clientId: preregistered?.clientId,
        clientSecret: preregistered?.clientSecret,
        clientIdMetadataUrl,
        authMode: "interactive",
      });

      if (plan.status === "blocked") {
        lastBlockedPlan = plan;
        continue;
      }

      const resolvedStrategy = (plan.registrationStrategy ??
        strategy) as EmulatedRegistrationPreference;

      if (
        resolvedStrategy === "cimd" ||
        resolvedStrategy === "preregistered"
      ) {
        attemptDivergences.push({
          kind: "identity-substituted",
          detail: `${resolvedStrategy} attempt uses an MCPJam-controlled client identity; the real client's own identity cannot be asserted`,
        });
      }

      let runState: OAuthFlowState = {
        ...EMPTY_OAUTH_FLOW_STATE,
        httpHistory: [],
        infoLogs: [],
      };

      const runOnce = async () =>
        runOAuthStateMachine({
          protocolVersion,
          registrationStrategy: resolvedStrategy,
          state: runState,
          getState: () => runState,
          updateState: (updates) => {
            runState = { ...runState, ...updates };
          },
          serverUrl,
          serverName,
          redirectUrl: redirectPlan.authorizationRedirectUri,
          requestExecutor: executor,
          // MCPJam's own registration identity is the base; the emulation
          // overlay replaces `client_name`/`redirect_uris` when the profile
          // models them. A profile with no dcrIdentity evidence therefore
          // registers as MCPJam — normal behavior for a `not_modeled` field,
          // and never a fabricated client name.
          dynamicRegistration: getConformanceAuthCodeDynamicRegistrationMetadata(),
          emulation: wireEmulation,
          clientIdMetadataUrl,
          customScopes,
          customHeaders,
          resourceIndicatorEnforcement,
          allowLoopbackMetadataFetch,
          allowPrivateMetadataFetch,
          maxSteps,
          loadPreregisteredCredentials: preregistered
            ? () => ({
                clientId: preregistered.clientId,
                clientSecret: preregistered.clientSecret,
              })
            : undefined,
          hasClientSecret: Boolean(preregistered?.clientSecret),
          onAuthorizationRequest: async ({ authorizationUrl: url }) => {
            if (!completeAuthorization) return { type: "redirect" as const };
            const { code } = await completeAuthorization({
              authorizationUrl: url,
              callbackUrl: redirectPlan.authorizationRedirectUri,
            });
            return {
              type: "authorization_code" as const,
              authorizationCode: code,
            };
          },
        });

      let run = await runOnce();
      registrations += countRegistrationRequests(runState);
      // Kept across a retry: without the rejected first registration in the
      // history, the reported `dcr-retried` divergence cannot be corroborated
      // from the trace it points at.
      let priorHistory: HttpHistoryEntry[] = [];

      // The one sanctioned retry: the server named `invalid_redirect_uri` in
      // the documented RFC 7591 field, so re-register with our callback alone.
      if (!run.completed && !run.redirected) {
        const registration = registrationResponse(runState);
        if (registration && isInvalidRedirectUriRejection(registration)) {
          priorHistory = [...(runState.httpHistory ?? [])];
          attemptDivergences.push({
            kind: "dcr-retried",
            detail:
              "the authorization server rejected the replayed redirect_uris with a structured invalid_redirect_uri; re-registered with MCPJam's callback only (second and final registration)",
            requested: redirectPlan.registrationRedirectUris.join(" "),
            used: redirectPlan.authorizationRedirectUri,
          });
          wireEmulation = {
            ...wireEmulation,
            dcrRedirectUris: [redirectPlan.authorizationRedirectUri],
          };
          runState = {
            ...EMPTY_OAUTH_FLOW_STATE,
            httpHistory: [],
            infoLogs: [],
          };
          run = await runOnce();
          registrations += countRegistrationRequests(runState);
        }
      }

      const history = redactDiagnostics(
        [...priorHistory, ...(runState.httpHistory ?? [])],
        staticCredential
      );

      if (run.redirected) {
        return {
          result: {
            kind: "oauth",
            status: "redirected",
            registrationStrategy: resolvedStrategy,
            plan,
            httpHistory: history,
            detail:
              "reached the human authorization leg; no headless completion handler was supplied",
          },
          state: runState,
          outcome: "stopped_at_redirect",
          authorizationUrl: run.authorizationUrl,
          divergences: attemptDivergences,
          registrations,
          tokensIssued: 0,
          stop: true,
        };
      }

      if (run.completed) {
        const validated = isValidAuthenticatedJsonRpc(runState);
        return {
          result: {
            kind: "oauth",
            status: validated ? "ok" : "error",
            registrationStrategy: resolvedStrategy,
            plan,
            httpHistory: history,
            detail: validated
              ? undefined
              : "a token was issued but the authenticated MCP request did not return a valid JSON-RPC result",
          },
          state: runState,
          outcome: validated ? "completed" : "error",
          divergences: attemptDivergences,
          registrations,
          tokensIssued: runState.accessToken ? 1 : 0,
          stop: true,
        };
      }

      // Failed. Only fall through to the next strategy if nothing was
      // committed; otherwise the ladder stops here.
      if (hasCommittedSideEffects(runState)) {
        return {
          result: {
            kind: "oauth",
            status: "error",
            registrationStrategy: resolvedStrategy,
            plan,
            httpHistory: history,
            detail:
              run.error?.message ??
              "the OAuth attempt failed after it had already registered or begun authorization",
          },
          state: runState,
          outcome: "error",
          divergences: attemptDivergences,
          registrations,
          // A token the AS already issued is a side effect whether or not the
          // attempt went on to succeed — reporting 0 here would understate
          // what this run caused.
          tokensIssued: runState.accessToken ? 1 : 0,
          stop: true,
        };
      }

      fallenThrough.push({
        strategy: resolvedStrategy,
        detail:
          run.error?.message ??
          "attempt failed before registering or beginning authorization",
        httpHistory: history,
      });
    }

    const exhaustedDetail = [
      ...fallenThrough.map(
        (entry) => `${entry.strategy}: ${entry.detail}`
      ),
      ...(lastBlockedPlan?.blockers ?? []),
    ].join(" | ");

    return {
      result: {
        kind: "oauth",
        status: "blocked",
        plan: lastBlockedPlan,
        // Every strategy's trace, in the order they were tried, so a blocked
        // ladder can be explained rather than merely reported.
        httpHistory: fallenThrough.flatMap((entry) => entry.httpHistory),
        detail:
          exhaustedDetail ||
          "no registration mechanism in the emulated client's preference is usable against this server",
      },
      outcome: "blocked",
      divergences: attemptDivergences,
      registrations,
      tokensIssued: 0,
      stop: false,
    };
  };

  /**
   * A transport failure on a direct rung (timeout, DNS, blocked host) is a
   * finding about the server, not a crash: record it and return the documented
   * result rather than rejecting out of the runner.
   */
  const tryProbe = async (
    extraHeaders: Record<string, string>
  ): Promise<
    { ok: true; response: OAuthRequestResult } | { ok: false; message: string }
  > => {
    try {
      return { ok: true, response: await probeMcp(extraHeaders) };
    } catch (thrown) {
      return {
        ok: false,
        message: redactDiagnostics(
          thrown instanceof Error ? thrown.message : String(thrown),
          staticCredential
        ),
      };
    }
  };

  for (const attempt of derived.authAttempts) {
    if (attempt.kind === "none") {
      const probe = await tryProbe({});
      if (!probe.ok) {
        attempts.push({
          kind: "none",
          status: "error",
          detail: probe.message,
        });
        outcome = "error";
        error = { message: probe.message };
        break;
      }
      const response = probe.response;
      const ok = response.ok;
      attempts.push({
        kind: "none",
        status: ok ? "ok" : "unauthorized",
        httpHistory: redactDiagnostics(
          [
            {
              step: "request_without_token",
              timestamp: 0,
              request: { method: "POST", url: serverUrl, headers: {} },
              response,
            } as HttpHistoryEntry,
          ],
          staticCredential
        ),
        detail: ok
          ? undefined
          : `the emulated client models no authentication, and the server answered ${response.status}`,
      });
      outcome = ok ? "unauthenticated_ok" : "blocked";
      break;
    }

    if (attempt.kind === "api-key") {
      if (!staticCredential) {
        attempts.push({
          kind: "api-key",
          status: "skipped",
          detail:
            "the emulated client prefers a static credential, but none was supplied",
        });
        divergences.push({
          kind: "not-enforced",
          detail:
            "api-key rung skipped: no static credential was supplied, and the runner never invents one",
        });
        continue;
      }

      const probe = await tryProbe({
        [staticCredential.headerName]: staticCredential.value,
      });
      if (!probe.ok) {
        attempts.push({
          kind: "api-key",
          status: "error",
          detail: probe.message,
        });
        outcome = "error";
        error = { message: probe.message };
        break;
      }
      const response = probe.response;
      const history = redactDiagnostics(
        [
          {
            step: "request_without_token",
            timestamp: 0,
            request: {
              method: "POST",
              url: serverUrl,
              headers: { [staticCredential.headerName]: staticCredential.value },
            },
            response,
          } as HttpHistoryEntry,
        ],
        staticCredential
      );

      if (response.ok) {
        attempts.push({ kind: "api-key", status: "ok", httpHistory: history });
        outcome = "static_credential_ok";
        break;
      }

      // Only an evidence-backed 401 lets a static credential fall through to
      // OAuth. Any other status is a different failure, and continuing would
      // misreport its cause.
      if (response.status === 401) {
        attempts.push({
          kind: "api-key",
          status: "unauthorized",
          httpHistory: history,
          detail: "server rejected the static credential with 401; falling through to the client's next mechanism",
        });
        continue;
      }

      attempts.push({
        kind: "api-key",
        status: "error",
        httpHistory: history,
        detail: `server answered ${response.status} to the static credential; only a 401 authorizes falling through to OAuth`,
      });
      outcome = "error";
      error = {
        message: `Static credential attempt failed with ${response.status}.`,
      };
      break;
    }

    const attemptOutput = await runOAuthAttempt(attempt);
    attempts.push(attemptOutput.result);
    sideEffects.dcrRegistrations += attemptOutput.registrations;
    sideEffects.tokensIssued += attemptOutput.tokensIssued;
    // Redirect divergences describe the registration body, so they are only
    // true once a registration actually ran.
    if (attemptOutput.registrations > 0 && !redirectDivergencesDeclared) {
      divergences.push(...redirectPlan.divergences);
      redirectDivergencesDeclared = true;
    }
    divergences.push(...attemptOutput.divergences);

    if (attemptOutput.outcome) outcome = attemptOutput.outcome;
    if (attemptOutput.authorizationUrl) {
      authorizationUrl = attemptOutput.authorizationUrl;
    }
    if (attemptOutput.state) {
      const { accessToken, refreshToken, clientId, clientSecret } =
        attemptOutput.state;
      if (accessToken || refreshToken || clientId || clientSecret) {
        credentials = {
          ...(accessToken ? { accessToken } : {}),
          ...(refreshToken ? { refreshToken } : {}),
          ...(clientId ? { clientId } : {}),
          ...(clientSecret ? { clientSecret } : {}),
        };
      }
    }
    if (attemptOutput.result.status === "error") {
      error = {
        message: attemptOutput.result.detail ?? "OAuth attempt failed.",
      };
    }
    if (attemptOutput.stop) break;
  }

  return {
    serverUrl,
    protocolVersion,
    outcome,
    coverage: derived.coverage,
    coverageSummary: derived.coverageSummary,
    comparison: "not_compared",
    attempts,
    ...(authorizationUrl ? { authorizationUrl } : {}),
    divergences,
    sideEffects,
    ...(credentials ? { credentials } : {}),
    ...(error ? { error } : {}),
  };
}
