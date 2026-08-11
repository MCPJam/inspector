/**
 * Shared conformance policy for metadata an MCP authorization profile REQUIRES
 * a client to verify before it sends the user to an authorization server.
 *
 * Two checks live here. They are NOT gated on the same eras, because the spec
 * text behind them does not have the same history — one gate covering both
 * would either miss an era that genuinely states the requirement or invent one
 * for an era that is silent:
 *
 *   - Protected-resource metadata. RFC 9728's `authorization_servers` is where
 *     the resource says who may issue tokens for it. Substituting the MCP
 *     server's own URL when the list is missing invents an authorization server
 *     the resource never named, and the substitution is invisible in the trace.
 *     Required from 2025-06-18 onward: that revision already said the PRM
 *     document "MUST include the `authorization_servers` field containing at
 *     least one authorization server," and 2025-11-25 and 2026-07-28 repeat it
 *     verbatim.
 *   - PKCE. The client must verify that the authorization server advertises
 *     S256 in `code_challenge_methods_supported` before proceeding. A server
 *     that advertises only `plain` cannot give the flow the protection PKCE
 *     exists for, and a client that proceeds anyway has silently downgraded.
 *     Gated at 2025-11-25 because 2025-06-18 says nothing at all about
 *     `code_challenge_methods_supported` — staying silent there is the
 *     version-faithful behavior, not a gap.
 *
 * `enforcement` exists because MCPJam is also a debugger, and the whole point
 * of pointing it at a half-built server is to SEE what that server does. But
 * that is a non-connect intent and has to be asked for: the default fails
 * closed, and only a surface that explicitly passes `"observe"` gets the
 * warn-and-continue behavior.
 */

export type RequiredMetadataEnforcement =
  /** Fail closed. The default, and what every connect-like path uses. */
  | "reject"
  /** Warn and continue so the debugger can show nonconforming behavior. */
  | "observe";

/**
 * Eras that PREDATE each requirement.
 *
 * DENYLISTS, not allowlists. Naming the current eras positively reads more
 * naturally and fails in the wrong direction: a 2027 era would match no
 * literal, silently revert to warn-and-continue, and produce no compiler
 * diagnostic to notice it by. For a fail-closed policy the default has to be
 * "strict", so a new era is protected on the day it is added rather than on the
 * day someone remembers this list.
 *
 * There are two of them because the two requirements entered the spec at
 * different times. A single gate covering both would either miss an era that
 * genuinely states one requirement or invent one for an era that is silent —
 * and the first of those turns the version selector into a bypass.
 */

/**
 * 2025-03-26 predates the MCP profile's adoption of RFC 9728 entirely, so its
 * machine keeps the historical fallback. 2025-06-18 onward states that the
 * protected-resource metadata document MUST name at least one authorization
 * server.
 */
const ERAS_BEFORE_REQUIRED_AUTHORIZATION_SERVERS = new Set(["2025-03-26"]);

/**
 * 2025-06-18 and earlier say nothing at all about
 * `code_challenge_methods_supported`, so verifying advertised S256 support
 * starts at 2025-11-25.
 */
const ERAS_BEFORE_REQUIRED_S256 = new Set(["2025-03-26", "2025-06-18"]);

/** Whether `protocolVersion` requires the PRM to name an authorization server. */
export function requiresAdvertisedAuthorizationServers(
  protocolVersion: string,
): boolean {
  return !ERAS_BEFORE_REQUIRED_AUTHORIZATION_SERVERS.has(protocolVersion);
}

/** Whether `protocolVersion` requires the AS to advertise S256 for PKCE. */
export function requiresAdvertisedS256(protocolVersion: string): boolean {
  return !ERAS_BEFORE_REQUIRED_S256.has(protocolVersion);
}

/**
 * Non-conformance message for the advertised PKCE methods, or `undefined` when
 * they satisfy the era's profile.
 *
 * Advertising `plain` ALONGSIDE S256 is not a failure — the client picks S256.
 * Only the absence of S256 is.
 *
 * The message is deliberately phrased as MCPJam's policy rather than a spec
 * verdict for the "advertised, but no S256" case. The spec requires the client
 * to VERIFY PKCE support and to use S256 when technically capable; it states a
 * MUST-refuse only for metadata that omits `code_challenge_methods_supported`
 * altogether. Refusing a `plain`-only server is the right call, but it is a
 * downgrade refusal, not a conformance failure we can cite.
 *
 * Era scoping is THIS function's, not the caller's: it returns `undefined` for
 * an era that never required S256, so every machine can call it and get its own
 * era's policy. A caller-scoped gate is what lets a new era's machine silently
 * omit the check.
 */
export function describePkceMetadataNonConformance(
  supportedMethods: readonly string[] | undefined,
  protocolVersion: string,
): string | undefined {
  if (!requiresAdvertisedS256(protocolVersion)) {
    return undefined;
  }

  if (!supportedMethods || supportedMethods.length === 0) {
    return (
      `PKCE is REQUIRED for ${protocolVersion} protocol, but authorization server ` +
      "does not advertise code_challenge_methods_supported. " +
      `Server is not compliant with ${protocolVersion} spec.`
    );
  }

  if (!supportedMethods.includes("S256")) {
    return (
      "Authorization server advertises PKCE without S256 " +
      `(advertised: ${supportedMethods.join(", ")}). ` +
      "MCPJam will not downgrade to a weaker code challenge method, so the " +
      `${protocolVersion} flow stops here. Use the OAuth debugger to observe ` +
      "this server's behavior without connecting."
    );
  }

  return undefined;
}

export interface AuthorizationServerSelection {
  /** The authorization server to discover metadata from. */
  authorizationServerUrl: string;
  /**
   * Set when the era requires the protected-resource metadata to name an
   * authorization server and it did not. Under `"reject"` the caller must stop;
   * under `"observe"` it is a warning that accompanies the substituted
   * fallback. Absent for eras that permit the substitution.
   */
  error?: string;
  /** True when `authorizationServerUrl` was substituted, not advertised. */
  substituted: boolean;
}

/**
 * Pick the authorization server from protected-resource metadata.
 *
 * Returns the substitution rather than performing it silently, so the caller
 * can decide by enforcement mode and so the fallback is always visible. Every
 * era's machine can call this: the era gate lives here, so a machine whose
 * spec permits the fallback gets `substituted` without an `error`.
 */
export function selectAuthorizationServerFromResourceMetadata(input: {
  authorizationServers: readonly string[] | undefined;
  fallbackServerUrl: string;
  protocolVersion: string;
}): AuthorizationServerSelection {
  // Trimmed, not the original: the emptiness test already trims, so a padded
  // entry would otherwise pass the check and reach URL parsing with whitespace
  // intact.
  const advertised = input.authorizationServers
    ?.find((entry) => typeof entry === "string" && entry.trim() !== "")
    ?.trim();

  if (advertised) {
    return { authorizationServerUrl: advertised, substituted: false };
  }

  if (!requiresAdvertisedAuthorizationServers(input.protocolVersion)) {
    return {
      authorizationServerUrl: input.fallbackServerUrl,
      substituted: true,
    };
  }

  return {
    authorizationServerUrl: input.fallbackServerUrl,
    substituted: true,
    error:
      "Protected resource metadata does not list an authorization server. " +
      `RFC 9728 \`authorization_servers\` is required by the ${input.protocolVersion} ` +
      "MCP profile; without it there is no server authorized to issue tokens " +
      "for this resource, and using the MCP server's own URL would invent one.",
  };
}
