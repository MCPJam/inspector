/**
 * Mid-session sign-in ("lazy authentication") challenges.
 *
 * A server may let a client connect and call its public tools anonymously, and
 * ask for sign-in only when a protected tool is called. Hosts publish two
 * different contracts for that refusal:
 *
 *   - an HTTP `401` with `WWW-Authenticate` on the request itself (the MCP
 *     authorization spec, and Claude);
 *   - a `200` tool result with `isError: true` and
 *     `_meta["mcp/www_authenticate"]` (ChatGPT, and only for a tool whose
 *     `securitySchemes` include `oauth2`).
 *
 * RECOGNITION IS HOST-AGNOSTIC AND HAPPENS ONCE, HERE. Every refusal becomes an
 * `AuthChallengeSignal` with `facets` that record what the server actually
 * sent, so a host-specific trigger rule can be applied later without
 * re-parsing. Whether a given host ACTS on the signal is a separate, per-host
 * decision: see `decideAuthChallengeAction`.
 *
 * Every string here comes from the server under test. Values are length-capped
 * and must be rendered as text only.
 *
 * Browser-safe: no Node imports. Served on both the Node and browser entries.
 */

import { parseBearerChallenges } from "../oauth/state-machines/shared/challenges.js";

/** Where the challenge was found. */
export type AuthChallengeSource =
  | "http_401"
  | "http_403_insufficient_scope"
  | "tool_result_meta";

/**
 * The server's effective authentication mode, stamped by the server that ran
 * the call. A browser cannot compute it: Auto can resolve to XAA under an
 * organization policy the browser never sees.
 */
export type AuthChallengeEffectiveAuth =
  | "discover"
  | "oauth"
  | "xaa"
  | "bearer"
  | "none";

/** What the server sent, recorded so trigger rules need no re-parse. */
export interface AuthChallengeFacets {
  /**
   * For an HTTP challenge: whether `WWW-Authenticate` was present and which
   * scheme it named. For a `_meta` challenge: whether the value parsed as a
   * Bearer challenge.
   */
  challengeHeader: "none" | "bearer" | "other-scheme";
  hasResourceMetadata: boolean;
  hasScope: boolean;
  /** Both `error` and `error_description` are present (OpenAI requires both). */
  hasErrorParams: boolean;
}

export interface AuthChallengeSignal {
  source: AuthChallengeSource;
  /** RFC 6750 `error`, e.g. `invalid_token` or `insufficient_scope`. */
  error?: string;
  errorDescription?: string;
  /** The challenge's `scope` parameter, space-separated as sent. */
  requiredScope?: string;
  /** RFC 9728 `resource_metadata` pointer. */
  resourceMetadataUrl?: string;
  /** The challenge as sent, capped. */
  raw?: string;
  /** Stamped by the server that ran the call. Never set by a browser parse. */
  effectiveAuth?: AuthChallengeEffectiveAuth;
  facets: AuthChallengeFacets;
}

export const AUTH_CHALLENGE_LIMITS = Object.freeze({
  /** Any single parsed field. */
  fieldChars: 512,
  /** The raw challenge. */
  rawChars: 2048,
});

/** The `_meta` key ChatGPT reads a runtime challenge from. */
export const TOOL_RESULT_AUTH_CHALLENGE_META_KEY = "mcp/www_authenticate";

