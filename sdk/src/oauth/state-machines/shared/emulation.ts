/**
 * Emulation appliers for the debug OAuth state machines (HP-43 step 4).
 *
 * Every helper is a pure function over `OAuthEmulationConfig | undefined`
 * with the invariant: `undefined` emulation (or an undefined knob) produces
 * EXACTLY today's behavior — the no-emulation goldens pin this. Machines call
 * these one-liners at each wire site instead of branching inline, so there is
 * one implementation of each knob, not four.
 */

import type { OAuthEmulationConfig } from "../../emulation/types.js";
import { resolveRequestedScopeValue } from "./challenges.js";

export function shouldSendResourceIndicator(
  emulation: OAuthEmulationConfig | undefined
): boolean {
  return emulation?.sendResourceIndicator !== false;
}

/**
 * `{}` or `{ resource: value }` — used for token PREVIEW body objects and
 * info-log/display data alike, so a display can never echo a `resource` the
 * wire does not carry.
 */
export function resourceBodyFields(
  value: string,
  emulation: OAuthEmulationConfig | undefined
): Record<string, string> {
  return shouldSendResourceIndicator(emulation) ? { resource: value } : {};
}

/**
 * Scope policy at every scope-emitting wire site (DCR metadata, authorize
 * URL). No policy → today's precedence (custom → challenged → supported).
 *
 *   omit          — never send `scope`.
 *   fixed         — the captured list, joined in captured order, byte-exact.
 *   challenge     — only the `WWW-Authenticate` challenge scopes; no
 *                   supported-scopes fallback.
 *   all-supported — only the AS metadata's `scopes_supported`.
 */
export function resolveEmulatedScopeValue(
  emulation: OAuthEmulationConfig | undefined,
  fallback: {
    customScopes?: string;
    challengedScopes?: string[];
    supportedScopes?: string[];
  }
): string | undefined {
  const policy = emulation?.scopeRequest;
  if (!policy) {
    return resolveRequestedScopeValue(fallback);
  }
  switch (policy.mode) {
    case "omit":
      return undefined;
    case "fixed":
      return policy.scopes.join(" ");
    case "challenge": {
      const challenged = fallback.challengedScopes?.filter(Boolean) ?? [];
      return challenged.length > 0
        ? Array.from(new Set(challenged)).join(" ")
        : undefined;
    }
    case "all-supported": {
      const supported = fallback.supportedScopes?.filter(Boolean) ?? [];
      return supported.length > 0
        ? Array.from(new Set(supported)).join(" ")
        : undefined;
    }
  }
}

/**
 * Overlay the emulated DCR identity on the caller's registration metadata:
 * byte-exact `client_name`, the forced `token_endpoint_auth_method`, and the
 * completion-safe `redirect_uris`. Applied BEFORE the machines'
 * client_name-required guard, so an emulated client_name satisfies it.
 *
 * `redirect_uris` lands on the REGISTRATION body only — the authorization and
 * token legs keep using the machine's `redirectUrl`. That asymmetry is what
 * lets a replayed registration coexist with a code MCPJam can actually
 * receive (see emulation/redirects.ts).
 */
export function applyEmulationToDcrMetadata<
  T extends Record<string, unknown>,
>(defaults: T, emulation: OAuthEmulationConfig | undefined): T {
  if (!emulation) return defaults;
  const out: Record<string, unknown> = { ...defaults };
  if (emulation.dcrClientName !== undefined) {
    out.client_name = emulation.dcrClientName;
  }
  if (emulation.tokenEndpointAuthMethod !== undefined) {
    out.token_endpoint_auth_method = emulation.tokenEndpointAuthMethod;
  }
  if (emulation.dcrRedirectUris !== undefined) {
    out.redirect_uris = [...emulation.dcrRedirectUris];
  }
  return out as T;
}

/**
 * Force the token-request client auth method when emulated, otherwise keep
 * the method the flow resolved (registration response / prereg resolution).
 */
export function resolveEmulatedTokenAuthMethod(
  emulation: OAuthEmulationConfig | undefined,
  resolved: string | undefined
): string | undefined {
  return emulation?.tokenEndpointAuthMethod ?? resolved;
}

/**
 * Merge the emulated `User-Agent` into the flow's custom headers — one merge
 * in the factory reaches every request of every machine. A caller-supplied
 * User-Agent in customHeaders loses to the emulated one: the point of the
 * knob is byte-exact client replay.
 */
export function applyEmulationUserAgent(
  customHeaders: Record<string, string> | undefined,
  emulation: OAuthEmulationConfig | undefined
): Record<string, string> | undefined {
  if (!emulation?.userAgent) return customHeaders;
  return { ...(customHeaders ?? {}), "User-Agent": emulation.userAgent };
}

/**
 * The MCP-leg protocol version: pinned by emulation, else the machine's own
 * literal. Covers the `MCP-Protocol-Version` header on MCP requests, the
 * `initialize` body version, and the 2026-07-28 stateless `_meta` version —
 * a pinned client pins them all.
 */
export function resolveEmulatedMcpVersion(
  emulation: OAuthEmulationConfig | undefined,
  machineDefault: string
): string {
  return emulation?.mcpProtocolVersion ?? machineDefault;
}
