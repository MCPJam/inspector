// Host-level Enterprise-Managed Authorization POLICY (MCPJam extension).
//
// Distinct from the MCP EMA *capability* (`io.modelcontextprotocol/
// enterprise-managed-authorization`, see mcp-init.ts): the capability
// declares that the client SUPPORTS enterprise-managed auth; this policy
// says the simulated host deployment IS enterprise-managed — every HTTP
// server connection resolves to XAA by default unless the server's explicit
// authMethod overrides. Stored under `hostConfig.mcpProfile.extensions`,
// which the published canonicalizer deep-sorts as freeform JSON, so the
// policy persists and content-hashes with no SDK/backend release gate.
//
// Browser- and node-safe: pure data helpers, no I/O.
//
// NOTE: "host policy" naming is taken by sdk/src/host-config/host-policy.ts
// (tool-visibility execution policy) — everything here stays XAA-prefixed.

/** mcpProfile.extensions key holding the policy object. */
export const XAA_ENTERPRISE_POLICY_EXTENSION =
  "com.mcpjam/enterprise-managed-auth";

/** IdPs the policy can mint through. v1: only the MCPJam test IdP. `own`
 * (bring-your-own, e.g. Okta) joins later, mirroring the reserved
 * `authServerMode: "own"` slot on server configs. */
export const XAA_ENTERPRISE_POLICY_IDPS = ["mcpjam"] as const;
export type XaaEnterprisePolicyIdp =
  (typeof XAA_ENTERPRISE_POLICY_IDPS)[number];

/** The stored/wire policy object. */
export interface XaaEnterprisePolicy {
  idp: XaaEnterprisePolicyIdp;
}

/**
 * Three-state read. `invalid` is deliberately NOT `off`: a malformed object
 * or an unsupported `idp` (e.g. a future `"okta"` read by an older build)
 * means an admin believes enforcement is on — treating it as off would
 * silently un-enforce the policy. Connect surfaces turn `invalid` into an
 * explicit configuration error.
 */
export type XaaEnterprisePolicyState =
  | { kind: "off" }
  | { kind: "on"; policy: XaaEnterprisePolicy }
  | { kind: "invalid"; reason: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Read the policy state from a host config's `mcpProfile` value. */
export function readXaaEnterprisePolicy(
  mcpProfile: unknown
): XaaEnterprisePolicyState {
  if (mcpProfile === undefined || mcpProfile === null) return { kind: "off" };
  if (!isPlainObject(mcpProfile)) {
    return { kind: "invalid", reason: "mcpProfile is not an object" };
  }
  const extensions = mcpProfile.extensions;
  if (extensions === undefined) return { kind: "off" };
  if (!isPlainObject(extensions)) {
    return { kind: "invalid", reason: "mcpProfile.extensions is not an object" };
  }
  if (
    !Object.prototype.hasOwnProperty.call(
      extensions,
      XAA_ENTERPRISE_POLICY_EXTENSION
    )
  ) {
    return { kind: "off" };
  }
  const raw = extensions[XAA_ENTERPRISE_POLICY_EXTENSION];
  if (!isPlainObject(raw)) {
    return {
      kind: "invalid",
      reason: `${XAA_ENTERPRISE_POLICY_EXTENSION} must be an object`,
    };
  }
  const idp = raw.idp;
  if (
    typeof idp !== "string" ||
    !(XAA_ENTERPRISE_POLICY_IDPS as readonly string[]).includes(idp)
  ) {
    return {
      kind: "invalid",
      reason: `unsupported enterprise-auth idp ${JSON.stringify(raw.idp)}; this build supports: ${XAA_ENTERPRISE_POLICY_IDPS.join(", ")}`,
    };
  }
  return { kind: "on", policy: { idp: idp as XaaEnterprisePolicyIdp } };
}

/**
 * Turn the policy on. Preserves every sibling profile field and extension;
 * an existing VALID policy value is kept as-is, an invalid one is repaired
 * to the default (the toggle is the recovery path for a broken value).
 * Accepts an absent profile and materializes the minimal envelope.
 */
export function withXaaEnterprisePolicy(
  mcpProfile: Record<string, unknown> | undefined
): Record<string, unknown> {
  const profile: Record<string, unknown> = isPlainObject(mcpProfile)
    ? { ...mcpProfile }
    : { profileVersion: 1 };
  const extensions: Record<string, unknown> = isPlainObject(profile.extensions)
    ? { ...profile.extensions }
    : {};
  const existing = readXaaEnterprisePolicy({ extensions });
  extensions[XAA_ENTERPRISE_POLICY_EXTENSION] =
    existing.kind === "on"
      ? (extensions[XAA_ENTERPRISE_POLICY_EXTENSION] as Record<string, unknown>)
      : { idp: XAA_ENTERPRISE_POLICY_IDPS[0] };
  profile.extensions = extensions;
  return profile;
}

/**
 * Turn the policy off. Touches ONLY the policy key: sibling extensions
 * survive, a now-empty `extensions` container is dropped, and a profile
 * left with nothing meaningful (only `profileVersion`) collapses to
 * `undefined` so pre-feature configs keep hashing byte-identically —
 * absence is semantic in the content-addressed hostConfig store.
 */
export function withoutXaaEnterprisePolicy(
  mcpProfile: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!isPlainObject(mcpProfile)) return undefined;
  const profile: Record<string, unknown> = { ...mcpProfile };
  if (isPlainObject(profile.extensions)) {
    const extensions = { ...profile.extensions };
    delete extensions[XAA_ENTERPRISE_POLICY_EXTENSION];
    if (Object.keys(extensions).length > 0) {
      profile.extensions = extensions;
    } else {
      delete profile.extensions;
    }
  }
  const meaningful = Object.keys(profile).filter(
    (key) => key !== "profileVersion" && profile[key] !== undefined
  );
  return meaningful.length > 0 ? profile : undefined;
}
