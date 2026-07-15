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

export type XaaTokenEndpointAuthMethod =
  | "client_secret_post"
  | "client_secret_basic"
  | "none"
  | "private_key_jwt";

const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

// RFC 6749 section 2.3.1 requires each credential to be form-urlencoded before
// the `client_id:client_secret` pair is Base64-encoded.
function formUrlEncode(value: string): string {
  return encodeURIComponent(value)
    .replace(
      /[!'()~]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
    )
    .replace(/%20/g, "+");
}

function encodeBasicClientAuth(clientId: string, clientSecret: string): string {
  return Buffer.from(
    `${formUrlEncode(clientId)}:${formUrlEncode(clientSecret)}`
  ).toString("base64");
}

/** Build the jwt-bearer body and the selected OAuth client-auth headers. */
export function buildJwtBearerRequest(args: {
  assertion: string;
  clientId?: string | null;
  clientSecret?: string | null;
  scope?: string | null;
  resource?: string | null;
  tokenEndpointAuthMethod?: XaaTokenEndpointAuthMethod | null;
  /** The signed private_key_jwt assertion (confidential CIMD). */
  clientAssertion?: string | null;
}): { headers: Record<string, string>; body: Record<string, string> } {
  const method = args.tokenEndpointAuthMethod;

  if (method === "private_key_jwt") {
    if (!args.clientId || !args.clientAssertion) {
      throw new Error(
        "private_key_jwt requires a client_id and a signed client_assertion",
      );
    }
    return {
      headers: {},
      body: {
        ...buildJwtBearerBody({ ...args, clientSecret: null }),
        client_assertion_type: CLIENT_ASSERTION_TYPE,
        client_assertion: args.clientAssertion,
      },
    };
  }

  if (method === "client_secret_basic") {
    if (!args.clientId || !args.clientSecret) {
      throw new Error(
        "client_secret_basic requires both a client_id and a client_secret"
      );
    }
    return {
      headers: {
        Authorization: `Basic ${encodeBasicClientAuth(
          args.clientId,
          args.clientSecret
        )}`,
      },
      body: buildJwtBearerBody({
        ...args,
        clientId: null,
        clientSecret: null,
      }),
    };
  }

  if (method === "none") {
    if (!args.clientId) {
      throw new Error("A public (none) client request requires a client_id");
    }
    return {
      headers: {},
      body: buildJwtBearerBody({ ...args, clientSecret: null }),
    };
  }

  if (method === "client_secret_post") {
    if (!args.clientId || !args.clientSecret) {
      throw new Error(
        "client_secret_post requires both a client_id and a client_secret"
      );
    }
  }

  // Preserve the legacy no-method behavior: credentials, when present, stay
  // in the form body.
  return { headers: {}, body: buildJwtBearerBody(args) };
}
