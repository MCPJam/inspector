/**
 * Effective auth-method resolution for connect-time dispatch — the single
 * predicate all three surfaces (local resolver, hosted web/auth routes, swarm
 * runs) must share so `auto` behaves identically everywhere.
 *
 * `auto` resolves to XAA when the server is XAA-configured — a hard selection
 * before the flow starts, never a fallback after a failed attempt (a failed
 * XAA mint surfaces the error rather than retrying as OAuth, which would mask
 * config errors as confusing OAuth 401s). Otherwise `auto` resolves to
 * "discover": use a stored OAuth token when one exists, else connect
 * UNAUTHENTICATED and let a 401 from the target escalate to the interactive
 * OAuth flow. That is the MCP spec's canonical client sequence
 * (unauthenticated request → 401 + WWW-Authenticate → discovery → OAuth),
 * not a fallback-after-failure.
 *
 * NOTE: dispatch sites branch on equality (`=== "oauth"`), not exhaustive
 * switches — adding a member here does NOT produce compile errors at
 * unhandled sites. Every consumer must be audited by hand (currently
 * local-server-resolver.ts and routes/web/auth.ts).
 *
 * The canonical `authMethod` WINS over the derived/legacy `useOAuth`/`useXaa`
 * booleans (see feedback: canonical-wins-every-read-site); only rows with no
 * canonical method fall back to the boolean pair.
 */

import {
  readXaaEnterprisePolicy,
  XAA_ENTERPRISE_POLICY_IDPS,
  XAA_MCP_EXTENSION,
  type XaaEnterprisePolicy,
} from "@mcpjam/sdk";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";

export type EffectiveAuthMethod =
  | "oauth"
  | "xaa"
  | "bearer"
  | "none"
  | "discover";

type AuthConfigFields = {
  authMethod?: "auto" | "oauth" | "xaa" | "bearer" | "none";
  useOAuth?: boolean;
  useXaa?: boolean;
  authServerMode?: "mcpjam" | "own";
  clientId?: string;
};

/**
 * Whether an `auto` server selects XAA at connect time: an IdP mode is chosen
 * AND a pre-registered client id is stored (the server-side mint runs on
 * stored confidential credentials; `authServerMode` alone is sticky — plain
 * saves preserve it after a server moves off XAA — so it is not enough).
 * MUST stay in lockstep with the backend's `xaaConfigured` in
 * mcpjam-backend `convex/lib/serverAuthFields.ts`, which derives the compat
 * booleans from the same rule.
 */
export function xaaConfigured(sc: AuthConfigFields): boolean {
  return sc.authServerMode != null && !!sc.clientId;
}

/**
 * Merge the MCP Enterprise-Managed Authorization extension into a client
 * capabilities object (spec: a client whose access is enterprise-managed MUST
 * advertise the extension during initialization). Preserves every existing
 * capability/extension — merge, never overwrite. Applied by the connect
 * surfaces whenever the effective auth method is "xaa"; the debugger's
 * dedicated initialize builder (sdk/src/xaa/mcp-init.ts) advertises the same
 * key.
 */
export function withXaaExtensionCapability(
  capabilities: Record<string, unknown> | undefined
): Record<string, unknown> {
  const existingExtensions =
    capabilities &&
    typeof capabilities.extensions === "object" &&
    capabilities.extensions !== null
      ? (capabilities.extensions as Record<string, unknown>)
      : {};
  return {
    ...(capabilities ?? {}),
    extensions: {
      ...existingExtensions,
      [XAA_MCP_EXTENSION]: existingExtensions[XAA_MCP_EXTENSION] ?? {},
    },
  };
}

/**
 * @param xaaPolicy The active host's enterprise-managed authorization policy
 * (validated `on` value; callers surface `invalid` as a configuration error
 * BEFORE resolving — never pass an unvalidated value through). The policy
 * rewrites ONLY the `auto` branch: under an enterprise-managed host, every
 * `auto` server resolves to XAA regardless of whether it is XAA-configured —
 * an unconfigured server then fails with XAA_CONNECTION_NOT_CONFIGURED at
 * the connect surface instead of taking the discover ladder (no silent
 * downgrade). Explicit methods and legacy boolean rows are per-server
 * overrides and win over the policy. Connect-time input only: the backend's
 * `deriveAuthBooleans` (serverAuthFields.ts) is intentionally unaware of
 * host policy — a server attaches to many hosts, so the persisted compat
 * booleans cannot encode a per-connection decision.
 */
