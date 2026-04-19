import pkceChallenge from "pkce-challenge";
import type {
  AuthResult,
  AuthorizationServerMetadata,
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  OAuthMetadata,
  OAuthProtectedResourceMetadata,
  OAuthServerInfo,
  OAuthTokens,
  OpenIdProviderDiscoveryMetadata,
} from "@modelcontextprotocol/client";

const AUTHORIZATION_CODE_RESPONSE_TYPE = "code";
const AUTHORIZATION_CODE_CHALLENGE_METHOD = "S256";
const LATEST_PROTOCOL_VERSION = "2025-11-25";

type FetchFn = typeof fetch;
type ClientAuthMethod =
  | "client_secret_basic"
  | "client_secret_post"
  | "none";

type OAuthErrorResponse = {
  error?: string;
  error_description?: string;
  error_uri?: string;
};

class OAuthResponseError extends Error {
  code?: string;
  uri?: string;

  constructor(message: string, code?: string, uri?: string) {
    super(message);
    this.name = "OAuthResponseError";
    this.code = code;
    this.uri = uri;
  }
}

type DiscoverMetadataOptions = {
  protocolVersion?: string;
  metadataUrl?: string | URL;
  metadataServerUrl?: string | URL;
};

type DiscoverAuthorizationServerMetadataOptions = {
  fetchFn?: FetchFn;
  protocolVersion?: string;
};

type DiscoverOAuthMetadataOptions = {
  authorizationServerUrl?: string | URL;
  protocolVersion?: string;
};

type DiscoverProtectedResourceMetadataOptions = {
  resourceMetadataUrl?: string | URL;
  protocolVersion?: string;
};

type DiscoverOAuthServerInfoOptions = {
  resourceMetadataUrl?: string | URL;
  fetchFn?: FetchFn;
};

type StartAuthorizationOptions = {
  metadata?: OAuthMetadata | AuthorizationServerMetadata;
  clientInformation: OAuthClientInformationMixed;
  redirectUrl: string | URL;
  scope?: string;
  state?: string;
  resource?: URL;
};

type ExchangeAuthorizationOptions = {
  metadata?: OAuthMetadata | AuthorizationServerMetadata;
  clientInformation: OAuthClientInformationMixed;
  authorizationCode: string;
  codeVerifier: string;
  redirectUri: string | URL;
  resource?: URL;
  addClientAuthentication?: OAuthClientProvider["addClientAuthentication"];
  fetchFn?: FetchFn;
};

type FetchTokenOptions = {
  metadata?: OAuthMetadata | AuthorizationServerMetadata;
  resource?: URL;
  authorizationCode?: string;
  scope?: string;
  fetchFn?: FetchFn;
};

type RegisterClientOptions = {
  metadata?: OAuthMetadata | AuthorizationServerMetadata;
  clientMetadata: OAuthClientMetadata;
  scope?: string;
  fetchFn?: FetchFn;
};

type OAuthServerMetadata =
  | AuthorizationServerMetadata
  | OpenIdProviderDiscoveryMetadata;

function getFetch(fetchFn?: FetchFn): FetchFn {
  return fetchFn ?? fetch;
}

function isOAuthMetadataDocument(
  value: OAuthServerMetadata | undefined,
): value is OAuthMetadata {
  return (
    !!value &&
    typeof value === "object" &&
    "token_endpoint_auth_methods_supported" in value
  );
}

function isClientAuthMethod(method: string): method is ClientAuthMethod {
  return ["client_secret_basic", "client_secret_post", "none"].includes(method);
}

function isHttpsUrl(value: string | undefined): boolean {
  if (!value) return false;

  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname !== "/";
  } catch {
    return false;
  }
}

function resourceUrlFromServerUrl(url: string | URL): URL {
  const resourceUrl = typeof url === "string" ? new URL(url) : new URL(url.href);
  resourceUrl.hash = "";
  return resourceUrl;
}

