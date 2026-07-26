import {
  clearOAuthData,
  initiateOAuth,
  readStoredOAuthConfig,
  resolveStoredIssuer,
  MCPOAuthOptions,
} from "@/lib/oauth/mcp-oauth";
import { normalizeRegistrationMode } from "@/shared/xaa.js";
import { ServerWithName } from "./app-types";
import type { OAuthTrace } from "@/lib/oauth/oauth-trace";
import {
  resolveStepUpAction,
  type StepUpAction,
  type StepUpAuthMode,
} from "@mcpjam/sdk/browser";
import {
  persistRequestedScopes,
  stepUpScopeUnion,
} from "@/lib/oauth/requested-scopes";

export type OAuthReady = {
  kind: "ready";
  serverConfig: any;
  tokens?: any;
  oauthTrace?: OAuthTrace;
};
export type OAuthRedirect = { kind: "redirect" };
export type OAuthReauthRequired = {
  kind: "reauth_required";
  error: string;
  oauthTrace?: OAuthTrace;
};
export type OAuthError = { kind: "error"; error: string; oauthTrace?: OAuthTrace };
export type OAuthResult =
  | OAuthReady
  | OAuthRedirect
  | OAuthReauthRequired
  | OAuthError;

function buildOAuthReauthRequired(
  serverName: string,
  oauthTrace?: OAuthTrace,
): OAuthReauthRequired {
  return {
    kind: "reauth_required",
    error: `OAuth consent is required for ${serverName}. Click Reconnect to continue.`,
    oauthTrace,
  };
}

function parseOAuthScopes(scopes?: string | string[]): string[] | undefined {
  const parsed = Array.isArray(scopes)
    ? scopes
    : scopes?.split(/[,\s]+/);
  const normalized = parsed?.map((scope) => scope.trim()).filter(Boolean);
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function sanitizeOAuthSetupHeaders(
  headers?: Record<string, string>,
): Record<string, string> | undefined {
  if (!headers) return undefined;

  const sanitized = Object.fromEntries(
    Object.entries(headers).filter(
      ([key, value]) =>
        key.toLowerCase() !== "authorization" &&
        typeof value === "string" &&
        value !== "",
    ),
  );
  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function readStoredClientInfo(serverName: string): {
  client_id?: string;
} {
  try {
    const raw = localStorage.getItem(`mcp-client-${serverName}`);
    if (!raw) return {};

    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "client_secret" in parsed) {
      localStorage.setItem(
        `mcp-client-${serverName}`,
        JSON.stringify({ client_id: nonEmptyString(parsed?.client_id) }),
      );
    }
    return {
      client_id: nonEmptyString(parsed?.client_id),
    };
  } catch {
    return {};
  }
}

function normalizeHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers) return undefined;

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return sanitizeOAuthSetupHeaders(Object.fromEntries(headers.entries()));
  }

  if (Array.isArray(headers)) {
    const entries = headers.filter(
      (entry): entry is [string, string] =>
        Array.isArray(entry) &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "string",
    );
    return sanitizeOAuthSetupHeaders(Object.fromEntries(entries));
  }

  if (typeof headers === "object") {
    const entries = Object.entries(headers).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    return sanitizeOAuthSetupHeaders(Object.fromEntries(entries));
  }

  return undefined;
}

function profileHeadersToRecord(
  headers?: Array<{ key: string; value: string }>,
): Record<string, string> | undefined {
  const entries = headers
    ?.map(({ key, value }) => [key.trim(), value] as const)
    .filter(([key, value]) => key && value);
  return entries && entries.length > 0
    ? sanitizeOAuthSetupHeaders(Object.fromEntries(entries))
    : undefined;
}

