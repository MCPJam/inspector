import { randomInt } from "node:crypto";
import { decideConformanceOutcome } from "../conformance-outcome.js";
import {
  DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
  getConformanceAuthCodeDynamicRegistrationMetadata,
  getConformanceClientCredentialsDynamicRegistrationMetadata,
} from "../oauth/client-identity.js";
import { createOAuthStateMachine } from "../oauth/state-machines/factory.js";
import { isLoopbackOAuthUrl } from "../oauth/ssrf-guard.js";
import {
  getStepInfo,
  type OAuthStepInfo,
} from "../oauth/state-machines/shared/step-metadata.js";
import {
  EMPTY_OAUTH_FLOW_STATE,
  type HttpHistoryEntry,
  type OAuthFlowState,
  type OAuthHttpRequest,
} from "../oauth/state-machines/types.js";
import { resolveResourceIndicatorValue } from "../oauth/resource-policy.js";
import { performClientCredentialsGrant } from "./auth-strategies/client-credentials.js";
import { completeHeadlessAuthorization } from "./auth-strategies/headless.js";
import {
  createInteractiveAuthorizationSession,
  type InteractiveAuthorizationSession,
} from "./auth-strategies/interactive.js";
import {
  runDcrHttpRedirectUriCheck,
  runInvalidAuthorizeRedirectCheck,
  runInvalidClientCheck,
  runInvalidTokenCheck,
  runInvalidRedirectCheck,
} from "./checks/oauth-negative.js";
import { runTokenFormatCheck } from "./checks/oauth-token-format.js";
import {
  buildUnauthenticatedMcpRequest,
  runUnauthenticatedChallengeCheck,
  runResourceMetadataChallengeCheck,
  runStaleSessionRejectionCheck,
} from "./checks/oauth-server-obligations.js";
import type { HttpServerConfig } from "../mcp-client-manager/index.js";
import { withEphemeralClient, listTools } from "../operations.js";
import {
  CONFORMANCE_CHECK_METADATA,
  type ConformanceStepId,
  type ClientCredentialsResult,
  type ConformanceResult,
  type NormalizedOAuthConformanceConfig,
  type OAuthConformanceCheckId,
  type OAuthConformanceConfig,
  type OAuthConformanceCredentials,
  type OAuthRunOutcome,
  type OAuthSkipReason,
  type StepResult,
  type TrackedRequestFn,
  type VerificationResult,
} from "./types.js";
import { normalizeOAuthConformanceConfig } from "./validation.js";

type RunCollector = {
  attempts: HttpHistoryEntry[];
};

export interface OAuthConformanceRunnerDependencies {
  createInteractiveAuthorizationSession?: typeof createInteractiveAuthorizationSession;
  completeHeadlessAuthorization?: typeof completeHeadlessAuthorization;
  performClientCredentialsGrant?: typeof performClientCredentialsGrant;
  createDefaultRedirectUrl?: () => string;
}

function cloneEmptyFlowState(): OAuthFlowState {
  return {
    ...EMPTY_OAUTH_FLOW_STATE,
    httpHistory: [],
    infoLogs: [],
  };
}

function createDefaultRedirectUrl(): string {
  return `http://127.0.0.1:${randomInt(20000, 60000)}/callback`;
}

function normalizeResponseHeaders(headers: Headers): Record<string, string> {
  const normalized: Record<string, string> = {};
  headers.forEach((value, key) => {
    normalized[key.toLowerCase()] = value;
  });
  return normalized;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return undefined;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    contentType.includes("application/json") ||
    contentType.includes("+json")
  ) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  if (
    text.startsWith("{") ||
    text.startsWith("[")
  ) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return text;
}

function serializeRequestBody(
  body: OAuthHttpRequest["body"],
  headers: Record<string, string>,
): BodyInit | undefined {
  if (body === undefined || body === null) {
    return undefined;
  }

  if (typeof body === "string" || body instanceof URLSearchParams) {
    return body;
  }

  const contentType =
    Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] ??
    "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    return new URLSearchParams(
      Object.entries(body as Record<string, string>).map(([key, value]) => [
        key,
        String(value),
      ]),
    ).toString();
  }

  return JSON.stringify(body);
}