function checkResourceAllowed({
  requestedResource,
  configuredResource,
}: {
  requestedResource: string | URL;
  configuredResource: string | URL;
}): boolean {
  const requested =
    typeof requestedResource === "string"
      ? new URL(requestedResource)
      : new URL(requestedResource.href);
  const configured =
    typeof configuredResource === "string"
      ? new URL(configuredResource)
      : new URL(configuredResource.href);

  if (requested.origin !== configured.origin) {
    return false;
  }

  if (requested.pathname.length < configured.pathname.length) {
    return false;
  }

  const requestedPath = requested.pathname.endsWith("/")
    ? requested.pathname
    : `${requested.pathname}/`;
  const configuredPath = configured.pathname.endsWith("/")
    ? configured.pathname
    : `${configured.pathname}/`;

  return requestedPath.startsWith(configuredPath);
}

function selectClientAuthMethod(
  clientInformation: OAuthClientInformationMixed,
  supportedMethods: string[],
): ClientAuthMethod {
  const hasClientSecret =
    "client_secret" in clientInformation &&
    clientInformation.client_secret !== undefined;

  if (supportedMethods.length === 0) {
    return hasClientSecret ? "client_secret_post" : "none";
  }

  const explicitMethod =
    "token_endpoint_auth_method" in clientInformation
      ? clientInformation.token_endpoint_auth_method
      : undefined;

  if (
    explicitMethod &&
    isClientAuthMethod(explicitMethod) &&
    supportedMethods.includes(explicitMethod)
  ) {
    return explicitMethod;
  }

  if (hasClientSecret && supportedMethods.includes("client_secret_basic")) {
    return "client_secret_basic";
  }

  if (hasClientSecret && supportedMethods.includes("client_secret_post")) {
    return "client_secret_post";
  }

  if (supportedMethods.includes("none")) {
    return "none";
  }

  return hasClientSecret ? "client_secret_post" : "none";
}

function applyClientAuthentication(
  method: ClientAuthMethod,
  clientInformation: OAuthClientInformationMixed,
  headers: Headers,
  params: URLSearchParams,
) {
  const clientId = clientInformation.client_id;
  const clientSecret =
    "client_secret" in clientInformation
      ? clientInformation.client_secret
      : undefined;

  switch (method) {
    case "client_secret_basic": {
      if (!clientSecret) {
        throw new Error(
          "client_secret_basic authentication requires a client_secret",
        );
      }
      const credentials = btoa(`${clientId}:${clientSecret}`);
      headers.set("Authorization", `Basic ${credentials}`);
      return;
    }
    case "client_secret_post":
      params.set("client_id", clientId);
      if (clientSecret) {
        params.set("client_secret", clientSecret);
      }
      return;
    case "none":
      params.set("client_id", clientId);
      return;
  }
}

async function parseErrorResponse(input: Response | string): Promise<Error> {
  const statusCode = input instanceof Response ? input.status : undefined;
  const body = input instanceof Response ? await input.text() : input;

  try {
    const parsed = JSON.parse(body) as OAuthErrorResponse;
    const message =
      parsed.error_description ||
      parsed.error ||
      `${statusCode ? `HTTP ${statusCode}: ` : ""}OAuth request failed`;
    return new OAuthResponseError(message, parsed.error, parsed.error_uri);
  } catch (error) {
    const prefix = statusCode ? `HTTP ${statusCode}: ` : "";
    return new Error(`${prefix}Invalid OAuth error response: ${body}`);
  }
}

async function fetchWithCorsRetry(
  url: string | URL,
  headers?: HeadersInit,
  fetchFn: FetchFn = fetch,
): Promise<Response | undefined> {
  try {
    return await fetchFn(url, { headers });
  } catch (error) {
    if (!(error instanceof TypeError)) {
      throw error;
    }

    if (!headers) {
      return undefined;
    }

    try {
      return await fetchFn(url, {});
    } catch (retryError) {
      if (!(retryError instanceof TypeError)) {
        throw retryError;
      }
      return undefined;
    }
  }
}

function buildWellKnownPath(
  wellKnownPrefix: string,
  pathname = "",
  options: { prependPathname?: boolean } = {},
) {
  const normalizedPath = pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
  return options.prependPathname
    ? `${normalizedPath}/.well-known/${wellKnownPrefix}`
    : `/.well-known/${wellKnownPrefix}${normalizedPath}`;
}

async function tryMetadataDiscovery(
  url: URL,
  protocolVersion: string,
  fetchFn: FetchFn = fetch,
) {
  return fetchWithCorsRetry(
    url,
    {
      "MCP-Protocol-Version": protocolVersion,
      Accept: "application/json",
    },
    fetchFn,
  );
}

