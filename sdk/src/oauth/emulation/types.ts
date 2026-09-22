/**
 * OAuth client emulation — knob, coverage, and attempt types (HP-43).
 *
 * `OAuthEmulationConfig` is the ONLY thing the four debug OAuth state
 * machines see: generic wire knobs, derived from an evidence-backed
 * `HostConfigOAuthProfileV1|V2` by `deriveOAuthEmulation`. Client names and
 * profile records live in the private backend; this module is deliberately
 * client-name-free and pure (browser-safe, type-only imports).
 *
 * Every knob is optional and absent-by-default: an `undefined` knob (or an
 * absent `emulation` object) means the machine behaves exactly as today —
 * the no-emulation goldens in tests/oauth/no-emulation-goldens.test.ts pin
 * that contract.
 */

import type {
  OAuthScopeRequest,
  OAuthTokenEndpointAuthMethod,
} from "../../host-config/types.js";

/**
 * Wire-level knobs consumed by the state machines via
 * `BaseOAuthStateMachineConfig.emulation`.
 */
export interface OAuthEmulationConfig {
  /**
   * RFC 8707 resource indicator on the authorization URL and token request.
   * `false` → omitted at every wire site AND every display/info-log echo
   * (a display claiming a `resource` the wire does not carry would lie).
   * `true`/`undefined` → today's per-version behavior.
   */
  sendResourceIndicator?: boolean;
  /**
   * Pin the MCP leg's protocol version: the `MCP-Protocol-Version` header on
   * MCP requests (probe + authenticated verification), the `initialize` body
   * `protocolVersion`, and the 2026-07-28 stateless `_meta` version. Free-form
   * revision string — a client can pin a revision this inspector does not
   * speak. The OAuth discovery ladder is NOT affected: that is selected by
   * the machine version (`oauthSpecVersion` → `deriveOAuthEmulation`).
   */
  mcpProtocolVersion?: string;
  /**
   * Scope policy applied at every scope-emitting wire site (DCR registration
   * metadata and the authorization URL). Absent → today's precedence
   * (custom → challenged → supported).
   */
  scopeRequest?: OAuthScopeRequest;
  /**
   * Byte-exact DCR `client_name` replay. Self-asserted metadata (RFC 7591) —
   * replayed exactly because servers in the wild gate on it; never used for
   * authorization policy on our side.
   */
  dcrClientName?: string;
  /** Client `User-Agent` replay, merged into every request's headers. */
  userAgent?: string;
  /**
   * Force the token-endpoint auth method, reflected in BOTH the DCR
   * registration metadata and the token request's client authentication.
   */
  tokenEndpointAuthMethod?: OAuthTokenEndpointAuthMethod;
  /**
   * `redirect_uris` for the DCR registration body ONLY — the authorization and
   * token legs always use the machine's own `redirectUrl`.
   *
   * This asymmetry is the completion-safe design, not an oversight: the
   * registration body replays what the real client registers, while the code
   * still comes back to a callback MCPJam controls so the flow can finish with
   * a real token. Callers should not set this directly from a captured
   * profile — `planCompletionSafeRedirects` builds the value that keeps the
   * flow completable (see `emulation/redirects.ts`).
   */
  dcrRedirectUris?: string[];
}

/** A registration strategy an emulated client may prefer, in profile order. */
export type EmulatedRegistrationPreference = "preregistered" | "dcr" | "cimd";

/**
 * One rung of the emulated client's authentication ladder, derived from the
 * profile's ordered `authModel`.
 *
 * Consecutive `oauth2-*` entries collapse into a single `oauth` attempt whose
 * `registrationPreference` preserves their relative order: they are one OAuth
 * dance with a strategy preference, not several independent attempts.
 * `api-key` and `none` are not registration strategies and never enter the
 * authorization plan — the runner executes them as direct MCP requests.
 */
export type EmulatedAuthAttempt =
  | { kind: "oauth"; registrationPreference: EmulatedRegistrationPreference[] }
  | { kind: "api-key" }
  | { kind: "none" };

/** Profile fields the emulator can enforce. */
export const OAUTH_EMULATION_FIELDS = [
  "sendsResourceIndicator",
  "oauthSpecVersion",
  "protocolVersionPinning",
  "scopeRequest",
  "dcrIdentity",
  "tokenEndpointAuthMethod",
  "authModel",
] as const;

export type OAuthEmulationField = (typeof OAUTH_EMULATION_FIELDS)[number];

/**
 * `modeled` — evidence-backed value compiled into a knob.
 * `not_modeled` — missing or unverifiable evidence: the run continues with
 * normal MCPJam behavior for that dimension, coverage becomes partial, and
 * parity can never be claimed for it. Never a silent default.
 */
export type OAuthEmulationFieldStatus = "modeled" | "not_modeled";

export type OAuthEmulationCoverage = Record<
  OAuthEmulationField,
  OAuthEmulationFieldStatus
>;

/**
 * A declared, deliberate difference between what the real client does and what
 * the emulated run did. Every one is reported: a run that diverged can never
 * be presented as an unqualified byte-for-byte match.
 */
export interface OAuthEmulationDivergence {
  kind:
    | "version-narrowed"
    /** MCPJam's callback appended to the captured registration redirect list. */
    | "redirect-uri-appended"
    /** DCR re-sent with our callback only, after a structured
     * `invalid_redirect_uri` rejection (RFC 7591). */
    | "dcr-retried"
    /** CIMD / pre-registered identity is MCPJam's, not the real client's. */
    | "identity-substituted"
    /** Evidence exists but this step does not enforce it. */
    | "not-enforced";
  /** Human-readable, includes requested vs used values where applicable. */
  detail: string;
  requested?: string;
  used?: string;
}