function resolveAttempts(
  collector: RunCollector,
  stateHistoryBefore: number,
  state: OAuthFlowState,
): HttpHistoryEntry[] {
  if (collector.attempts.length > 0) {
    return collector.attempts;
  }

  return (state.httpHistory ?? []).slice(stateHistoryBefore);
}

function isConformanceCheckId(
  step: ConformanceStepId,
): step is OAuthConformanceCheckId {
  return step in CONFORMANCE_CHECK_METADATA;
}

function resolveStepInfo(step: ConformanceStepId): OAuthStepInfo {
  if (isConformanceCheckId(step)) {
    return CONFORMANCE_CHECK_METADATA[step];
  }
  return getStepInfo(step);
}

function buildStepResult(
  step: StepResult["step"],
  status: StepResult["status"],
  durationMs: number,
  logs: StepResult["logs"],
  httpAttempts: StepResult["httpAttempts"],
  error?: StepResult["error"],
  warnings?: StepResult["warnings"],
): StepResult {
  const metadata = resolveStepInfo(step);
  return {
    step,
    title: metadata.title,
    summary: metadata.summary,
    status,
    durationMs,
    logs,
    http: httpAttempts[httpAttempts.length - 1],
    httpAttempts,
    error,
    ...(warnings?.length ? { warnings } : {}),
    teachableMoments: metadata.teachableMoments,
  };
}

/**
 * Does this server require authorization at all?
 *
 * Authorization is OPTIONAL in every MCP revision — "Authorization is
 * **OPTIONAL** for MCP implementations. When supported:" is byte-identical
 * from 2025-03-26 through 2026-07-28 — so every obligation the OAuth suite
 * asserts is conditional on the server having opted in. Running the flow
 * against a server that never opted in used to march into Protected Resource
 * Metadata discovery, 404, and report a hard failure.
 *
 * The probe is a tokenless MCP `initialize`, which is the discovery trigger
 * the spec itself defines ("Attempt unauthenticated MCP request" in the
 * 2025-11-25 and 2026-07-28 discovery diagrams; 2025-03-26 states the server
 * side outright: "When authorization is required and not yet proven by the
 * client, servers **MUST** respond with _HTTP 401 Unauthorized_").
 *
 * Deliberately NOT keyed on the challenge header: from 2025-11-25 onward
 * `WWW-Authenticate` is only one of two permitted discovery mechanisms — a
 * conformant server may return a bare 401 and serve the well-known URI
 * instead — so a missing header says nothing about whether auth is required.
 * Only the absence of a challenge does.
 *
 * `"required"` and `"inconclusive"` both run the suite. Only an unambiguous
 * 2xx yields `"not-required"`, and even that is scoped: it means the server
 * did not require authorization *for this request*. Authorization may still be
 * enforced on later ones, which is why the sibling
 * `oauth_unauthenticated_challenge` check calls a 2xx unverifiable rather than
 * a violation.
 */
type AuthorizationRequirement = "required" | "not-required" | "inconclusive";