function buildReconnectOAuthOptions(
  server: ServerWithName,
  serverUrl: string,
  /**
   * SEP-2350 step-up: the union of previously-requested and challenged scopes.
   * When present it WINS over the profile/config scopes so the re-authorization
   * requests the widened set the `403 insufficient_scope` challenge named —
   * otherwise the fresh flow would re-request the old (insufficient) scopes and
   * loop. Only used when a caller drives a scope step-up.
   */
  stepUpScopes?: string[],
  /**
   * SEP-2350 step-up: the `resource_metadata` URL a `403 insufficient_scope`
   * challenge advertised, ALREADY validated same-origin by the caller. When
   * present the fresh OAuth flow discovers protected-resource metadata from
   * this URL instead of re-deriving it from the server URL — so a server that
   * points its metadata elsewhere (Asana) is honored on re-authorization.
   */
  resourceMetadataUrl?: string,
): MCPOAuthOptions {
  const oauthConfig = readStoredOAuthConfig(server.name);
  const storedClientInfo = readStoredClientInfo(server.name);
  const profile = server.oauthFlowProfile;
  const protocolMode =
    profile?.protocolVersion ?? oauthConfig.protocolMode ?? "auto";
  // The CANONICAL per-server registrationMode wins — it can be "auto" (resolve
  // from current server metadata at connect time), while the legacy
  // profile/localStorage values are rollback-compat concretes. Preferring a
  // concrete here would pin every reconnect to it and "auto" would never
  // dynamically resolve again.
  const registrationMode =
    normalizeRegistrationMode(server.registrationMode) ??
    profile?.registrationStrategy ??
    oauthConfig.registrationMode ??
    "auto";
  const profileScopes = parseOAuthScopes(profile?.scopes);
  const effectiveScopes =
    stepUpScopes && stepUpScopes.length > 0
      ? stepUpScopes
      : profileScopes ?? oauthConfig.scopes;

  return {
    serverName: server.name,
    serverUrl,
    scopes: effectiveScopes,
    // Preserve `undefined` as the default so a non-step-up reconnect never
    // pins an override and discovery keeps deriving the URL as it does today.
    resourceMetadataUrl: nonEmptyString(resourceMetadataUrl),
    resourceUrl: nonEmptyString(profile?.resourceUrl) ?? oauthConfig.resourceUrl,
    customHeaders:
      profileHeadersToRecord(profile?.customHeaders) ??
      normalizeHeaders((server.config as any)?.requestInit?.headers) ??
      sanitizeOAuthSetupHeaders(oauthConfig.customHeaders),
    registryServerId: oauthConfig.registryServerId,
    useRegistryOAuthProxy: oauthConfig.useRegistryOAuthProxy,
    clientId:
      nonEmptyString(server.oauthTokens?.client_id) ??
      nonEmptyString(profile?.clientId) ??
      storedClientInfo.client_id,
    clientSecret: undefined,
    hasClientSecret: Boolean(server.hasClientSecret),
    protocolMode,
    protocolVersion:
      protocolMode !== "auto"
        ? protocolMode
        : profile?.protocolVersion ?? oauthConfig.protocolVersion,
    registrationMode,
    registrationStrategy:
      registrationMode !== "auto"
        ? registrationMode
        : profile?.registrationStrategy ?? oauthConfig.registrationStrategy,
  };
}

