/**
 * OAuth client emulation — knob and coverage types (HP-43 step 4).
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
}

/**
 * Profile fields step 4 can enforce. `authModel` (attempt ordering) and
 * `dcrIdentity.redirectUris` (completion-safe redirects) belong to the
 * attempt-ladder step and are not part of this coverage map yet.
 */
export const OAUTH_EMULATION_FIELDS = [
  "sendsResourceIndicator",
  "oauthSpecVersion",
  "protocolVersionPinning",
  "scopeRequest",
  "dcrIdentity",
  "tokenEndpointAuthMethod",
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

export interface OAuthEmulationDivergence {
  kind: "version-narrowed" | "not-enforced";
  /** Human-readable, includes requested vs used values where applicable. */
  detail: string;
  requested?: string;
  used?: string;
}