function shouldAttemptFallback(
  response: Response | undefined,
  pathname: string,
): boolean {
  if (!response) return true;
  if (pathname === "/") return false;
  return (
    (response.status >= 400 && response.status < 500) || response.status === 502
  );
}

async function discoverMetadataWithFallback(
  serverUrl: string | URL,
  wellKnownType: string,
  fetchFn: FetchFn,
  opts?: DiscoverMetadataOptions,
) {
  const issuer = new URL(serverUrl);
  const protocolVersion = opts?.protocolVersion ?? LATEST_PROTOCOL_VERSION;

  let url: URL;
  if (opts?.metadataUrl) {
    url = new URL(opts.metadataUrl);
  } else {
    const wellKnownPath = buildWellKnownPath(wellKnownType, issuer.pathname);
    url = new URL(wellKnownPath, opts?.metadataServerUrl ?? issuer);
    url.search = issuer.search;
  }

  let response = await tryMetadataDiscovery(url, protocolVersion, fetchFn);

  if (!opts?.metadataUrl && shouldAttemptFallback(response, issuer.pathname)) {
    response = await tryMetadataDiscovery(
      new URL(`/.well-known/${wellKnownType}`, issuer),
      protocolVersion,
      fetchFn,
    );
  }

  return response;
}

function buildDiscoveryUrls(authorizationServerUrl: string | URL) {
  const url =
    typeof authorizationServerUrl === "string"
      ? new URL(authorizationServerUrl)
      : authorizationServerUrl;
  const hasPath = url.pathname !== "/";

  if (!hasPath) {
    return [
      {
        url: new URL("/.well-known/oauth-authorization-server", url.origin),
        type: "oauth" as const,
      },
      {
        url: new URL("/.well-known/openid-configuration", url.origin),
        type: "oidc" as const,
      },
    ];
  }

  const normalizedPath = url.pathname.endsWith("/")
    ? url.pathname.slice(0, -1)
    : url.pathname;

  return [
    {
      url: new URL(
        `/.well-known/oauth-authorization-server${normalizedPath}`,
        url.origin,
      ),
      type: "oauth" as const,
    },
    {
      url: new URL(
        `/.well-known/openid-configuration${normalizedPath}`,
        url.origin,
      ),
      type: "oidc" as const,
    },
    {
      url: new URL(
        `${normalizedPath}/.well-known/openid-configuration`,
        url.origin,
      ),
      type: "oidc" as const,
    },
  ];
}

function prepareAuthorizationCodeRequest(
  authorizationCode: string,
  codeVerifier: string,
  redirectUri: string | URL,
) {
  return new URLSearchParams({
    grant_type: "authorization_code",
    code: authorizationCode,
    code_verifier: codeVerifier,
    redirect_uri: String(redirectUri),
  });
}

async function executeTokenRequest(
  authorizationServerUrl: string | URL,
  {
    metadata,
    tokenRequestParams,
    clientInformation,
    addClientAuthentication,
    resource,
    fetchFn,
  }: {
    metadata?: OAuthMetadata | AuthorizationServerMetadata;
    tokenRequestParams: URLSearchParams;
    clientInformation?: OAuthClientInformationMixed;
    addClientAuthentication?: OAuthClientProvider["addClientAuthentication"];
    resource?: URL;
    fetchFn?: FetchFn;
  },
) {
  const tokenEndpoint =
    metadata && "token_endpoint" in metadata && metadata.token_endpoint
      ? metadata.token_endpoint
      : new URL("/token", authorizationServerUrl).toString();
  const tokenUrl = new URL(tokenEndpoint);
  const headers = new Headers({
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  });

  if (resource) {
    tokenRequestParams.set("resource", resource.href);
  }

  if (addClientAuthentication) {
    await addClientAuthentication(headers, tokenRequestParams, tokenUrl, metadata);
  } else if (clientInformation) {
    const supportedMethods = isOAuthMetadataDocument(metadata)
      ? metadata.token_endpoint_auth_methods_supported ?? []
      : [];
    applyClientAuthentication(
      selectClientAuthMethod(clientInformation, supportedMethods),
      clientInformation,
      headers,
      tokenRequestParams,
    );
  }

  const response = await getFetch(fetchFn)(tokenUrl, {
    method: "POST",
    headers,
    body: tokenRequestParams,
  });

  if (!response.ok) {
    throw await parseErrorResponse(response);
  }

  return (await response.json()) as OAuthTokens;
}

