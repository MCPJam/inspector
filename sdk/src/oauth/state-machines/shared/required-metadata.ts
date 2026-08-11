/**
 * Shared conformance policy for metadata the current MCP authorization profile
 * REQUIRES a client to verify before it sends the user to an authorization
 * server.
 *
 * Two checks live here, both scoped to the eras governed by the current profile
 * (2025-11-25 and later):
 *
 *   - PKCE. MCP Authorization requires the client to verify that the
 *     authorization server advertises S256 in
 *     `code_challenge_methods_supported` before proceeding. A server that
 *     advertises only `plain` cannot give the flow the protection PKCE exists
 *     for, and a client that proceeds anyway has silently downgraded.
 *   - Protected-resource metadata. RFC 9728's `authorization_servers` is where
 *     the resource says who may issue tokens for it. Substituting the MCP
 *     server's own URL when the list is missing invents an authorization server
 *     the resource never named, and the substitution is invisible in the trace.
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
 * Eras that predate the current profile. Everything else inherits it.
 *
 * A DENYLIST, not an allowlist. Naming the current eras positively reads more
 * naturally and fails in the wrong direction: a 2027 era would match neither
 * literal, silently revert to warn-and-continue, and produce no compiler
 * diagnostic to notice it by. For a fail-closed policy the default has to be
 * "strict", so a new era is protected on the day it is added rather than on the
 * day someone remembers this list.
 */
const LEGACY_METADATA_PROFILE_ERAS = new Set(["2025-03-26", "2025-06-18"]);

/**
 * Whether an era is governed by the current MCP protected-resource + PKCE
 * profile. Older eras keep their own behavior — this is not a place to
 * retroactively tighten a specification that genuinely said something else.
 */
export function usesCurrentRequiredMetadataProfile(
  protocolVersion: string,
): boolean {
  return !LEGACY_METADATA_PROFILE_ERAS.has(protocolVersion);
}

/**
 * Non-conformance message for the advertised PKCE methods, or `undefined` when
 * they satisfy the profile.
 *
 * Advertising `plain` ALONGSIDE S256 is not a failure — the client picks S256.
 * Only the absence of S256 is.
 */
/* Era scoping is the CALLER's: this reports non-conformance for whatever
 * version it is handed, and only the current-profile machines consult it. */
export function describePkceMetadataNonConformance(
  supportedMethods: readonly string[] | undefined,
  protocolVersion: string,
): string | undefined {
  if (!supportedMethods || supportedMethods.length === 0) {
    return (
      `PKCE is REQUIRED for ${protocolVersion} protocol, but authorization server ` +
      "does not advertise code_challenge_methods_supported. " +
      `Server is not compliant with ${protocolVersion} spec.`
    );
  }

  if (!supportedMethods.includes("S256")) {
    return (
      "Authorization server metadata must advertise S256 in " +
      `code_challenge_methods_supported for ${protocolVersion} conformance. ` +
      `Advertised: ${supportedMethods.join(", ")}.`
    );
  }

  return undefined;
}

export interface AuthorizationServerSelection {
  /** The authorization server to discover metadata from. */
  authorizationServerUrl: string;
  /**
   * Set when the protected-resource metadata did not name an authorization
   * server. Under `"reject"` the caller must stop; under `"observe"` it is a
   * warning that accompanies the substituted fallback.
   */
  error?: string;
  /** True when `authorizationServerUrl` was substituted, not advertised. */
  substituted: boolean;
}

/**
 * Pick the authorization server from protected-resource metadata.
 *
 * Returns the substitution rather than performing it silently, so the caller
 * can decide by enforcement mode and so the fallback is always visible.
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