function clip(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function field(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? clip(trimmed, AUTH_CHALLENGE_LIMITS.fieldChars) : undefined;
}

const EMPTY_FACETS: AuthChallengeFacets = Object.freeze({
  challengeHeader: "none",
  hasResourceMetadata: false,
  hasScope: false,
  hasErrorParams: false,
}) as AuthChallengeFacets;

/**
 * Pick the Bearer challenge that applies. A realm-only challenge must not hide
 * a later actionable one, and a 403 is about `insufficient_scope` specifically.
 */
function selectBearerChallenge(
  challenges: Array<Record<string, string>>,
  preferInsufficientScope: boolean
): Record<string, string> | undefined {
  return (
    (preferInsufficientScope
      ? challenges.find((entry) => entry.error === "insufficient_scope")
      : undefined) ??
    challenges.find((entry) => entry.error) ??
    challenges.find((entry) => entry.resource_metadata || entry.scope) ??
    challenges[0]
  );
}

function signalFromHeader(
  header: string | null | undefined,
  source: AuthChallengeSource
): AuthChallengeSignal {
  const raw = typeof header === "string" ? header.trim() : "";
  if (!raw) {
    return { source, facets: { ...EMPTY_FACETS } };
  }
  let challenges: Array<Record<string, string>> = [];
  try {
    challenges = parseBearerChallenges(raw);
  } catch {
    challenges = [];
  }
  const clippedRaw = clip(raw, AUTH_CHALLENGE_LIMITS.rawChars);
  if (challenges.length === 0) {
    return {
      source,
      raw: clippedRaw,
      facets: { ...EMPTY_FACETS, challengeHeader: "other-scheme" },
    };
  }
  const selected =
    selectBearerChallenge(
      challenges,
      source === "http_403_insufficient_scope" || source === "tool_result_meta"
    ) ?? {};
  const error = field(selected.error);
  const errorDescription = field(selected.error_description);
  const requiredScope = field(selected.scope);
  const resourceMetadataUrl = field(selected.resource_metadata);
  return {
    source,
    ...(error ? { error } : {}),
    ...(errorDescription ? { errorDescription } : {}),
    ...(requiredScope ? { requiredScope } : {}),
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    raw: clippedRaw,
    facets: {
      challengeHeader: "bearer",
      hasResourceMetadata: resourceMetadataUrl !== undefined,
      hasScope: requiredScope !== undefined,
      hasErrorParams: error !== undefined && errorDescription !== undefined,
    },
  };
}

/**
 * Parse an HTTP `WWW-Authenticate` header into a signal.
 *
 * A 401 with NO header, or a bare `Bearer` with no parameters, is still a
 * signal: the spec has clients fall back to the well-known metadata paths. The
 * facets say what was missing, so a host that needs more (Claude needs a
 * `WWW-Authenticate` header) can decline to act on it.
 */
export function parseChallengeHeader(
  header: string | null | undefined,
  source: "http_401" | "http_403_insufficient_scope" = "http_401"
): AuthChallengeSignal {
  return signalFromHeader(header, source);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a ChatGPT-style runtime challenge off a completed tool result.
 *
 * Requires `isError: true` and `_meta["mcp/www_authenticate"]` as a string or
 * an array of strings (OpenAI's documented example is an array). Anything else
 * is not a challenge.
 */
export function parseToolResultAuthChallenge(
  result: unknown
): AuthChallengeSignal | undefined {
  if (!isRecord(result) || result.isError !== true) return undefined;
  const meta = result._meta;
  if (!isRecord(meta)) return undefined;
  const value = meta[TOOL_RESULT_AUTH_CHALLENGE_META_KEY];
  const entries = (Array.isArray(value) ? value : [value]).filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim() !== ""
  );
  if (entries.length === 0) return undefined;
  // Each entry is one challenge (or a list); joining them is exactly how they
  // would have arrived as one header.
  return signalFromHeader(entries.join(", "), "tool_result_meta");
}

/** Narrow an untrusted wire payload back to a signal, or `undefined`. */
export function parseAuthChallengeSignal(
  value: unknown
): AuthChallengeSignal | undefined {
  if (!isRecord(value)) return undefined;
  const source = value.source;
  if (
    source !== "http_401" &&
    source !== "http_403_insufficient_scope" &&
    source !== "tool_result_meta"
  ) {
    return undefined;
  }
  const facets = isRecord(value.facets) ? value.facets : {};
  const challengeHeader =
    facets.challengeHeader === "bearer" ||
    facets.challengeHeader === "other-scheme"
      ? facets.challengeHeader
      : "none";
  const effectiveAuth = value.effectiveAuth;
  const error = field(value.error);
  const errorDescription = field(value.errorDescription);
  const requiredScope = field(value.requiredScope);
  const resourceMetadataUrl = field(value.resourceMetadataUrl);
  const raw =
    typeof value.raw === "string" && value.raw
      ? clip(value.raw, AUTH_CHALLENGE_LIMITS.rawChars)
      : undefined;
  return {
    source,
    ...(error ? { error } : {}),
    ...(errorDescription ? { errorDescription } : {}),
    ...(requiredScope ? { requiredScope } : {}),
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    ...(raw ? { raw } : {}),
    ...(effectiveAuth === "discover" ||
    effectiveAuth === "oauth" ||
    effectiveAuth === "xaa" ||
    effectiveAuth === "bearer" ||
    effectiveAuth === "none"
      ? { effectiveAuth }
      : {}),
    facets: {
      challengeHeader,
      hasResourceMetadata: facets.hasResourceMetadata === true,
      hasScope: facets.hasScope === true,
      hasErrorParams: facets.hasErrorParams === true,
    },
  };
}

// ---------------------------------------------------------------------------
// securitySchemes (OpenAI per-tool auth declaration)
// ---------------------------------------------------------------------------

export interface ToolSecurityScheme {
  type: string;
  scopes?: string[];
}

export type ToolSecuritySchemeSource =
  | "tool"
  | "tool-meta"
  | "server-default"
  | "unresolved"
  | "none";

export interface ToolSecuritySchemeResolution {
  schemes: ToolSecurityScheme[];
  source: ToolSecuritySchemeSource;
}

function normalizeSchemes(value: unknown): ToolSecurityScheme[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const schemes: ToolSecurityScheme[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || typeof entry.type !== "string") continue;
    const scopes = Array.isArray(entry.scopes)
      ? entry.scopes.filter(
          (scope): scope is string => typeof scope === "string"
        )
      : undefined;
    schemes.push({ type: entry.type, ...(scopes ? { scopes } : {}) });
  }
  return schemes;
}

/**
 * Resolve a tool's `securitySchemes` by OpenAI's inheritance rule: "If you omit
 * the array entirely, the tool inherits whatever default the server
 * advertises."
 *
 * Order: the tool's top-level field, then `_meta.securitySchemes`, then the
 * server default. Where ChatGPT reads that server default from is not known,
 * so a tool that declares nothing resolves as `unresolved`, which must never
 * be read as "no OAuth". `none` is returned only when the caller states there
 * is no server default (`serverDefault: null`).
 */
export function resolveToolSecuritySchemes(input: {
  declaration?: { securitySchemes?: unknown; _meta?: unknown } | null;
  serverDefault?: unknown;
}): ToolSecuritySchemeResolution {
  const declaration = input.declaration ?? undefined;
  const fromTool = normalizeSchemes(declaration?.securitySchemes);
  if (fromTool) return { schemes: fromTool, source: "tool" };
  const meta = isRecord(declaration?._meta) ? declaration._meta : undefined;
  const fromMeta = normalizeSchemes(meta?.securitySchemes);
  if (fromMeta) return { schemes: fromMeta, source: "tool-meta" };
  const fromServer = normalizeSchemes(input.serverDefault);
  if (fromServer) return { schemes: fromServer, source: "server-default" };
  if (input.serverDefault === null) return { schemes: [], source: "none" };
  return { schemes: [], source: "unresolved" };
}

export function hasOAuth2Scheme(
  resolution: ToolSecuritySchemeResolution | undefined
): boolean {
  return (
    resolution?.schemes.some((scheme) => scheme.type === "oauth2") === true
  );
}

// ---------------------------------------------------------------------------
// Per-host policy
// ---------------------------------------------------------------------------

/**
 * What a host does with a challenge it recognizes:
 *   - `prompt`: a Connect card, sign-in, then the same call again;
 *   - `notify`: the call fails with a sign-in message and is not retried;
 *   - `passthrough`: an ordinary error.
 */
export type AuthChallengeAction = "prompt" | "notify" | "passthrough";

/** What a 401 needs before the host treats it as a challenge. */
export type UnauthorizedChallengeTrigger =
  | "any"
  | "bearer-header"
  | "resource-metadata";

/** What a `_meta` challenge needs before the host treats it as one. */
export type ToolResultAuthChallengeTrigger =
  | "any"
  | "oauth2-scheme"
  | "oauth2-scheme+error-params";

export const AUTH_CHALLENGE_ACTIONS = [
  "prompt",
  "notify",
  "passthrough",
] as const satisfies readonly AuthChallengeAction[];
export const UNAUTHORIZED_CHALLENGE_TRIGGERS = [
  "any",
  "bearer-header",
  "resource-metadata",
] as const satisfies readonly UnauthorizedChallengeTrigger[];
export const TOOL_RESULT_AUTH_CHALLENGE_TRIGGERS = [
  "any",
  "oauth2-scheme",
  "oauth2-scheme+error-params",
] as const satisfies readonly ToolResultAuthChallengeTrigger[];

/**
 * A host's reaction to sign-in challenges. Every field is optional, and an
 * absent field means the default below.
 */
export interface AuthChallengePolicy {
  /** Action on a recognized 401. */
  unauthorizedChallenge?: AuthChallengeAction;
  unauthorizedChallengeTrigger?: UnauthorizedChallengeTrigger;
  /** Action on a 200 `isError` result carrying `_meta["mcp/www_authenticate"]`. */
  toolResultAuthChallenge?: AuthChallengeAction;
  toolResultAuthChallengeTrigger?: ToolResultAuthChallengeTrigger;
}

/**
 * The absent values. The 401 defaults follow the spec reading (and the
 * reference SDK client): act on any 401. The `_meta` defaults do NOT act: the
 * `_meta` challenge is not part of the MCP spec. A host that honors it (ChatGPT)
 * sets `toolResultAuthChallenge: "prompt"`, and then OpenAI's "both halves"
 * rule applies by default.
 */
export const AUTH_CHALLENGE_POLICY_DEFAULTS: Readonly<
  Required<AuthChallengePolicy>
> = Object.freeze({
  unauthorizedChallenge: "prompt",
  unauthorizedChallengeTrigger: "any",
  toolResultAuthChallenge: "passthrough",
  toolResultAuthChallengeTrigger: "oauth2-scheme+error-params",
});

/** Why the decision came out the way it did. Drives the developer note. */
export type AuthChallengeDecisionReason =
  /** The host acts on this challenge as configured. */
  | "honored"
  /** The host does not act on this kind of challenge at all. */
  | "not-honored"
  /** A 401 without the `WWW-Authenticate: Bearer` the host requires. */
  | "missing-bearer-header"
  /** A Bearer 401 without the `resource_metadata` the host requires. */
  | "missing-resource-metadata"
  /** A `_meta` challenge on a tool whose schemes do not include `oauth2`. */
  | "missing-oauth2-scheme"
  /** A `_meta` challenge on a tool with no declared schemes. */
  | "schemes-unresolved"
  /** A `_meta` challenge without both `error` and `error_description`. */
  | "missing-error-params";

export interface AuthChallengeDecision {
  action: AuthChallengeAction;
  reason: AuthChallengeDecisionReason;
}

/**
 * Decide how the emulated host reacts to a recognized challenge.
 *
 * A 403 `insufficient_scope` is always a step-up: every host in scope honors
 * it, and MCPJam's existing step-up flow owns it.
 */
export function decideAuthChallengeAction(
  signal: AuthChallengeSignal,
  policy?: AuthChallengePolicy | null,
  schemes?: ToolSecuritySchemeResolution
): AuthChallengeDecision {
  const resolved = {
    ...AUTH_CHALLENGE_POLICY_DEFAULTS,
    ...stripUndefined(policy ?? {}),
  };

  if (signal.source === "http_403_insufficient_scope") {
    return { action: "prompt", reason: "honored" };
  }

  if (signal.source === "http_401") {
    const configured = resolved.unauthorizedChallenge;
    if (configured === "passthrough") {
      return { action: "passthrough", reason: "not-honored" };
    }
    const trigger = resolved.unauthorizedChallengeTrigger;
    if (
      trigger !== "any" &&
      signal.facets.challengeHeader !== "bearer"
    ) {
      return { action: "passthrough", reason: "missing-bearer-header" };
    }
    if (
      trigger === "resource-metadata" &&
      !signal.facets.hasResourceMetadata
    ) {
      return { action: "passthrough", reason: "missing-resource-metadata" };
    }
    return { action: configured, reason: "honored" };
  }

  const configured = resolved.toolResultAuthChallenge;
  if (configured === "passthrough") {
    return { action: "passthrough", reason: "not-honored" };
  }
  const trigger = resolved.toolResultAuthChallengeTrigger;
  if (trigger !== "any") {
    if (schemes?.source === "unresolved" || schemes === undefined) {
      // The tool may inherit an `oauth2` default the host can see and we
      // cannot. Do not claim the host ignores it; do not run sign-in either.
      return { action: "notify", reason: "schemes-unresolved" };
    }
    if (!hasOAuth2Scheme(schemes)) {
      return { action: "passthrough", reason: "missing-oauth2-scheme" };
    }
    if (
      trigger === "oauth2-scheme+error-params" &&
      !signal.facets.hasErrorParams
    ) {
      return { action: "passthrough", reason: "missing-error-params" };
    }
  }
  return { action: configured, reason: "honored" };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) (out as Record<string, unknown>)[key] = entry;
  }
  return out;
}

