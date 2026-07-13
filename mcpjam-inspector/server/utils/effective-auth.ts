/**
 * Effective auth-method resolution for connect-time dispatch — the single
 * predicate all three surfaces (local resolver, hosted web/auth routes, swarm
 * runs) must share so `auto` behaves identically everywhere.
 *
 * `auto` SELECTS a flow before it starts (XAA when the server is
 * XAA-configured, OAuth otherwise); it is never a fallback after a failed
 * attempt — a failed XAA mint surfaces the error rather than retrying as
 * OAuth (a silent fallback would mask config errors as confusing OAuth 401s).
 *
 * The canonical `authMethod` WINS over the derived/legacy `useOAuth`/`useXaa`
 * booleans (see feedback: canonical-wins-every-read-site); only rows with no
 * canonical method fall back to the boolean pair.
 */

import { XAA_MCP_EXTENSION } from "@mcpjam/sdk";

export type EffectiveAuthMethod = "oauth" | "xaa" | "bearer" | "none";

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

export function resolveEffectiveAuthMethod(
  sc: AuthConfigFields
): EffectiveAuthMethod {
  switch (sc.authMethod) {
    case "oauth":
    case "xaa":
    case "bearer":
    case "none":
      return sc.authMethod;
    case "auto":
      return xaaConfigured(sc) ? "xaa" : "oauth";
    default:
      // Legacy rows: the boolean pair governs. Same precedence the dispatch
      // gates used before authMethod existed (`useXaa === true && useOAuth
      // !== true` → XAA never collides with the OAuth branch).
      if (sc.useXaa === true && sc.useOAuth !== true) return "xaa";
      if (sc.useOAuth === true) return "oauth";
      return "none";
  }
}