async function probeAuthorizationRequirement(
  config: NormalizedOAuthConformanceConfig,
  trackedRequest: TrackedRequestFn,
): Promise<{ requirement: AuthorizationRequirement; detail: string }> {
  try {
    const response = await trackedRequest(
      buildUnauthenticatedMcpRequest(config),
    );

    if (response.status >= 200 && response.status < 300) {
      return {
        requirement: "not-required",
        detail: `the server answered an unauthenticated initialize with HTTP ${response.status} instead of challenging`,
      };
    }

    if (response.status === 401) {
      return {
        requirement: "required",
        detail: "the server challenged an unauthenticated request with HTTP 401",
      };
    }

    return {
      requirement: "inconclusive",
      detail: `the server answered an unauthenticated initialize with HTTP ${response.status}`,
    };
  } catch (error) {
    // A transport failure says nothing about authorization. Fall through to
    // the flow so the real error surfaces there rather than being laundered
    // into "no auth required".
    return {
      requirement: "inconclusive",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildSkippedStepResult(
  step: StepResult["step"],
  skipReason: OAuthSkipReason,
  message?: string,
): StepResult {
  const result = buildStepResult(
    step,
    "skipped",
    0,
    [],
    [],
    message ? { message } : undefined,
  );
  return { ...result, skipReason };
}

/**
 * The run's verdict, from the shared vocabulary the other three suites use:
 * "nothing failed" is not "passed" when an applicable step could not run.
 * OAuth's own two states sit on top — a whole run the probe found
 * inapplicable (authorization is OPTIONAL), and a flow that never reached
 * completion, which is a failure regardless of per-step statuses. A skipped
 * step WITHOUT a `"could-not-run"` reason counts as inapplicable, so the
 * deliberate dedup-skips (a finding already owned by another check) and the
 * strategy-gated steps keep their existing verdicts.
 *
 * Exported for direct testing: no natural flow can currently produce a
 * could-not-run step while completing (the redirect URL always resolves), so
 * the incomplete branch is proven here rather than through a contrived flow.
 */
export function deriveOAuthRunOutcome(input: {
  steps: StepResult[];
  flowComplete: boolean;
  notApplicableReason?: string;
}): { outcome: OAuthRunOutcome; incompleteReason?: string } {
  if (input.notApplicableReason) {
    return { outcome: "not-applicable" };
  }
  if (!input.flowComplete) {
    return { outcome: "failed" };
  }
  const verdict = decideConformanceOutcome(
    input.steps.map((step) => ({
      id: step.step,
      status: step.status,
      ...(step.skipReason ? { skipReason: step.skipReason } : {}),
      ...(step.error?.message
        ? { error: { message: step.error.message } }
        : {}),
    })),
  );
  return verdict.outcome === "incomplete"
    ? { outcome: "incomplete", incompleteReason: verdict.incompleteReason }
    : { outcome: verdict.outcome };
}

function buildSummary(
  config: NormalizedOAuthConformanceConfig,
  steps: StepResult[],
  outcome: OAuthRunOutcome,
): string {
  if (outcome === "not-applicable") {
    return `OAuth conformance not applicable for ${config.serverUrl}: the server served an unauthenticated request instead of challenging, and authorization is OPTIONAL in ${config.protocolVersion}`;
  }

  if (outcome === "passed") {
    return `OAuth conformance passed for ${config.serverUrl} (${config.protocolVersion}, ${config.registrationStrategy})`;
  }

  if (outcome === "incomplete") {
    const unrun = steps.filter(
      (step) => step.status === "skipped" && step.skipReason === "could-not-run",
    );
    return `OAuth conformance incomplete for ${config.serverUrl}: ${unrun.length} applicable step(s) could not run (${unrun
      .map((step) => step.step)
      .join(", ")}), so the run does not establish conformance`;
  }

  const failedSteps = steps.filter((step) => step.status === "failed");
  const firstFailure = failedSteps[0];
  if (!firstFailure) {
    return `OAuth conformance failed for ${config.serverUrl}`;
  }

  // The human title, not the raw step id: `request_resource_metadata` is an
  // internal identifier and should never be what a reader sees first.
  return `OAuth conformance failed at ${firstFailure.title}: ${firstFailure.error?.message || "Unknown error"}`;
}

function buildCredentials(
  state: OAuthFlowState,
): OAuthConformanceCredentials | undefined {
  const credentials: OAuthConformanceCredentials = {
    ...(state.clientId ? { clientId: state.clientId } : {}),
    ...(state.clientSecret ? { clientSecret: state.clientSecret } : {}),
    ...(state.accessToken ? { accessToken: state.accessToken } : {}),
    ...(state.refreshToken ? { refreshToken: state.refreshToken } : {}),
    ...(state.tokenType ? { tokenType: state.tokenType } : {}),
    ...(state.expiresIn !== undefined ? { expiresIn: state.expiresIn } : {}),
  };

  return Object.keys(credentials).length > 0 ? credentials : undefined;
}

function mergeConformanceDynamicRegistration(
  config: NormalizedOAuthConformanceConfig,
  redirectUrl: string,
): NormalizedOAuthConformanceConfig["client"]["dynamicRegistration"] {
  const defaults =
    config.auth.mode === "client_credentials"
      ? getConformanceClientCredentialsDynamicRegistrationMetadata()
      : getConformanceAuthCodeDynamicRegistrationMetadata();

  const merged = {
    ...defaults,
    ...config.client.dynamicRegistration,
  };

  if (config.auth.mode === "client_credentials") {
    delete merged.redirect_uris;
    delete merged.response_types;
  } else {
    merged.redirect_uris = config.client.dynamicRegistration?.redirect_uris ?? [
      redirectUrl,
    ];
    merged.response_types = config.client.dynamicRegistration?.response_types ?? [
      "code",
    ];
  }

  return merged;
}

export class OAuthConformanceTest {
  private readonly config: NormalizedOAuthConformanceConfig;
  private readonly deps: OAuthConformanceRunnerDependencies;

  constructor(
    config: OAuthConformanceConfig,
    deps: OAuthConformanceRunnerDependencies = {},
  ) {
    this.config = normalizeOAuthConformanceConfig(config);
    this.deps = deps;
  }

  async run(): Promise<ConformanceResult> {
    const startedAt = Date.now();
    const steps: StepResult[] = [];
    let state = cloneEmptyFlowState();
    let interactiveSession: InteractiveAuthorizationSession | undefined;
    let activeCollector: RunCollector | undefined;
    let redirectUrl: string | undefined;
    /** Set when the pre-flight probe finds the server requires no auth. */
    let notApplicableReason: string | undefined;

    const updateState = (updates: Partial<OAuthFlowState>) => {
      state = { ...state, ...updates };
    };
    const getState = () => state;
    const recordOAuthCheck = async (
      fallbackStep: StepResult["step"],
      execute: () => Promise<{
        step: StepResult["step"];
        status: StepResult["status"];
        durationMs: number;
        error?: StepResult["error"];
        warnings?: StepResult["warnings"];
      }>,
    ) => {
      const beforeHistory = state.httpHistory?.length ?? 0;
      activeCollector = { attempts: [] };

      try {
        const outcome = await execute();
        const attempts = resolveAttempts(activeCollector, beforeHistory, state);
        steps.push(
          buildStepResult(
            outcome.step,
            outcome.status,
            outcome.durationMs,
            [],
            attempts,
            outcome.error,
            outcome.warnings,
          ),
        );
      } catch (error) {
        const attempts = resolveAttempts(activeCollector, beforeHistory, state);
        steps.push(
          buildStepResult(
            fallbackStep,
            "failed",
            0,
            [],
            attempts,
            {
              message: error instanceof Error ? error.message : String(error),
              details: error,
            },
          ),
        );
      } finally {
        activeCollector = undefined;
      }
    };

    try {
      if (this.config.auth.mode === "interactive") {
        interactiveSession = await (
          this.deps.createInteractiveAuthorizationSession ??
          createInteractiveAuthorizationSession
        )({
          redirectUrl: this.config.redirectUrl,
        });
      }

      redirectUrl =
        interactiveSession?.redirectUrl ??
        this.config.redirectUrl ??
        (this.deps.createDefaultRedirectUrl ?? createDefaultRedirectUrl)();

      const trackedRequest: TrackedRequestFn = async (
        request,
        options = {},
      ) => {
        const historyEntry: HttpHistoryEntry = {
          step: state.currentStep,
          timestamp: Date.now(),
          request: {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body: request.body,
          },
        };
        activeCollector?.attempts.push(historyEntry);

        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), this.config.stepTimeout);

        try {
          const response = await this.config.fetchFn(request.url, {
            method: request.method,
            headers: request.headers,
            body: serializeRequestBody(request.body, request.headers),
            redirect: options.redirect,
            signal: controller.signal,
          });

          const body = await parseResponseBody(response);
          const normalizedHeaders = normalizeResponseHeaders(response.headers);
          historyEntry.response = {
            status: response.status,
            statusText: response.statusText,
            headers: normalizedHeaders,
            body,
          };
          historyEntry.duration = Date.now() - historyEntry.timestamp;

          return {
            status: response.status,
            statusText: response.statusText,
            headers: normalizedHeaders,
            body,
            ok: response.ok,
          };
        } catch (error) {
          const duration = Date.now() - historyEntry.timestamp;
          historyEntry.duration = duration;
          historyEntry.error = {
            message:
              error instanceof Error && error.name === "AbortError"
                ? `Step timed out after ${this.config.stepTimeout}ms`
                : error instanceof Error
                  ? error.message
                  : String(error),
            details: error,
          };

          if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Step timed out after ${this.config.stepTimeout}ms`);
          }
          throw error;
        } finally {
          clearTimeout(timeoutHandle);
        }
      };

      // Pre-flight: a server that never challenges has no authorization
      // obligations to test, so the suite is not applicable rather than
      // failed. Runs for every version — 2025-03-26's machine goes straight
      // from `idle` to `discovery_start` and never probes on its own.
      const authRequirement = await probeAuthorizationRequirement(
        this.config,
        trackedRequest,
      );

      if (authRequirement.requirement === "not-required") {
        notApplicableReason = authRequirement.detail;
        // One step, not a manufactured list of every flow step that "would
        // have" run: the probe IS `request_without_token`, and it is the only
        // thing actually observed.
        steps.push(
          buildSkippedStepResult(
            "request_without_token",
            "not-applicable",
            `Authorization is OPTIONAL in ${this.config.protocolVersion} and this server does not require it — ${authRequirement.detail}`,
          ),
        );
      }

      const machine = createOAuthStateMachine({
        protocolVersion: this.config.protocolVersion,
        registrationStrategy: this.config.registrationStrategy,
        state,
        getState,
        updateState,
        serverUrl: this.config.serverUrl,
        serverName: this.config.serverName,
        redirectUrl,
        // The executor below is the caller's `fetchFn`, so the factory's
        // pre-flight guard is the only address check on this path: it has to
        // learn about the local allowance or a loopback server under test is
        // refused before its first well-known fetch.
        allowLoopbackMetadataFetch: isLoopbackOAuthUrl(this.config.serverUrl),
        allowPrivateMetadataFetch: this.config.allowPrivateNetwork,
        requestExecutor: (request) => trackedRequest(request),
        loadPreregisteredCredentials: async () => ({
          clientId: this.config.client.preregistered?.clientId,
          clientSecret: this.config.client.preregistered?.clientSecret,
        }),
        dynamicRegistration: mergeConformanceDynamicRegistration(
          this.config,
          redirectUrl,
        ),
        clientIdMetadataUrl:
          this.config.client.clientIdMetadataUrl ??
          DEFAULT_MCPJAM_CLIENT_ID_METADATA_URL,
        customScopes: this.config.scopes,
        customHeaders: this.config.customHeaders,
        authMode: this.config.auth.mode,
        strictConformance: true,
        // Fail the discovery step on unusable OR RFC 9728-noncompliant PRM
        // resource metadata so downstream negative-test results aren't
        // produced against a broken baseline. Connect surfaces intentionally
        // retain a looser interoperability posture.
        resourceIndicatorEnforcement: "reject-rfc9728",
      });

      let guard = 0;
      while (
        !notApplicableReason &&
        state.currentStep !== "complete" &&
        guard < 40
      ) {
        guard += 1;

        if (
          this.config.auth.mode === "client_credentials" &&
          state.currentStep === "received_client_credentials"
        ) {
          // The client_credentials grant has no user-agent leg, so PKCE and
          // the authorization round-trip do not exist for it to violate.
          for (const step of [
            "generate_pkce_parameters",
            "authorization_request",
            "received_authorization_code",
          ] as const) {
            steps.push(
              buildSkippedStepResult(
                step,
                "not-applicable",
                "The client_credentials grant has no authorization-code leg",
              ),
            );
          }

          if (!state.authorizationServerMetadata?.token_endpoint) {
            steps.push(
              buildStepResult("token_request", "failed", 0, [], [], {
                message: "Missing token endpoint for client_credentials flow",
              }),
            );
            break;
          }

          if (
            this.config.registrationStrategy === "dcr" &&
            (!state.clientId || !state.clientSecret)
          ) {
            steps.push(
              buildStepResult("token_request", "failed", 0, [], [], {
                message:
                  "Dynamic registration produced a public client and cannot be used for client_credentials",
              }),
            );
            break;
          }

          const tokenClientId =
            state.clientId || this.config.auth.clientId;
          const tokenClientSecret =
            state.clientSecret || this.config.auth.clientSecret;

          const beforeLogs = state.infoLogs?.length ?? 0;
          const beforeHistory = state.httpHistory?.length ?? 0;
          activeCollector = { attempts: [] };
          const stepStartedAt = Date.now();

          try {
            const tokenResult: ClientCredentialsResult = await (
              this.deps.performClientCredentialsGrant ??
              performClientCredentialsGrant
            )({
              tokenEndpoint: state.authorizationServerMetadata.token_endpoint,
              clientId: tokenClientId,
              clientSecret: tokenClientSecret,
              tokenEndpointAuthMethod: state.tokenEndpointAuthMethod,
              scope: this.config.scopes,
              resource: resolveResourceIndicatorValue({
                serverUrl: this.config.serverUrl,
                prmResource: state.resourceMetadata?.resource,
                resolved: state.resourceIndicator,
              }),
              request: trackedRequest,
            });

            const durationMs = Date.now() - stepStartedAt;
            const logs = (state.infoLogs ?? []).slice(beforeLogs);
            const attempts = resolveAttempts(activeCollector, beforeHistory, state);
            steps.push(
              buildStepResult("token_request", "passed", durationMs, logs, attempts),
            );

            updateState({
              currentStep: "received_access_token",
              accessToken: tokenResult.accessToken,
              refreshToken: tokenResult.refreshToken,
              tokenType: tokenResult.tokenType,
              expiresIn: tokenResult.expiresIn,
              lastResponse: {
                status: tokenResult.tokenResponse.status,
                statusText: tokenResult.tokenResponse.statusText,
                headers: tokenResult.tokenResponse.headers,
                body: tokenResult.tokenResponse.body,
              },
              error: undefined,
            });

            steps.push(buildStepResult("received_access_token", "passed", 0, [], []));
          } catch (error) {
            const durationMs = Date.now() - stepStartedAt;
            const logs = (state.infoLogs ?? []).slice(beforeLogs);
            const attempts = resolveAttempts(activeCollector, beforeHistory, state);
            steps.push(
              buildStepResult("token_request", "failed", durationMs, logs, attempts, {
                message:
                  error instanceof Error ? error.message : String(error),
                details: error,
              }),
            );
            break;
          } finally {
            activeCollector = undefined;
          }

          continue;
        }

        if (state.currentStep === "authorization_request") {
          if (!state.authorizationUrl) {
            steps.push(
              buildStepResult("received_authorization_code", "failed", 0, [], [], {
                message: "Authorization URL was not generated",
              }),
            );
            break;
          }

          const beforeLogs = state.infoLogs?.length ?? 0;
          const beforeHistory = state.httpHistory?.length ?? 0;
          activeCollector = { attempts: [] };
          const stepStartedAt = Date.now();

          try {
            const authorizationResult =
              this.config.auth.mode === "interactive"
                ? await interactiveSession!.authorize({
                    authorizationUrl: state.authorizationUrl,
                    expectedState: state.state,
                    timeoutMs: this.config.stepTimeout,
                    openUrl: this.config.auth.openUrl,
                  })
                : await (
                    this.deps.completeHeadlessAuthorization ??
                    completeHeadlessAuthorization
                  )({
                    authorizationUrl: state.authorizationUrl,
                    redirectUrl,
                    expectedState: state.state,
                    request: trackedRequest,
                  });

            updateState({
              currentStep: "received_authorization_code",
              authorizationCode: authorizationResult.code,
              error: undefined,
            });

            const durationMs = Date.now() - stepStartedAt;
            const logs = (state.infoLogs ?? []).slice(beforeLogs);
            const attempts = resolveAttempts(activeCollector, beforeHistory, state);
            steps.push(
              buildStepResult(
                "received_authorization_code",
                "passed",
                durationMs,
                logs,
                attempts,
              ),
            );
          } catch (error) {
            updateState({
              currentStep: "received_authorization_code",
              error: error instanceof Error ? error.message : String(error),
            });
            const durationMs = Date.now() - stepStartedAt;
            const logs = (state.infoLogs ?? []).slice(beforeLogs);
            const attempts = resolveAttempts(activeCollector, beforeHistory, state);
            steps.push(
              buildStepResult(
                "received_authorization_code",
                "failed",
                durationMs,
                logs,
                attempts,
                {
                  message:
                    error instanceof Error ? error.message : String(error),
                  details: error,
                },
              ),
            );
            break;
          } finally {
            activeCollector = undefined;
          }

          continue;
        }

        const startStep = state.currentStep;
        const beforeLogs = state.infoLogs?.length ?? 0;
        const beforeHistory = state.httpHistory?.length ?? 0;
        activeCollector = { attempts: [] };
        const stepStartedAt = Date.now();

        await machine.proceedToNextStep();

        const durationMs = Date.now() - stepStartedAt;
        const logs = (state.infoLogs ?? []).slice(beforeLogs);
        const attempts = resolveAttempts(activeCollector, beforeHistory, state);
        activeCollector = undefined;

        if (state.currentStep === startStep) {
          const failure = buildStepResult(
            startStep,
            "failed",
            durationMs,
            logs,
            attempts,
            {
              message: state.error || `Step ${startStep} did not advance`,
            },
          );

          // A successful iteration is named for the state it REACHED, so the
          // row directly above is the transition into `startStep` — same step,
          // no work of its own. A failure is named for the step that ran, so
          // appending here would print the same title twice: once green for
          // arriving, once red for the attempt. Fold them into the one row the
          // reader expects, keeping the transition's timing and evidence.
          const previous = steps[steps.length - 1];
          if (previous && previous.step === startStep) {
            steps[steps.length - 1] = {
              ...failure,
              durationMs: previous.durationMs + failure.durationMs,
              logs: [...previous.logs, ...failure.logs],
              httpAttempts: [...previous.httpAttempts, ...failure.httpAttempts],
              http: failure.http ?? previous.http,
            };
          } else {
            steps.push(failure);
          }
          break;
        }

        steps.push(
          buildStepResult(state.currentStep, "passed", durationMs, logs, attempts),
        );
      }

      if (!notApplicableReason && guard >= 40 && state.currentStep !== "complete") {
        steps.push(
          buildStepResult(state.currentStep, "failed", 0, [], [], {
            message: "OAuth conformance runner exceeded its step guard",
          }),
        );
      }

      if (
        state.currentStep === "complete" &&
        steps.every((step) => step.status !== "failed") &&
        this.config.oauthConformanceChecks
      ) {
        const oauthCheckRedirectUrl = redirectUrl;
        await recordOAuthCheck("oauth_dcr_http_redirect_uri", () =>
          runDcrHttpRedirectUriCheck({
            config: this.config,
            state,
            trackedRequest,
            redirectUrl: oauthCheckRedirectUrl,
          }),
        );
        await recordOAuthCheck("oauth_invalid_client", () =>
          runInvalidClientCheck({
            config: this.config,
            state,
            trackedRequest,
            redirectUrl: oauthCheckRedirectUrl,
          }),
        );
        await recordOAuthCheck("oauth_invalid_authorize_redirect", () =>
          runInvalidAuthorizeRedirectCheck({
            config: this.config,
            state,
            trackedRequest,
            redirectUrl: oauthCheckRedirectUrl,
          }),
        );
        await recordOAuthCheck("oauth_invalid_token", () =>
          runInvalidTokenCheck({
            config: this.config,
            state,
            trackedRequest,
            redirectUrl: oauthCheckRedirectUrl,
          }),
        );
        if (oauthCheckRedirectUrl) {
          await recordOAuthCheck("oauth_invalid_redirect", () =>
            runInvalidRedirectCheck({
              config: this.config,
              state,
              trackedRequest,
              redirectUrl: oauthCheckRedirectUrl,
            }),
          );
        } else {
          // The check applies, but with no redirect URL there is nothing to
          // mismatch — untested, not inapplicable.
          steps.push(
            buildSkippedStepResult(
              "oauth_invalid_redirect",
              "could-not-run",
              "No redirect URL was available to mismatch against",
            ),
          );
        }

        // Server-side spec obligations (HP-17 findings 3/4/5). These probe the
        // server independently of the client-capability matrix; a violation is
        // a hard failure against normative spec text.
        await recordOAuthCheck("oauth_unauthenticated_challenge", () =>
          runUnauthenticatedChallengeCheck({
            config: this.config,
            state,
            trackedRequest,
          }),
        );
        await recordOAuthCheck("oauth_resource_metadata_challenge", () =>
          runResourceMetadataChallengeCheck({
            config: this.config,
            state,
            trackedRequest,
          }),
        );
        await recordOAuthCheck("oauth_stale_session_rejection", () =>
          runStaleSessionRejectionCheck({
            config: this.config,
            state,
            trackedRequest,
          }),
        );

        const tokenRequestStep = [...steps]
          .reverse()
          .find((step) => step.step === "token_request");
        const tokenFormatOutcome = runTokenFormatCheck({
          tokenRequestStep,
          state,
        });
        steps.push(
          buildStepResult(
            tokenFormatOutcome.step,
            tokenFormatOutcome.status,
            tokenFormatOutcome.durationMs,
            [],
            [],
            tokenFormatOutcome.error,
          ),
        );
      }
    } finally {
      await interactiveSession?.stop().catch(() => undefined);
    }

    const derived = deriveOAuthRunOutcome({
      steps,
      flowComplete: state.currentStep === "complete",
      notApplicableReason,
    });
    let outcome: OAuthRunOutcome = derived.outcome;
    let incompleteReason = derived.incompleteReason;
    let passed = outcome === "passed";

    // ── Post-auth verification ────────────────────────────────────────
    let verification: VerificationResult | undefined;

    if (passed && this.config.verification.listTools && state.accessToken) {
      verification = {};
      const verifyConfig: HttpServerConfig = {
        url: this.config.serverUrl,
        accessToken: state.accessToken,
        requestInit: this.config.customHeaders
          ? { headers: this.config.customHeaders }
          : undefined,
        timeout: this.config.verification.timeout ?? 30_000,
        // Post-auth verification must speak the negotiated wire era. For 2026
        // the MCP endpoint is stateless (no initialize), so pin the transport;
        // older OAuth flows keep the legacy default (unset).
        ...(this.config.protocolVersion === "2026-07-28"
          ? { mcpProtocolVersion: "2026-07-28" as const }
          : {}),
      };
      try {
        await withEphemeralClient(
          verifyConfig,
          async (manager, serverId) => {
            // List tools
            const listStart = Date.now();
            try {
              const toolsResult = await listTools(manager, { serverId });
              const listDuration = Date.now() - listStart;
              verification!.listTools = {
                passed: true,
                toolCount: toolsResult.tools.length,
                durationMs: listDuration,
              };
              steps.push(
                buildStepResult("verify_list_tools", "passed", listDuration, [], []),
              );
            } catch (error) {
              const listDuration = Date.now() - listStart;
              const message = error instanceof Error ? error.message : String(error);
              verification!.listTools = {
                passed: false,
                durationMs: listDuration,
                error: message,
              };
              steps.push(
                buildStepResult("verify_list_tools", "failed", listDuration, [], [], {
                  message,
                }),
              );
              passed = false;
              outcome = "failed";
              return;
            }

            // Call tool (optional)
            const callToolConfig = this.config.verification.callTool;
            if (callToolConfig) {
              const callStart = Date.now();
              try {
                await manager.executeTool(
                  serverId,
                  callToolConfig.name,
                  callToolConfig.params ?? {},
                );
                const callDuration = Date.now() - callStart;
                verification!.callTool = {
                  passed: true,
                  toolName: callToolConfig.name,
                  durationMs: callDuration,
                };
                steps.push(
                  buildStepResult("verify_call_tool", "passed", callDuration, [], []),
                );
              } catch (error) {
                const callDuration = Date.now() - callStart;
                const message = error instanceof Error ? error.message : String(error);
                verification!.callTool = {
                  passed: false,
                  toolName: callToolConfig.name,
                  durationMs: callDuration,
                  error: message,
                };
                steps.push(
                  buildStepResult("verify_call_tool", "failed", callDuration, [], [], {
                    message,
                  }),
                );
                passed = false;
                outcome = "failed";
              }
            }
          },
          { serverId: "__conformance_verify__", timeout: this.config.verification.timeout ?? 30_000 },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        verification.listTools = {
          passed: false,
          durationMs: 0,
          error: message,
        };
        steps.push(
          buildStepResult("verify_list_tools", "failed", 0, [], [], { message }),
        );
        passed = false;
        outcome = "failed";
      }
    }

    const durationMs = Date.now() - startedAt;

    return {
      passed,
      outcome,
      ...(incompleteReason ? { incompleteReason } : {}),
      protocolVersion: this.config.protocolVersion,
      registrationStrategy: this.config.registrationStrategy,
      serverUrl: this.config.serverUrl,
      steps,
      summary: buildSummary(this.config, steps, outcome),
      durationMs,
      credentials: buildCredentials(state),
      verification,
    };
  }
}