export async function ensureAuthorizedForReconnect(
  server: ServerWithName,
  options?: {
    beforeRedirect?: (oauthOptions: MCPOAuthOptions) => void;
    onTraceUpdate?: (trace: OAuthTrace) => void;
    allowInteractiveOAuthFlow?: boolean;
    /**
     * Set by the reconnect path after the user explicitly confirmed Auto's
     * OAuth escalation. Without it, a tokenless Auto server is treated as
     * ready-unauthenticated (discover semantics) — never front-run a
     * redirect the user didn't ask for.
     */
    interactiveOAuthConfirmed?: boolean;
    /**
     * SEP-2350 step-up scope union. When set, the fresh OAuth flow requests
     * these scopes (the union of previously-requested and `403
     * insufficient_scope`-challenged scopes) instead of the stored profile
     * scopes. Set by the step-up re-authorization path
     * ({@link resolveInsufficientScopeStepUp}).
     */
    stepUpScopes?: string[];
    /**
     * SEP-2350 step-up: the `resource_metadata` URL the challenge advertised,
     * ALREADY validated same-origin by the caller ({@link applyToolCallStepUp}).
     * Threaded into the fresh OAuth flow so PRM discovery uses it instead of
     * re-deriving from the server URL. `undefined` keeps today's behavior.
     */
    resourceMetadataUrl?: string;
  },
): Promise<OAuthResult> {
  // If server is explicitly configured without OAuth, skip OAuth flow entirely
  // This handles the case where a server was saved with "No Authentication"
  if (server.useOAuth === false) {
    // Also clear any lingering OAuth data in localStorage
    clearOAuthData(server.name);
    return { kind: "ready", serverConfig: server.config, tokens: undefined };
  }

  // If useOAuth is not explicitly true and there are no OAuth tokens,
  // skip OAuth (handles legacy servers and non-OAuth connections)
  if (server.useOAuth !== true && !server.oauthTokens) {
    // Clear any lingering OAuth data that might cause confusion
    clearOAuthData(server.name);
    return { kind: "ready", serverConfig: server.config, tokens: undefined };
  }

  // Auto (discover) servers carry useOAuth: true as a derived mirror, but a
  // tokenless Auto server connects unauthenticated by design — the connect
  // surfaces tag a real 401 and the reconnect path asks the user before
  // coming back here with interactiveOAuthConfirmed. Without this guard,
  // every auto-connect loop (load, client switch) would surprise-redirect
  // open Auto servers into OAuth.
  if (
    server.authMethod === "auto" &&
    !server.oauthTokens &&
    options?.interactiveOAuthConfirmed !== true
  ) {
    return { kind: "ready", serverConfig: server.config, tokens: undefined };
  }

  const storedServerUrl = localStorage.getItem(`mcp-serverUrl-${server.name}`);
  const url = (server.config as any)?.url?.toString?.() || storedServerUrl;

  if (options?.allowInteractiveOAuthFlow === false) {
    if (url) {
      return buildOAuthReauthRequired(server.name);
    }
    return {
      kind: "error",
      error: "OAuth authorization required and no URL present",
    };
  }

  // Fallback to a fresh OAuth flow if URL is present
  // This may redirect away; the hook should reflect oauth-flow state
  if (url) {
    const opts = buildReconnectOAuthOptions(
      server,
      url,
      options?.stepUpScopes,
      options?.resourceMetadataUrl,
    );
    clearOAuthData(server.name);
    options?.beforeRedirect?.(opts);
    opts.onTraceUpdate = options?.onTraceUpdate;
    const init = await initiateOAuth(opts);
    if (init.success && init.serverConfig) {
      return {
        kind: "ready",
        serverConfig: init.serverConfig,
        tokens: undefined,
        oauthTrace: init.oauthTrace,
      };
    }
    if (init.success && !init.serverConfig) {
      return { kind: "redirect" };
    }
    return {
      kind: "error",
      error: init.error || "OAuth init failed",
      oauthTrace: init.oauthTrace,
    };
  }

  return {
    kind: "error",
    error: "OAuth authorization required and no URL present",
  };
}