/** Read the four policy fields off an untrusted `mcpProfile`-shaped object. */
export function authChallengePolicyFrom(
  profile: unknown
): AuthChallengePolicy | undefined {
  if (!isRecord(profile)) return undefined;
  const policy: AuthChallengePolicy = {};
  const action = (value: unknown) =>
    (AUTH_CHALLENGE_ACTIONS as readonly unknown[]).includes(value)
      ? (value as AuthChallengeAction)
      : undefined;
  const unauthorized = action(profile.unauthorizedChallenge);
  if (unauthorized) policy.unauthorizedChallenge = unauthorized;
  if (
    (UNAUTHORIZED_CHALLENGE_TRIGGERS as readonly unknown[]).includes(
      profile.unauthorizedChallengeTrigger
    )
  ) {
    policy.unauthorizedChallengeTrigger =
      profile.unauthorizedChallengeTrigger as UnauthorizedChallengeTrigger;
  }
  const toolResult = action(profile.toolResultAuthChallenge);
  if (toolResult) policy.toolResultAuthChallenge = toolResult;
  if (
    (TOOL_RESULT_AUTH_CHALLENGE_TRIGGERS as readonly unknown[]).includes(
      profile.toolResultAuthChallengeTrigger
    )
  ) {
    policy.toolResultAuthChallengeTrigger =
      profile.toolResultAuthChallengeTrigger as ToolResultAuthChallengeTrigger;
  }
  return Object.keys(policy).length > 0 ? policy : undefined;
}

