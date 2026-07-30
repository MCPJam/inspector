/**
 * Pure snapshot shaping for the oauth-flow surface.
 *
 * The OAuth debugger's flow state is wall-to-wall secrets: tokens, PKCE
 * verifiers, authorization codes, the client secret, and full raw HTTP
 * request/response bodies. Everything a snapshot emits lands in the chat
 * transcript (and crosses to the server), so shaping lives HERE, in a pure
 * builder with a denylist test — not inline in the component.
 *
 * Redaction strategy, in layers:
 * - `OAuthFlowStateView` structurally OMITS the sensitive fields (accessToken,
 *   refreshToken, clientSecret, codeVerifier/Challenge, authorizationCode,
 *   `state`, authorizationUrl, wwwAuthenticateHeader, lastRequest), so builder
 *   code cannot read them. Token PRESENCE arrives as booleans computed at the
 *   call site.
 * - The fields that are present but tainted are reduced to safe projections:
 *   `error` → presence + allowlisted OAuth error code, `lastResponse` →
 *   status/statusText (+ code extraction from its body), `httpHistory` →
 *   length, `infoLogs` → counts by level.
 * - Sequence-diagram steps pass through `toSafeSequenceSteps`, which keeps
 *   ONLY `id`/`label` (static strings) — `description`/`details` carry URLs,
 *   challenges, and token material. Ids are opaque diagram ids, not
 *   necessarily `OAuthFlowStep` values (the builders also emit e.g.
 *   `browser_to_auth_server`), so they are never cross-referenced with step
 *   indices.
 */

import { getStepIndex, type OAuthFlowStep } from "@mcpjam/sdk/browser";
import { extractOauthErrorCode } from "./oauth-error-code";

/**
 * The two steps where the Continue button (and `ui_advance_oauth_flow`) hand
 * off to the human sign-in popup instead of advancing the machine.
 */
export function isAwaitingHumanAuthorization(step: OAuthFlowStep): boolean {
  return step === "generate_pkce_parameters" || step === "authorization_request";
}

/**
 * The safe projection of `OAuthFlowState`. Sensitive fields are ABSENT from
 * this type on purpose — the real state object satisfies it structurally, but
 * builder code cannot reach what isn't declared.
 */
export interface OAuthFlowStateView {
  currentStep: OAuthFlowStep;
  isInitiatingAuth: boolean;
  serverUrl?: string;
  authorizationServerUrl?: string;
  tokenType?: string;
  expiresIn?: number;
  /** Reduced to presence + allowlisted code — never emitted verbatim. */
  error?: string;
  /** Only status/statusText survive; the body is used for code extraction. */
  lastResponse?: { status: number; statusText: string; body?: unknown };
  /** Reduced to a count. */
  httpHistory?: ReadonlyArray<unknown>;
  /** Reduced to counts by level. */
  infoLogs?: ReadonlyArray<{ level: "info" | "warning" | "error" }>;
}

export interface OAuthFlowSnapshotInput {
  hasProfile: boolean;
  serverName?: string;
  protocolVersion?: string;
  /** Human-readable registration label (e.g. "Dynamic (DCR)"). */
  registrationStrategy?: string;
  scopes?: string;
  /** Public client identifier — the one identity field that is not a secret. */
  clientId?: string;
  customHeaderCount: number;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  serverConnected: boolean;
  readyToApplyTokens: boolean;
  /** Pre-stripped via `toSafeSequenceSteps`. */
  steps: ReadonlyArray<{ id: string; label: string }>;
  view: OAuthFlowStateView;
}

export interface OAuthFlowSnapshot {
  configured: boolean;
  target: {
    serverName?: string;
    serverUrl?: string;
    authorizationServerUrl?: string;
    protocolVersion?: string;
    registrationStrategy?: string;
    scopes?: string;
    clientId?: string;
    customHeaderCount: number;
  } | null;
  flow: {
    currentStep: OAuthFlowStep;
    stepIndex: number | null;
    isInitiatingAuth: boolean;
    complete: boolean;
    awaitingHumanAuthorization: boolean;
    steps: Array<{ id: string; label: string }>;
  };
  tokens: {
    hasAccessToken: boolean;
    hasRefreshToken: boolean;
    tokenType?: string;
    expiresInSeconds?: number;
  };
  lastHttp: { status: number; statusText: string } | null;
  error: { present: true; oauthErrorCode?: string } | null;
  counts: {
    httpRequests: number;
    infoLogs: { info: number; warning: number; error: number };
  };
  readyToApplyTokens: boolean;
  serverConnected: boolean;
}

/**
 * Keep ONLY the static identity of each diagram action. Never widen this —
 * `description` and `details` are where dynamic values (URLs, challenges,
 * token material) live.
 */
export function toSafeSequenceSteps(
  actions: ReadonlyArray<{ id: string; label: string }>,
): Array<{ id: string; label: string }> {
  return actions.map((action) => ({ id: action.id, label: action.label }));
}

export function buildOAuthFlowSnapshot(
  input: OAuthFlowSnapshotInput,
): OAuthFlowSnapshot {
  const { view } = input;
  const stepIndex = getStepIndex(view.currentStep);
  const oauthErrorCode = extractOauthErrorCode(view.error, view.lastResponse);

  const logCounts = { info: 0, warning: 0, error: 0 };
  for (const entry of view.infoLogs ?? []) {
    if (entry.level in logCounts) logCounts[entry.level] += 1;
  }

  return {
    configured: input.hasProfile,
    target: input.hasProfile
      ? {
          serverName: input.serverName,
          serverUrl: view.serverUrl,
          authorizationServerUrl: view.authorizationServerUrl,
          protocolVersion: input.protocolVersion,
          registrationStrategy: input.registrationStrategy,
          scopes: input.scopes,
          clientId: input.clientId,
          customHeaderCount: input.customHeaderCount,
        }
      : null,
    flow: {
      currentStep: view.currentStep,
      stepIndex: stepIndex === Number.MAX_SAFE_INTEGER ? null : stepIndex,
      isInitiatingAuth: view.isInitiatingAuth,
      complete: view.currentStep === "complete",
      awaitingHumanAuthorization: isAwaitingHumanAuthorization(
        view.currentStep,
      ),
      steps: toSafeSequenceSteps(input.steps),
    },
    tokens: {
      hasAccessToken: input.hasAccessToken,
      hasRefreshToken: input.hasRefreshToken,
      tokenType: view.tokenType,
      expiresInSeconds: view.expiresIn,
    },
    lastHttp: view.lastResponse
      ? {
          status: view.lastResponse.status,
          statusText: view.lastResponse.statusText,
        }
      : null,
    error: view.error
      ? { present: true, ...(oauthErrorCode ? { oauthErrorCode } : {}) }
      : null,
    counts: {
      httpRequests: view.httpHistory?.length ?? 0,
      infoLogs: logCounts,
    },
    readyToApplyTokens: input.readyToApplyTokens,
    serverConnected: input.serverConnected,
  };
}