// ===========================================================================
// SEP-2350 runtime scope step-up orchestration
// ===========================================================================
//
// The step-up CORE (scope union, challenge parse, §10.5 policy split) lives in
// `@mcpjam/sdk/browser`. This is the client-side ORCHESTRATION that composes
// those helpers into a bounded, redirect-surviving re-authorization decision
// for a runtime `403 insufficient_scope` on a live MCP request (post-connect):
//
//   1. read how many step-up re-authorizations this session already ran for
//      the server's authorization-server issuer (a PERSISTED counter, so it
//      survives the OAuth browser redirect that re-authorization triggers —
//      the SDK transport's per-request retry cap cannot bound a cross-request
//      loop across a full redirect round-trip, §10.5#5);
//   2. apply the §10.5 policy split (`resolveStepUpAction`): interactive
//      re-authorizes while under the cap then throws; m2m always throws;
//      debugger returns `manual` (the debugger advances explicitly — no
//      auto-browser);
//   3. on `reauthorize`, union the previously-requested and challenged scopes,
//      persist the widened set, bump the counter, and return the union for the
//      caller to feed into {@link ensureAuthorizedForReconnect} via
//      `stepUpScopes` — so the fresh flow requests the widened scopes.
//
// A caller wires it as: on a tool call whose error carries an
// `insufficientScope` challenge, call `resolveInsufficientScopeStepUp`; if the
// action is `reauthorize`, run `ensureAuthorizedForReconnect(server, {
// stepUpScopes })`; on a later SUCCESSFUL call, `resetInsufficientScopeStepUp`
// to clear the counter so a future legitimate step-up starts fresh.

const STEP_UP_ATTEMPTS_PREFIX = "mcp-stepup-attempts-";
const DEFAULT_STEP_UP_MAX_RETRIES = 1;

function stepUpAttemptsKey(serverName: string): string {
  return `${STEP_UP_ATTEMPTS_PREFIX}${serverName}`;
}

// The bounded step-up counter lives in `sessionStorage`, NOT `localStorage`: it
// must survive the OAuth browser redirect that a re-authorization triggers
// (same-origin, same tab → sessionStorage persists across the redirect
// round-trip), but it must NOT outlive the browser session. In `localStorage`,
// a prior session's exhausted counter would make a brand-new session throw
// immediately on its first legitimate step-up. `sessionStorage` scopes the
// bound to the session, which is exactly the loop we need to bound (§10.5#5).
function stepUpAttemptsStore(): Storage | undefined {
  try {
    return typeof sessionStorage !== "undefined" ? sessionStorage : undefined;
  } catch {
    return undefined;
  }
}

// Key attempts by issuer so an AS switch (or a step-up before issuer
// discovery) never reuses another AS's count. An unknown issuer buckets under
// "" — its own isolated bucket.
function issuerBucket(issuer: string | undefined): string {
  return issuer ?? "";
}

function readStepUpAttempts(
  serverName: string,
  issuer: string | undefined,
): number {
  try {
    const store = stepUpAttemptsStore();
    if (!store) return 0;
    const raw = store.getItem(stepUpAttemptsKey(serverName));
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const value = parsed?.[issuerBucket(issuer)];
    return typeof value === "number" && Number.isInteger(value) && value >= 0
      ? value
      : 0;
  } catch {
    return 0;
  }
}

function writeStepUpAttempts(
  serverName: string,
  issuer: string | undefined,
  attempts: number,
): void {
  try {
    const store = stepUpAttemptsStore();
    if (!store) return;
    const raw = store.getItem(stepUpAttemptsKey(serverName));
    let map: Record<string, number> = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          map = parsed as Record<string, number>;
        }
      } catch {
        // Corrupt record — start fresh rather than aborting the step-up.
      }
    }
    map[issuerBucket(issuer)] = attempts;
    store.setItem(stepUpAttemptsKey(serverName), JSON.stringify(map));
  } catch {
    // Best-effort: a full/unavailable store must not abort the OAuth flow. The
    // upstream transport still bounds retries within a single request; only the
    // cross-redirect count is lost, so the guard degrades, never disappears.
  }
}

export interface InsufficientScopeStepUpInput {
  serverName: string;
  /** The server's authorization-server issuer, if known. */
  issuer: string | undefined;
  /** Scopes named by the `403` `WWW-Authenticate` challenge's `scope` param. */
  challengedScopes: string[] | undefined;
  /**
   * The scopes the server's ORIGINAL OAuth flow requested (from the stored
   * profile/config). Included in the union so the FIRST runtime step-up — when
   * nothing has been persisted yet — does not drop the scopes the existing
   * grant already held and re-request only the challenged subset.
   */
  originalScopes?: string[];
  /** Where the step-up is handled — drives the §10.5 policy split. */
  authMode: StepUpAuthMode;
  /** Max cross-request re-authorizations before giving up (default 1). */
  maxRetries?: number;
}