export function resolveEffectiveAuthMethod(
  sc: AuthConfigFields,
  xaaPolicy?: XaaEnterprisePolicy
): EffectiveAuthMethod {
  switch (sc.authMethod) {
    case "oauth":
    case "xaa":
    case "bearer":
    case "none":
      return sc.authMethod;
    case "auto":
      if (xaaPolicy) return "xaa";
      return xaaConfigured(sc) ? "xaa" : "discover";
    default:
      // Legacy rows: the boolean pair governs. Same precedence the dispatch
      // gates used before authMethod existed (`useXaa === true && useOAuth
      // !== true` → XAA never collides with the OAuth branch). Pre-`auto`
      // relics resolving "none" by absence stay outside the policy.
      if (sc.useXaa === true && sc.useOAuth !== true) return "xaa";
      if (sc.useOAuth === true) return "oauth";
      return "none";
  }
}

/**
 * Whether a server resolves to XAA *because of the host policy* while
 * lacking the stored client registration the mint needs. This is the
 * XAA_CONNECTION_NOT_CONFIGURED trigger: "not configured", deliberately NOT
 * "not enrolled" — `xaaConfigured` proves an IdP mode + a client id
 * registered at the resource authorization server, not IdP enrollment
 * (enrollment verdicts belong to the future issuer-policy evaluator).
 * Explicit `authMethod: "xaa"` servers missing credentials keep their
 * existing mint-failure path and are not this predicate's business.
 */
export function xaaPolicyRequiresConfiguration(
  sc: AuthConfigFields,
  xaaPolicy: XaaEnterprisePolicy | undefined
): boolean {
  return xaaPolicy != null && sc.authMethod === "auto" && !xaaConfigured(sc);
}

/**
 * Strict trust-boundary gate for a bare wire `xaaPolicy` value (request
 * bodies / ConnectionDefaults). UNLIKE advisory connect fields, enforcement
 * is never silently dropped: absent → undefined (off); a well-formed
 * `{ idp: <supported> }` → the policy; anything else → 409 — fail-open
 * would un-enforce a policy the host believes is on.
 */
export function parseXaaPolicyValue(
  raw: unknown
): XaaEnterprisePolicy | undefined {
  if (raw === undefined) return undefined;
  const idp =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).idp
      : undefined;
  if (
    typeof idp !== "string" ||
    !(XAA_ENTERPRISE_POLICY_IDPS as readonly string[]).includes(idp)
  ) {
    throw new WebRouteError(
      409,
      ErrorCode.VALIDATION_ERROR,
      `Unsupported enterprise-managed authorization policy on this host: expected { idp: ${XAA_ENTERPRISE_POLICY_IDPS.join(
        " | "
      )} }. Fix the host's MCP Protocol settings or turn the policy off.`,
      { reason: "xaa_policy_invalid" }
    );
  }
  return { idp: idp as XaaEnterprisePolicy["idp"] };
}

/**
 * Server-authoritative policy read from a BACKEND-PROJECTED host config's
 * `mcpProfile` (chatbox turns, host-bound turns, swarm snapshots, eval host
 * configs). Three-state: off → undefined, on → the policy, invalid →
 * explicit 409 configuration error (never treated as off).
 */
export function xaaPolicyFromMcpProfile(
  mcpProfile: unknown
): XaaEnterprisePolicy | undefined {
  const state = readXaaEnterprisePolicy(mcpProfile);
  if (state.kind === "off") return undefined;
  if (state.kind === "on") return state.policy;
  throw new WebRouteError(
    409,
    ErrorCode.VALIDATION_ERROR,
    `This host has an unsupported enterprise-managed authorization policy (${state.reason}). Fix the host's MCP Protocol settings or turn the policy off.`,
    { reason: "xaa_policy_invalid" }
  );
}
