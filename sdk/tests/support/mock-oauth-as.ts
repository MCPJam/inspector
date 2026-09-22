/**
 * A configurable in-memory MCP server + authorization server, as an
 * `OAuthRequestExecutor`.
 *
 * The OAuth suites each grew their own inline URL-switch router; this is the
 * shared one, with the knobs the emulation tests need: recording, a scripted
 * registration rejection, a static-credential gate, and auto-consent.
 */
import type {
  OAuthHttpRequest,
  OAuthRequestExecutor,
  OAuthRequestResult,
} from "../../src/oauth/state-machines/types.js";

export interface MockOAuthServerOptions {
  serverUrl: string;
  /** Defaults to a distinct origin, i.e. the PRM-era shape. */
  authServerBase?: string;
  /** Omit to advertise no `registration_endpoint` (DCR unsupported). */
  supportsDcr?: boolean;
  supportsCimd?: boolean;
  scopesSupported?: string[];
  /** `client_secret` issued by DCR, if any. */
  issuedClientSecret?: string;
  tokenEndpointAuthMethodsSupported?: string[];
  /**
   * Reject the Nth registration (1-based) with a structured RFC 7591
   * `invalid_redirect_uri`, or with a custom body for negative tests.
   */
  rejectRegistration?: {
    attempt: number;
    status?: number;
    body?: unknown;
  };
  /** A header name/value the server accepts INSTEAD of OAuth. */
  acceptStaticCredential?: { headerName: string; value: string };
  /** Status for an unauthenticated MCP request. Defaults to 401. */
  unauthenticatedStatus?: number;
  /** 2026-07-28 answers `tools/list`; earlier versions answer `initialize`. */
  stateless?: boolean;
  /**
   * The `protocolVersion` this server negotiates in its `initialize` result.
   * Defaults to `2025-11-25`; set it to emulate a server on another era so a
   * test's server and client are not silently describing different protocols.
   */
  negotiatedProtocolVersion?: string;
  /**
   * Serve a client-ID metadata document at this URL, so a CIMD attempt can
   * actually complete. Only meaningful together with `supportsCimd`.
   */
  clientIdMetadataUrl?: string;
}

export interface MockOAuthServer {
  executor: OAuthRequestExecutor;
  requests: OAuthHttpRequest[];
  registrationBodies: Array<Record<string, unknown>>;
  /** Redirect URIs the AS has registered, newest last. */
  registeredRedirectUris: string[][];
}

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): OAuthRequestResult => ({
  status,
  statusText: status === 200 ? "OK" : status === 401 ? "Unauthorized" : "Error",
  headers: { "content-type": "application/json", ...headers },
  body,
  ok: status >= 200 && status < 300,
});

export function createMockOAuthServer(
  options: MockOAuthServerOptions
): MockOAuthServer {
  const {
    serverUrl,
    authServerBase = "https://auth-server.example.com",
    supportsDcr = true,
    supportsCimd = false,
    scopesSupported = ["as:advertised"],
    issuedClientSecret,
    tokenEndpointAuthMethodsSupported = ["none", "client_secret_basic"],
    rejectRegistration,
    acceptStaticCredential,
    unauthenticatedStatus = 401,
    stateless = false,
    clientIdMetadataUrl,
    negotiatedProtocolVersion = "2025-11-25",
  } = options;

  const serverOrigin = new URL(serverUrl).origin;
  const resourceMetadataUrl = `${serverOrigin}/.well-known/oauth-protected-resource${
    new URL(serverUrl).pathname
  }`;

  const requests: OAuthHttpRequest[] = [];
  const registrationBodies: Array<Record<string, unknown>> = [];
  const registeredRedirectUris: string[][] = [];
  let registrationCount = 0;

  const mcpResult = stateless
    ? { tools: [] }
    : {
        protocolVersion: negotiatedProtocolVersion,
        serverInfo: { name: "mock", version: "1.0.0" },
        capabilities: {},
      };

  const executor: OAuthRequestExecutor = async (request) => {
    requests.push(request);

    if (request.url === serverUrl) {
      const authorization = request.headers.Authorization;
      if (authorization?.startsWith("Bearer ")) {
        return json(200, { jsonrpc: "2.0", id: 1, result: mcpResult });
      }
      if (acceptStaticCredential) {
        const supplied = Object.entries(request.headers).find(
          ([key]) =>
            key.toLowerCase() === acceptStaticCredential.headerName.toLowerCase()
        );
        if (supplied?.[1] === acceptStaticCredential.value) {
          return json(200, { jsonrpc: "2.0", id: 1, result: mcpResult });
        }
      }
      return {
        ...json(unauthenticatedStatus, null),
        headers: {
          "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
        },
      };
    }

    if (request.url === resourceMetadataUrl) {
      return json(200, {
        resource: serverUrl,
        authorization_servers: [authServerBase],
      });
    }

    if (request.url.includes("/.well-known/oauth-authorization-server")) {
      return json(200, {
        issuer: authServerBase,
        authorization_endpoint: `${authServerBase}/authorize`,
        token_endpoint: `${authServerBase}/token`,
        ...(supportsDcr
          ? { registration_endpoint: `${authServerBase}/register` }
          : {}),
        ...(supportsCimd
          ? { client_id_metadata_document_supported: true }
          : {}),
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: scopesSupported,
        token_endpoint_auth_methods_supported:
          tokenEndpointAuthMethodsSupported,
      });
    }

    if (clientIdMetadataUrl && request.url === clientIdMetadataUrl) {
      // The machine requires `client_id` to equal the document's own URL.
      return json(200, {
        client_id: clientIdMetadataUrl,
        client_name: "MCPJam Inspector",
        redirect_uris: ["http://127.0.0.1:41234/callback"],
      });
    }

    if (request.url === `${authServerBase}/register`) {
      // Consistent with the advertised metadata: a server that offers no
      // registration_endpoint must not quietly accept registrations, or a
      // wrongly-attempted DCR would pass unnoticed.
      if (!supportsDcr) {
        return json(404, { error: "not_found" });
      }
      registrationCount += 1;
      const body = (request.body ?? {}) as Record<string, unknown>;
      registrationBodies.push(body);

      if (rejectRegistration && rejectRegistration.attempt === registrationCount) {
        return json(
          rejectRegistration.status ?? 400,
          rejectRegistration.body ?? {
            error: "invalid_redirect_uri",
            error_description: "one or more redirect_uris are not permitted",
          }
        );
      }

      registeredRedirectUris.push(
        Array.isArray(body.redirect_uris) ? (body.redirect_uris as string[]) : []
      );
      return json(200, {
        client_id: `client-${registrationCount}`,
        ...(issuedClientSecret ? { client_secret: issuedClientSecret } : {}),
        token_endpoint_auth_method: issuedClientSecret
          ? "client_secret_basic"
          : "none",
      });
    }

    if (request.url === `${authServerBase}/token`) {
      return json(200, {
        access_token: "emulated-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: "emulated-refresh-token",
      });
    }

    return json(404, null);
  };

  return { executor, requests, registrationBodies, registeredRedirectUris };
}

/** Auto-consenting authorization leg: hands back a fixed code. */
export const autoConsent = async () => ({ code: "mock-authorization-code" });