async function refreshAuthorization(
  authorizationServerUrl: string | URL,
  {
    metadata,
    clientInformation,
    refreshToken,
    resource,
    addClientAuthentication,
    fetchFn,
  }: {
    metadata?: OAuthMetadata | AuthorizationServerMetadata;
    clientInformation: OAuthClientInformationMixed;
    refreshToken: string;
    resource?: URL;
    addClientAuthentication?: OAuthClientProvider["addClientAuthentication"];
    fetchFn?: FetchFn;
  },
) {
  return {
    refresh_token: refreshToken,
    ...(await executeTokenRequest(authorizationServerUrl, {
      metadata,
      tokenRequestParams: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      clientInformation,
      addClientAuthentication,
      resource,
      fetchFn,
    })),
  } as OAuthTokens;
}

export async function auth(
  provider: OAuthClientProvider,
  options: {
    serverUrl: string | URL;
    authorizationCode?: string;
    scope?: string;
    resourceMetadataUrl?: string | URL;
    fetchFn?: FetchFn;
  },
): Promise<AuthResult> {
  try {
    return await authInternal(provider, options);
  } catch (error) {
    const code =
      error instanceof OAuthResponseError ? error.code : undefined;

    if (code === "invalid_client" || code === "unauthorized_client") {
      await provider.invalidateCredentials?.("all");
      return authInternal(provider, options);
    }

    if (code === "invalid_grant") {
      await provider.invalidateCredentials?.("tokens");
      return authInternal(provider, options);
    }

    throw error;
  }
}