export interface InsufficientScopeStepUpDecision {
  /** `reauthorize` (run a fresh flow with `scopes`), `throw`, or `manual`. */
  action: StepUpAction;
  /**
   * The scope union — previously-requested ∪ challenged. Pass into
   * {@link ensureAuthorizedForReconnect}'s `stepUpScopes` on `reauthorize`;
   * for `throw`/`manual` it is the set the caller would display/request.
   */
  scopes: string[];
  /** Re-authorizations already performed this session before this decision. */
  attempt: number;
}

/**
 * Decide what a runtime `403 insufficient_scope` challenge should do, and (on
 * `reauthorize`) persist the widened scope set + bump the bounded per-session
 * counter. Pure w.r.t. the network — the caller performs the actual
 * re-authorization via {@link ensureAuthorizedForReconnect}. Reads/writes the
 * persisted counter so the bound holds across the redirect round-trip.
 */
export function resolveInsufficientScopeStepUp(
  input: InsufficientScopeStepUpInput,
): InsufficientScopeStepUpDecision {
  const { serverName, issuer, challengedScopes, originalScopes, authMode } =
    input;
  const maxRetries = input.maxRetries ?? DEFAULT_STEP_UP_MAX_RETRIES;
  const attempt = readStepUpAttempts(serverName, issuer);
  const action = resolveStepUpAction({ authMode, attempt, maxRetries });
  const scopes = stepUpScopeUnion(
    serverName,
    issuer,
    challengedScopes,
    originalScopes,
  );

  if (action === "reauthorize") {
    // Persist the widened set as the newly-requested scopes for this issuer so
    // a subsequent step-up unions from the widened base, and record the
    // attempt so the next cross-request challenge is bounded.
    persistRequestedScopes(serverName, issuer, scopes);
    writeStepUpAttempts(serverName, issuer, attempt + 1);
  }

  return { action, scopes, attempt };
}

/**
 * Clear the per-session step-up counter for a server's issuer. Call after a
 * SUCCESSFUL request so a future legitimate scope step-up starts from zero
 * rather than inheriting a stale count that would prematurely throw.
 */
export function resetInsufficientScopeStepUp(
  serverName: string,
  issuer: string | undefined,
): void {
  try {
    const store = stepUpAttemptsStore();
    if (!store) return;
    const raw = store.getItem(stepUpAttemptsKey(serverName));
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, number>;
    if (!parsed || typeof parsed !== "object") return;
    delete parsed[issuerBucket(issuer)];
    if (Object.keys(parsed).length === 0) {
      store.removeItem(stepUpAttemptsKey(serverName));
    } else {
      store.setItem(stepUpAttemptsKey(serverName), JSON.stringify(parsed));
    }
  } catch {
    // Best-effort reset.
  }
}

// ===========================================================================
// Tool-call step-up wiring (local, non-hosted surface)
// ===========================================================================
//
// The composition a live tool-call surface uses when `executeToolApi` surfaces
// an `insufficientScope` challenge: resolve the server's issuer + originally-
// requested scopes, run the bounded {@link resolveInsufficientScopeStepUp}
// decision, and — on `reauthorize` — drive the fresh union-scope OAuth flow via
// {@link ensureAuthorizedForReconnect}. This is what makes the step-up CORE
// reachable end-to-end from a real MCP tool call on the local path.

function readServerUrlForStepUp(server: ServerWithName): string | undefined {
  const fromConfig = (server.config as any)?.url?.toString?.();
  if (fromConfig) return fromConfig;
  try {
    return (
      localStorage.getItem(`mcp-serverUrl-${server.name}`) ?? undefined
    );
  } catch {
    return undefined;
  }
}