// ---------------------------------------------------------------------------
// Copy shared by every surface
// ---------------------------------------------------------------------------

/**
 * The text the model sees for a `notify` decision. Generic on purpose: the
 * exact wording each host uses is not modeled.
 */
export function authChallengeNotifyText(serverName: string): string {
  return `MCP server "${serverName}" needs you to sign in before this tool can run. Ask the user to sign in, then try again.`;
}

/**
 * The developer-only explanation of a decision (never model-visible). Names
 * what the server should send instead when the host does not act.
 */
export function describeAuthChallengeDecision(
  signal: AuthChallengeSignal,
  decision: AuthChallengeDecision,
  hostLabel = "This host"
): string {
  switch (decision.reason) {
    case "honored":
      return decision.action === "prompt"
        ? `${hostLabel} shows a sign-in prompt for this challenge and retries the call after sign-in.`
        : decision.action === "notify"
          ? `${hostLabel} tells the user to sign in, but does not retry the call.`
          : `${hostLabel} treats this challenge as an ordinary error.`;
    case "not-honored":
      return signal.source === "tool_result_meta"
        ? `${hostLabel} ignores _meta["mcp/www_authenticate"] on a tool result. To ask for sign-in, return HTTP 401 with a WWW-Authenticate: Bearer header instead.`
        : `${hostLabel} does not start sign-in from an HTTP 401 on a tool call.`;
    case "missing-bearer-header":
      return `${hostLabel} starts sign-in only when the 401 carries a WWW-Authenticate: Bearer header. Add one, with resource_metadata pointing at your Protected Resource Metadata.`;
    case "missing-resource-metadata":
      return `${hostLabel} needs resource_metadata="…" in the WWW-Authenticate challenge before it starts sign-in.`;
    case "missing-oauth2-scheme":
      return `${hostLabel} shows its sign-in UI for a _meta challenge only when the tool declares securitySchemes with an oauth2 entry.`;
    case "schemes-unresolved":
      return `This tool declares no securitySchemes, so it inherits the server default, which MCPJam cannot see. ${hostLabel} would show sign-in only if that default includes oauth2. Declare securitySchemes on the tool to make this explicit.`;
    case "missing-error-params":
      return `${hostLabel} needs both error and error_description in _meta["mcp/www_authenticate"] before it shows sign-in.`;
  }
}