async function authInternal(
  provider: OAuthClientProvider,
  {
    serverUrl,
    authorizationCode,
    scope,
    resourceMetadataUrl,
    fetchFn,
  }: {
    serverUrl: string | URL;
    authorizationCode?: string;
    scope?: string;
    resourceMetadataUrl?: string | URL;
    fetchFn?: FetchFn;
  },
): Promise<AuthResult> {
  const cachedState = await provider.discoveryState?.();
  const effectiveResourceMetadataUrl =
    resourceMetadataUrl ?? cachedState?.resourceMetadataUrl;

  let resourceMetadata = cachedState?.resourceMetadata;
  let authorizationServerUrl = cachedState?.authorizationServerUrl;
  let metadata = cachedState?.authorizationServerMetadata;

  if (authorizationServerUrl) {
    metadata =
      metadata ??
      (await discoverAuthorizationServerMetadata(authorizationServerUrl, {
        fetchFn,
      }));

    if (!resourceMetadata) {
      try {
        resourceMetadata = await discoverOAuthProtectedResourceMetadata(
          serverUrl,
          {
            resourceMetadataUrl: effectiveResourceMetadataUrl,
          },
          fetchFn,
        );
      } catch {
        // Ignore RFC 9728 discovery failures here; we can still continue.
      }
    }

    if (
      metadata !== cachedState?.authorizationServerMetadata ||
      resourceMetadata !== cachedState?.resourceMetadata
    ) {
      await provider.saveDiscoveryState?.({
        authorizationServerUrl: String(authorizationServerUrl),
        resourceMetadataUrl: effectiveResourceMetadataUrl
          ? String(effectiveResourceMetadataUrl)
          : undefined,
        resourceMetadata,
        authorizationServerMetadata: metadata,
      } satisfies OAuthDiscoveryState);
    }
  } else {
    const discovered = await discoverOAuthServerInfo(serverUrl, {
      resourceMetadataUrl: effectiveResourceMetadataUrl,
      fetchFn,
    });
    authorizationServerUrl = discovered.authorizationServerUrl;
    metadata = discovered.authorizationServerMetadata;
    resourceMetadata = discovered.resourceMetadata;

    await provider.saveDiscoveryState?.({
      authorizationServerUrl: String(authorizationServerUrl),
      resourceMetadataUrl: effectiveResourceMetadataUrl
        ? String(effectiveResourceMetadataUrl)
        : undefined,
      resourceMetadata,
      authorizationServerMetadata: metadata,
    } satisfies OAuthDiscoveryState);
  }

  const resource = await selectResourceURL(serverUrl, provider, resourceMetadata);

  let clientInformation = await provider.clientInformation();
  if (!clientInformation) {
    if (authorizationCode !== undefined) {
      throw new Error(
        "Existing OAuth client information is required when exchanging an authorization code",
      );
    }

    const supportsUrlBasedClientId =
      metadata &&
      "client_id_metadata_document_supported" in metadata &&
      metadata.client_id_metadata_document_supported === true;
    const clientMetadataUrl = provider.clientMetadataUrl;

    if (clientMetadataUrl && !isHttpsUrl(clientMetadataUrl)) {
      throw new Error(
        `clientMetadataUrl must be a valid HTTPS URL with a non-root pathname, got: ${clientMetadataUrl}`,
      );
    }

    if (supportsUrlBasedClientId && clientMetadataUrl) {
      clientInformation = {
        client_id: clientMetadataUrl,
      };
      await provider.saveClientInformation?.(clientInformation);
    } else {
      if (!provider.saveClientInformation) {
        throw new Error(
          "OAuth client information must be saveable for dynamic registration",
        );
      }

      const fullInformation = await registerClient(authorizationServerUrl, {
        metadata,
        clientMetadata: provider.clientMetadata,
        fetchFn,
      });
      await provider.saveClientInformation(fullInformation);
      clientInformation = fullInformation;
    }
  }

  const nonInteractiveFlow = !provider.redirectUrl;
  if (authorizationCode !== undefined || nonInteractiveFlow) {
    const tokens = await fetchToken(provider, authorizationServerUrl, {
      metadata,
      resource,
      authorizationCode,
      fetchFn,
    });
    await provider.saveTokens(tokens);
    return "AUTHORIZED";
  }

  const existingTokens = await provider.tokens();
  if (existingTokens?.refresh_token) {
    try {
      const refreshedTokens = await refreshAuthorization(authorizationServerUrl, {
        metadata,
        clientInformation,
        refreshToken: existingTokens.refresh_token,
        resource,
        addClientAuthentication: provider.addClientAuthentication,
        fetchFn,
      });
      await provider.saveTokens(refreshedTokens);
      return "AUTHORIZED";
    } catch (error) {
      if (
        error instanceof OAuthResponseError &&
        error.code &&
        error.code !== "server_error"
      ) {
        throw error;
      }
    }
  }

  const state = provider.state ? await provider.state() : undefined;
  const resolvedScope =
    scope ||
    resourceMetadata?.scopes_supported?.join(" ") ||
    provider.clientMetadata.scope;
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    authorizationServerUrl,
    {
      metadata,
      clientInformation,
      state,
      redirectUrl: provider.redirectUrl,
      scope: resolvedScope,
      resource,
    },
  );
  await provider.saveCodeVerifier(codeVerifier);
  await provider.redirectToAuthorization(authorizationUrl);
  return "REDIRECT";
}

export async function selectResourceURL(
  serverUrl: string | URL,
  provider: OAuthClientProvider,
  resourceMetadata?: OAuthProtectedResourceMetadata,
): Promise<URL | undefined> {
  const defaultResource = resourceUrlFromServerUrl(serverUrl);

  if (provider.validateResourceURL) {
    return provider.validateResourceURL(defaultResource, resourceMetadata?.resource);
  }

  if (!resourceMetadata) {
    return undefined;
  }

  if (
    !checkResourceAllowed({
      requestedResource: defaultResource,
      configuredResource: resourceMetadata.resource,
    })
  ) {
    throw new Error(
      `Protected resource ${resourceMetadata.resource} does not match expected ${defaultResource} (or origin)`,
    );
  }

  return new URL(resourceMetadata.resource);
}

export async function discoverOAuthProtectedResourceMetadata(
  serverUrl: string | URL,
  opts?: DiscoverProtectedResourceMetadataOptions,
  fetchFn: FetchFn = fetch,
): Promise<OAuthProtectedResourceMetadata> {
  const response = await discoverMetadataWithFallback(
    serverUrl,
    "oauth-protected-resource",
    fetchFn,
    {
      protocolVersion: opts?.protocolVersion,
      metadataUrl: opts?.resourceMetadataUrl,
    },
  );

  if (!response || response.status === 404) {
    await response?.text?.().catch(() => {});
    throw new Error(
      "Resource server does not implement OAuth 2.0 Protected Resource Metadata.",
    );
  }

  if (!response.ok) {
    await response.text().catch(() => {});
    throw new Error(
      `HTTP ${response.status} trying to load well-known OAuth protected resource metadata.`,
    );
  }

  return (await response.json()) as OAuthProtectedResourceMetadata;
}