/**
 * Validate an UNTRUSTED `resource_metadata` hint (from a `403 insufficient_scope`
 * `WWW-Authenticate` header) before threading it into the OAuth flow. RFC 9728
 * permits the protected-resource-metadata document to live on a DIFFERENT origin
 * than the resource server (e.g. a dedicated metadata host), so this does NOT
 * require same-origin — dropping a valid cross-origin pointer would force the
 * flow back to the wrong derived well-known URL, the exact regression this path
 * fixes. It only requires an absolute `https:` URL (RFC 9728 mandates https).
 * Returns the trimmed hint when it parses as absolute https; otherwise
 * `undefined`, so a malformed/relative/non-https hint falls back to derived
 * discovery. Fetch safety of a cross-origin hint is enforced downstream by the
 * SDK: the factory's outbound-host allowlist (`assertOutboundOAuthUrlAllowed`
 * blocks private/reserved hosts → SSRF) and cross-origin MCP-Authorization
 * header stripping (`mergeHeadersForResourceMetadataRequest`).
 */
function validResourceMetadataUrlHint(
  resourceMetadataUrl: string | undefined,
): string | undefined {
  const hint = resourceMetadataUrl?.trim();
  if (!hint) return undefined;
  try {
    if (new URL(hint).protocol === "https:") {
      return hint;
    }
  } catch {
    // Unparseable / relative hint — treat as no usable override.
  }
  return undefined;
}

function readOriginalOAuthScopes(
  server: ServerWithName,
): string[] | undefined {
  // Mirror buildReconnectOAuthOptions' scope precedence: the flow profile's
  // scopes, else the stored OAuth config's scopes. These are the scopes the
  // ORIGINAL grant requested — the base the step-up union must not drop.
  const profileScopes = parseOAuthScopes(server.oauthFlowProfile?.scopes);
  if (profileScopes) return profileScopes;
  return readStoredOAuthConfig(server.name).scopes;
}

/** The `WWW-Authenticate` challenge fields a failed tool call surfaces. */
export interface ToolCallStepUpChallenge {
  requiredScope?: string;
  resourceMetadataUrl?: string;
}

export interface ToolCallStepUpOutcome {
  /** `reauthorize` (a fresh flow ran), `throw`, or `manual`. */
  action: StepUpAction;
  /** The union scope set the decision produced (for display / the fresh flow). */
  scopes: string[];
  /** Re-authorizations already performed this session before this decision. */
  attempt: number;
  /**
   * The OAuth outcome when `action === "reauthorize"` (typically a `redirect`,
   * which navigates away). Undefined for `throw` / `manual`.
   */
  reauthorization?: OAuthResult;
}

/**
 * Handle a runtime `403 insufficient_scope` on a live tool call: decide (bounded
 * per session, §10.5 policy split) and, on `reauthorize`, run the union-scope
 * re-authorization. The caller supplies the server and the parsed challenge; the
 * issuer and originally-requested scopes are resolved from stored state here.
 */
