// The jwt-bearer (RFC 7523) token-request body posted to the resource
// authorization server to redeem an ID-JAG. SINGLE SOURCE OF TRUTH — the
// inspector's `/proxy/token` debugger route, the connect-page mint, and the
// CLI's headless redemption all build their request body here so every surface
// stays byte-identical on the wire.
export function buildJwtBearerBody(args: {
  assertion: string;
  clientId?: string | null;
  clientSecret?: string | null;
  scope?: string | null;
  resource?: string | null;
}): Record<string, string> {
  return {
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: args.assertion,
    ...(args.clientId ? { client_id: args.clientId } : {}),
    ...(args.clientSecret ? { client_secret: args.clientSecret } : {}),
    ...(args.scope ? { scope: args.scope } : {}),
    ...(args.resource ? { resource: args.resource } : {}),
  };
}
