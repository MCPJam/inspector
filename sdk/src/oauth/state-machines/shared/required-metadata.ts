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
 * Eras whose authorization spec states that the protected-resource metadata
 * document MUST name at least one authorization server.
 *
 * 2025-03-26 predates the MCP profile's adoption of RFC 9728 entirely, so its
 * machine keeps the historical fallback.
 */
const ERAS_REQUIRING_ADVERTISED_AUTHORIZATION_SERVERS: readonly string[] = [
  "2025-06-18",
  "2025-11-25",
  "2026-07-28",
];

/**
 * Eras whose authorization spec requires the client to verify advertised PKCE
 * support before proceeding.
 */
const ERAS_REQUIRING_ADVERTISED_S256: readonly string[] = [
  "2025-11-25",
  "2026-07-28",
];

/** Whether `protocolVersion` requires the PRM to name an authorization server. */
export function requiresAdvertisedAuthorizationServers(
  protocolVersion: string,
): boolean {
  return ERAS_REQUIRING_ADVERTISED_AUTHORIZATION_SERVERS.includes(
    protocolVersion,
  );
}

/** Whether `protocolVersion` requires the AS to advertise S256 for PKCE. */
export function requiresAdvertisedS256(protocolVersion: string): boolean {
  return ERAS_REQUIRING_ADVERTISED_S256.includes(protocolVersion);
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
      `MCPJam will not downgrade to a weaker code challenge method, so the ` +
      `${protocolVersion} flow stops here.`
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
  const advertised = input.authorizationServers?.find(
    (entry) => typeof entry === "string" && entry.trim() !== "",
  );

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