export async function applyToolCallStepUp(
  server: ServerWithName,
  challenge: ToolCallStepUpChallenge,
  options?: {
    /** Defaults to `interactive` — the local tool runner drives a browser flow. */
    authMode?: StepUpAuthMode;
    maxRetries?: number;
    onTraceUpdate?: (trace: OAuthTrace) => void;
    beforeRedirect?: (oauthOptions: MCPOAuthOptions) => void;
  },
): Promise<ToolCallStepUpOutcome> {
  const serverUrl = readServerUrlForStepUp(server);
  const issuer = resolveStoredIssuer(server.name, serverUrl);
  const challengedScopes = parseOAuthScopes(challenge.requiredScope);
  // The challenge's `resource_metadata` hint is untrusted: thread it only when
  // it parses as an absolute https URL (RFC 9728). A valid cross-origin pointer
  // is honored — the SDK's outbound-host guard + cross-origin header stripping
  // enforce fetch safety. See {@link validResourceMetadataUrlHint}.
  const resourceMetadataUrl = validResourceMetadataUrlHint(
    challenge.resourceMetadataUrl,
  );

  // A METADATA-ONLY challenge (a `resource_metadata` pointer with NO
  // `requiredScope`) intentionally re-authorizes with the EXISTING scopes.
  // `challengedScopes` is empty, so the union below is just the user's
  // previously-requested/consented scopes, which flow to the fresh grant as its
  // requested scope value. This is deliberate, not a bug: a metadata-only
  // `insufficient_scope` names no scope to widen to — it is a "you discovered
  // PRM from the wrong place, rediscover it here" signal (the corrected
  // `resourceMetadataUrl` may point at a different issuer/resource). Requesting
  // the corrected PRM's full `scopes_supported` instead would over-grant scopes
  // the server never asked for and the user never consented to; re-requesting
  // the original scopes against the CORRECTED metadata is the least-privilege,
  // intent-preserving step-up (and is not a no-op — discovery, AS, and token
  // audience can all change). If the corrected metadata still resolves to the
  // same insufficient scopes, the bounded retry stops the loop by design.
  const decision = resolveInsufficientScopeStepUp({
    serverName: server.name,
    issuer,
    challengedScopes,
    originalScopes: readOriginalOAuthScopes(server),
    authMode: options?.authMode ?? "interactive",
    maxRetries: options?.maxRetries,
  });

  if (decision.action !== "reauthorize") {
    return {
      action: decision.action,
      scopes: decision.scopes,
      attempt: decision.attempt,
    };
  }

  const reauthorization = await ensureAuthorizedForReconnect(server, {
    allowInteractiveOAuthFlow: true,
    // A resolved `reauthorize` IS the confirmed escalation — without this an
    // auto server's tokenless guard would short-circuit to
    // ready-unauthenticated instead of redirecting for the widened scopes.
    interactiveOAuthConfirmed: true,
    stepUpScopes: decision.scopes,
    resourceMetadataUrl,
    onTraceUpdate: options?.onTraceUpdate,
    beforeRedirect: options?.beforeRedirect,
  });

  // The resolver already bumped the per-session counter (it must persist BEFORE
  // the redirect so the bound survives the round-trip). Roll it back to its
  // pre-decision value ONLY on a transient failure that never navigated away
  // and never completed a re-authorization — an OAuth-init `error` or a
  // `reauth_required` — so a wasted attempt doesn't block retrying the tool in
  // the same session.
  //
  // A `redirect` OR a `ready` KEEPS the consumed attempt. A `ready` here is NOT
  // a genuine widened-scope grant — the redirect round-trip is what mints new
  // scopes; a `ready` means `initiateOAuth` resolved without navigating (the
  // server was already authorized / no redirect was needed), so the challenged
  // scope was NOT obtained. Rolling that back would let a server stuck on
  // `insufficient_scope` loop forever: every retry reads the un-bumped count,
  // re-bumps, sees `ready`, rolls back, and never advances toward the cap.
  // Keeping the bump advances the bounded budget until the §10.5 policy throws.
  // A genuine step-up success clears the counter elsewhere — the caller's
  // reset-on-successful-tool-call path — not here.
  if (
    reauthorization.kind === "error" ||
    reauthorization.kind === "reauth_required"
  ) {
    writeStepUpAttempts(server.name, issuer, decision.attempt);
  }

  return {
    action: decision.action,
    scopes: decision.scopes,
    attempt: decision.attempt,
    reauthorization,
  };
}

/**
 * Clear the step-up counter after a SUCCESSFUL tool call (resolves the server's
 * issuer, then {@link resetInsufficientScopeStepUp}). Call this on a completed
 * result so a later legitimate step-up starts from zero.
 */
export function resetToolCallStepUp(server: ServerWithName): void {
  const issuer = resolveStoredIssuer(server.name, readServerUrlForStepUp(server));
  resetInsufficientScopeStepUp(server.name, issuer);
}
