export type PreregisteredClientAuthMethod =
  | "client_secret_basic"
  | "client_secret_post"
  | "none";

export type PreregisteredClientAuthResolution =
  | {
      ok: true;
      method: PreregisteredClientAuthMethod;
      supportedMethods: string[];
    }
  | {
      ok: false;
      message: string;
      supportedMethods: string[];
    };

export function normalizeTokenEndpointAuthMethods(
  metadata: Record<string, unknown> | undefined,
): string[] {
  const raw = metadata?.token_endpoint_auth_methods_supported;
  if (!Array.isArray(raw) || raw.length === 0) {
    return ["client_secret_basic"];
  }

  return raw.filter((method): method is string => typeof method === "string");
}

export function resolvePreregisteredClientAuthMethod(input: {
  authorizationServerMetadata: Record<string, unknown> | undefined;
  hasClientSecret: boolean;
}): PreregisteredClientAuthResolution {
  const supportedMethods = normalizeTokenEndpointAuthMethods(
    input.authorizationServerMetadata,
  );

  if (input.hasClientSecret) {
    if (supportedMethods.includes("client_secret_basic")) {
      return { ok: true, method: "client_secret_basic", supportedMethods };
    }
    if (supportedMethods.includes("client_secret_post")) {
      return { ok: true, method: "client_secret_post", supportedMethods };
    }
    if (supportedMethods.includes("none")) {
      return { ok: true, method: "none", supportedMethods };
    }
    return {
      ok: false,
      message: `Unsupported OAuth client authentication method: ${
        supportedMethods.join(", ") || "none advertised"
      }.`,
      supportedMethods,
    };
  }

  if (supportedMethods.includes("none")) {
    return { ok: true, method: "none", supportedMethods };
  }

  return {
    ok: false,
    message:
      "This OAuth server requires a client secret for token exchange. Add the OAuth client secret in server settings before starting the flow.",
    supportedMethods,
  };
}
