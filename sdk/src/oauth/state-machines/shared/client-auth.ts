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

  const filtered = raw.filter(
    (method): method is string => typeof method === "string",
  );
  return filtered.length > 0 ? filtered : ["client_secret_basic"];
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

  // Public preregistered client: send no client auth at the token endpoint and
  // let the AS reject if it actually requires a secret. Pre-flight blocking
  // breaks CLI flows (e.g. --client-id only) against ASes that don't advertise
  // "none" but accept unauthenticated public-client requests.
  return { ok: true, method: "none", supportedMethods };
}