export async function discoverOAuthMetadata(
  issuer: string | URL,
  {
    authorizationServerUrl,
    protocolVersion,
  }: DiscoverOAuthMetadataOptions = {},
  fetchFn: FetchFn = fetch,
): Promise<OAuthMetadata | undefined> {
  const issuerUrl = typeof issuer === "string" ? new URL(issuer) : issuer;
  const authServerUrl =
    typeof authorizationServerUrl === "string"
      ? new URL(authorizationServerUrl)
      : authorizationServerUrl ?? issuerUrl;

  const response = await discoverMetadataWithFallback(
    authServerUrl,
    "oauth-authorization-server",
    fetchFn,
    {
      protocolVersion: protocolVersion ?? LATEST_PROTOCOL_VERSION,
      metadataServerUrl: authServerUrl,
    },
  );

  if (!response || response.status === 404) {
    await response?.text?.().catch(() => {});
    return undefined;
  }

  if (!response.ok) {
    await response.text().catch(() => {});
    throw new Error(
      `HTTP ${response.status} trying to load well-known OAuth metadata`,
    );
  }

  return (await response.json()) as OAuthMetadata;
}

export async function discoverAuthorizationServerMetadata(
  authorizationServerUrl: string | URL,
  {
    fetchFn = fetch,
    protocolVersion = LATEST_PROTOCOL_VERSION,
  }: DiscoverAuthorizationServerMetadataOptions = {},
): Promise<OAuthServerMetadata | undefined> {
  const headers = {
    "MCP-Protocol-Version": protocolVersion,
    Accept: "application/json",
  };

  for (const { url, type } of buildDiscoveryUrls(authorizationServerUrl)) {
    const response = await fetchWithCorsRetry(url, headers, fetchFn);

    if (!response) {
      continue;
    }

    if (!response.ok) {
      await response.text().catch(() => {});
      if (
        (response.status >= 400 && response.status < 500) ||
        response.status === 502
      ) {
        continue;
      }
      throw new Error(
        `HTTP ${response.status} trying to load ${
          type === "oauth" ? "OAuth" : "OpenID provider"
        } metadata from ${url}`,
      );
    }

    return (await response.json()) as OAuthServerMetadata;
  }

  return undefined;
}

export async function discoverOAuthServerInfo(
  serverUrl: string | URL,
  opts?: DiscoverOAuthServerInfoOptions,
): Promise<OAuthServerInfo> {
  let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
  let authorizationServerUrl: string | URL | undefined;

  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(
      serverUrl,
      {
        resourceMetadataUrl: opts?.resourceMetadataUrl,
      },
      opts?.fetchFn,
    );

    if (resourceMetadata.authorization_servers?.length) {
      authorizationServerUrl = resourceMetadata.authorization_servers[0];
    }
  } catch (error) {
    if (error instanceof TypeError) {
      throw error;
    }
  }

  if (!authorizationServerUrl) {
    authorizationServerUrl = String(new URL("/", serverUrl));
  }

  const authorizationServerMetadata = await discoverAuthorizationServerMetadata(
    authorizationServerUrl,
    { fetchFn: opts?.fetchFn },
  );

  return {
    authorizationServerUrl: String(authorizationServerUrl),
    authorizationServerMetadata,
    resourceMetadata,
  };
}

export async function startAuthorization(
  authorizationServerUrl: string | URL,
  {
    metadata,
    clientInformation,
    redirectUrl,
    scope,
    state,
    resource,
  }: StartAuthorizationOptions,
): Promise<{ authorizationUrl: URL; codeVerifier: string }> {
  let authorizationUrl: URL;

  if (
    metadata &&
    "authorization_endpoint" in metadata &&
    metadata.authorization_endpoint
  ) {
    authorizationUrl = new URL(metadata.authorization_endpoint);

    if (
      "response_types_supported" in metadata &&
      metadata.response_types_supported &&
      !metadata.response_types_supported.includes(AUTHORIZATION_CODE_RESPONSE_TYPE)
    ) {
      throw new Error(
        `Incompatible auth server: does not support response type ${AUTHORIZATION_CODE_RESPONSE_TYPE}`,
      );
    }

    if (
      "code_challenge_methods_supported" in metadata &&
      metadata.code_challenge_methods_supported &&
      !metadata.code_challenge_methods_supported.includes(
        AUTHORIZATION_CODE_CHALLENGE_METHOD,
      )
    ) {
      throw new Error(
        `Incompatible auth server: does not support code challenge method ${AUTHORIZATION_CODE_CHALLENGE_METHOD}`,
      );
    }
  } else {
    authorizationUrl = new URL("/authorize", authorizationServerUrl);
  }

  const challenge = await pkceChallenge();
  const codeVerifier = challenge.code_verifier;
  const codeChallenge = challenge.code_challenge;

  authorizationUrl.searchParams.set(
    "response_type",
    AUTHORIZATION_CODE_RESPONSE_TYPE,
  );
  authorizationUrl.searchParams.set("client_id", clientInformation.client_id);
  authorizationUrl.searchParams.set("code_challenge", codeChallenge);
  authorizationUrl.searchParams.set(
    "code_challenge_method",
    AUTHORIZATION_CODE_CHALLENGE_METHOD,
  );
  authorizationUrl.searchParams.set("redirect_uri", String(redirectUrl));

  if (state) {
    authorizationUrl.searchParams.set("state", state);
  }
  if (scope) {
    authorizationUrl.searchParams.set("scope", scope);
  }
  if (scope?.split(" ").includes("offline_access")) {
    authorizationUrl.searchParams.append("prompt", "consent");
  }
  if (resource) {
    authorizationUrl.searchParams.set("resource", resource.href);
  }

  return {
    authorizationUrl,
    codeVerifier,
  };
}

export async function exchangeAuthorization(
  authorizationServerUrl: string | URL,
  {
    metadata,
    clientInformation,
    authorizationCode,
    codeVerifier,
    redirectUri,
    resource,
    addClientAuthentication,
    fetchFn,
  }: ExchangeAuthorizationOptions,
): Promise<OAuthTokens> {
  return executeTokenRequest(authorizationServerUrl, {
    metadata,
    tokenRequestParams: prepareAuthorizationCodeRequest(
      authorizationCode,
      codeVerifier,
      redirectUri,
    ),
    clientInformation,
    addClientAuthentication,
    resource,
    fetchFn,
  });
}

export async function fetchToken(
  provider: OAuthClientProvider,
  authorizationServerUrl: string | URL,
  {
    metadata,
    resource,
    authorizationCode,
    scope,
    fetchFn,
  }: FetchTokenOptions = {},
): Promise<OAuthTokens> {
  const effectiveScope = scope ?? provider.clientMetadata.scope;
  let tokenRequestParams = await provider.prepareTokenRequest?.(effectiveScope);

  if (!tokenRequestParams) {
    if (!authorizationCode) {
      throw new Error(
        "Either provider.prepareTokenRequest() or authorizationCode is required",
      );
    }
    if (!provider.redirectUrl) {
      throw new Error("redirectUrl is required for authorization_code flow");
    }
    tokenRequestParams = prepareAuthorizationCodeRequest(
      authorizationCode,
      await provider.codeVerifier(),
      provider.redirectUrl,
    );
  }

  const clientInformation = await provider.clientInformation();
  return executeTokenRequest(authorizationServerUrl, {
    metadata,
    tokenRequestParams,
    clientInformation: clientInformation ?? undefined,
    addClientAuthentication: provider.addClientAuthentication,
    resource,
    fetchFn,
  });
}

export async function registerClient(
  authorizationServerUrl: string | URL,
  {
    metadata,
    clientMetadata,
    scope,
    fetchFn,
  }: RegisterClientOptions,
): Promise<OAuthClientInformationFull> {
  let registrationUrl: URL;

  if (
    metadata &&
    "registration_endpoint" in metadata &&
    metadata.registration_endpoint
  ) {
    registrationUrl = new URL(metadata.registration_endpoint);
  } else {
    registrationUrl = new URL("/register", authorizationServerUrl);
  }

  const response = await getFetch(fetchFn)(registrationUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...clientMetadata,
      ...(scope === undefined ? {} : { scope }),
    }),
  });

  if (!response.ok) {
    throw await parseErrorResponse(response);
  }

  return (await response.json()) as OAuthClientInformationFull;
}
