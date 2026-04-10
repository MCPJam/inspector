import {
  addInfoLog,
  buildResourceMetadataUrl,
  mergeHeadersForAuthServer,
  toLogErrorDetails,
} from "@/lib/oauth/state-machines/shared/helpers";
import { decodeJWTParts, formatJWTTimestamp } from "@/lib/oauth/jwt-decoder";
import {
  NEGATIVE_TEST_MODE_DETAILS,
  type NegativeTestMode,
  XAA_IDP_KID,
} from "@/shared/xaa.js";
import type {
  BaseXAAStateMachineConfig,
  XAADecodedJwt,
  XAAFlowState,
  XAAJWTInspectionIssue,
  XAARequestResult,
  XAAStateMachine,
} from "./types";
import { createInitialXAAFlowState } from "./types";

function canonicalizeResourceUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";

    if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    return parsed.toString();
  } catch {
    return url;
  }
}

function buildAuthServerMetadataUrls(authServerUrl: string): string[] {
  const url = new URL(authServerUrl);
  const urls: string[] = [];

  if (url.pathname === "/" || url.pathname === "") {
    urls.push(
      new URL("/.well-known/oauth-authorization-server", url.origin).toString(),
    );
    urls.push(
      new URL("/.well-known/openid-configuration", url.origin).toString(),
    );
  } else {
    const pathname = url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;

    urls.push(
      new URL(
        `/.well-known/oauth-authorization-server${pathname}`,
        url.origin,
      ).toString(),
    );
    urls.push(
      new URL(
        `/.well-known/openid-configuration${pathname}`,
        url.origin,
      ).toString(),
    );
    urls.push(
      new URL(
        `${pathname}/.well-known/openid-configuration`,
        url.origin,
      ).toString(),
    );
  }

  return urls;
}

function extractErrorMessage(body: any, fallback: string): string {
  if (typeof body === "string" && body.trim()) {
    return body;
  }

  if (!body || typeof body !== "object") {
    return fallback;
  }

  return (
    body.error_description ||
    body.error ||
    body.message ||
    body.statusText ||
    fallback
  );
}

function asRecord(
  value: unknown,
  label: string,
): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} did not return a JSON object`);
  }

  return value as Record<string, any>;
}

function formatClaimValue(value: unknown): string {
  if (typeof value === "number") {
    return `${value} (${formatJWTTimestamp(value)})`;
  }

  if (value === undefined) {
    return "(missing)";
  }

  if (value === null) {
    return "null";
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

function buildIdJagInspection(
  token: string,
  expected: {
    issuer: string;
    audience: string;
    resource: string;
    clientId: string;
    scope?: string;
    negativeTestMode: NegativeTestMode;
  },
): XAADecodedJwt {
  const decoded = decodeJWTParts(token);
  const issues: XAAJWTInspectionIssue[] = [];

  if (!decoded) {
    return {
      header: null,
      payload: null,
      signature: "",
      issues: [
        {
          section: "payload",
          field: "token",
          label: "JWT parsing",
          expected: "A well-formed three-part JWT",
          actual: "The returned assertion could not be decoded.",
        },
      ],
    };
  }

  const header = decoded.header || {};
  const payload = decoded.payload || {};

  const addIssue = (
    section: XAAJWTInspectionIssue["section"],
    field: string,
    label: string,
    expectedValue: unknown,
    actualValue: unknown,
  ) => {
    issues.push({
      section,
      field,
      label,
      expected: formatClaimValue(expectedValue),
      actual: formatClaimValue(actualValue),
    });
  };

  if (header.typ !== "oauth-id-jag+jwt") {
    addIssue(
      "header",
      "typ",
      "JWT type",
      "oauth-id-jag+jwt",
      header.typ,
    );
  }

  if (header.kid !== XAA_IDP_KID) {
    addIssue("header", "kid", "Key identifier", XAA_IDP_KID, header.kid);
  }

  if (payload.iss !== expected.issuer) {
    addIssue("payload", "iss", "Issuer", expected.issuer, payload.iss);
  }

  if (payload.sub !== undefined && String(payload.sub).trim() === "") {
    addIssue("payload", "sub", "Subject", "Non-empty subject", payload.sub);
  }

  if (payload.sub === undefined) {
    addIssue("payload", "sub", "Subject", "Present", payload.sub);
  }

  if (payload.aud !== expected.audience) {
    addIssue(
      "payload",
      "aud",
      "Audience",
      expected.audience,
      payload.aud,
    );
  }

  if (payload.resource !== expected.resource) {
    addIssue(
      "payload",
      "resource",
      "Resource",
      expected.resource,
      payload.resource,
    );
  }

  if (payload.client_id !== expected.clientId) {
    addIssue(
      "payload",
      "client_id",
      "Client ID",
      expected.clientId,
      payload.client_id,
    );
  }

  if (typeof payload.exp !== "number" || payload.exp <= Date.now() / 1000) {
    addIssue(
      "payload",
      "exp",
      "Expiration",
      "A future timestamp",
      payload.exp,
    );
  }

  if (expected.scope && payload.scope !== expected.scope) {
    addIssue("payload", "scope", "Requested scopes", expected.scope, payload.scope);
  }

  if (expected.negativeTestMode === "bad_signature") {
    addIssue(
      "signature",
      "signature",
      "Signature / JWKS",
      "Signed by the published XAA issuer key",
      "Signed with a throwaway private key",
    );
  }

  return {
    header: decoded.header,
    payload: decoded.payload,
    signature: decoded.signature,
    issues,
  };
}

export function createXAAStateMachine(
  config: BaseXAAStateMachineConfig,
): XAAStateMachine {
  const {
    state,
    getState,
    updateState,
    serverUrl,
    issuerBaseUrl,
    requestExecutor,
    negativeTestMode,
    userId,
    email,
    clientId,
    scope,
    authzServerIssuer,
  } = config;

  const machine: XAAStateMachine = {
    state: createInitialXAAFlowState({
      ...state,
      serverUrl: state.serverUrl || serverUrl,
      resourceUrl: state.resourceUrl || canonicalizeResourceUrl(serverUrl),
      negativeTestMode: state.negativeTestMode || negativeTestMode,
      userId: state.userId || userId,
      email: state.email || email,
      clientId: state.clientId || clientId,
      scope: state.scope || scope,
      authzServerIssuer: state.authzServerIssuer || authzServerIssuer,
    }),
    updateState: (updates) => {
      machine.state = { ...machine.state, ...updates };
      updateState(updates);
    },
    proceedToNextStep: async () => {},
    resetFlow: () => {},
  };

  const currentState = (): XAAFlowState => getState?.() ?? machine.state;

  const pushInfo = (
    step: XAAFlowState["currentStep"],
    id: string,
    label: string,
    data: any,
    options?: Parameters<typeof addInfoLog>[5],
  ) => {
    machine.updateState({
      infoLogs: addInfoLog(currentState(), step, id, label, data, options),
    });
  };

  const runRequest = async (
    step: XAAFlowState["currentStep"],
    request: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: any;
    },
    executor: () => Promise<XAARequestResult>,
  ): Promise<XAARequestResult> => {
    machine.updateState({
      currentStep: step,
      isBusy: true,
      error: undefined,
      lastRequest: request,
      lastResponse: undefined,
    });

    const startedAt = Date.now();

    try {
      const result = await executor();
      const response = {
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
        body: result.body,
      };

      machine.updateState({
        isBusy: false,
        lastResponse: response,
        httpHistory: [
          ...(currentState().httpHistory || []),
          {
            step,
            timestamp: startedAt,
            duration: Date.now() - startedAt,
            request,
            response,
          },
        ],
      });

      return result;
    } catch (error) {
      const details = toLogErrorDetails(error);

      machine.updateState({
        isBusy: false,
        error: details.message,
        httpHistory: [
          ...(currentState().httpHistory || []),
          {
            step,
            timestamp: startedAt,
            duration: Date.now() - startedAt,
            request,
            error: details,
          },
        ],
      });

      pushInfo(step, `${step}-error-${startedAt}`, "Request failed", request, {
        level: "error",
        error: details,
      });

      throw error;
    }
  };

  const discoverResourceMetadata = async () => {
    const state = currentState();
    const activeServerUrl = state.serverUrl || serverUrl;
    const resourceMetadataUrl = buildResourceMetadataUrl(activeServerUrl);

    const request = {
      method: "GET",
      url: resourceMetadataUrl,
      headers: {
        Accept: "application/json",
      },
    };

    try {
      const result = await runRequest(
        "discover_resource_metadata",
        request,
        () => requestExecutor.externalRequest(resourceMetadataUrl, request),
      );

      if (!result.ok) {
        throw new Error(
          extractErrorMessage(
            result.body,
            `Resource metadata request failed with ${result.status}`,
          ),
        );
      }

      const resourceMetadata = asRecord(result.body, "Resource metadata");
      const resolvedAuthzIssuer =
        state.authzServerIssuer ||
        (Array.isArray(resourceMetadata.authorization_servers)
          ? resourceMetadata.authorization_servers[0]
          : undefined);
      const resolvedResource =
        typeof resourceMetadata.resource === "string"
          ? resourceMetadata.resource
          : canonicalizeResourceUrl(activeServerUrl);

      if (!resolvedAuthzIssuer) {
        throw new Error(
          "Resource metadata did not include `authorization_servers`, and no Authorization Server issuer was configured manually.",
        );
      }

      machine.updateState({
        currentStep: "received_resource_metadata",
        resourceMetadataUrl,
        resourceMetadata: resourceMetadata as XAAFlowState["resourceMetadata"],
        resourceUrl: resolvedResource,
        authzServerIssuer: resolvedAuthzIssuer,
      });

      pushInfo(
        "received_resource_metadata",
        "xaa-resource-metadata",
        "Resource metadata",
        {
          resource: resolvedResource,
          authorization_servers: resourceMetadata.authorization_servers,
        },
      );
    } catch (error) {
      if (!state.authzServerIssuer) {
        machine.updateState({
          currentStep: "discover_resource_metadata",
          error:
            error instanceof Error
              ? error.message
              : "Failed to discover resource metadata",
        });
        return;
      }

      machine.updateState({
        currentStep: "received_resource_metadata",
        resourceMetadataUrl,
        resourceUrl: canonicalizeResourceUrl(activeServerUrl),
        error: undefined,
      });

      pushInfo(
        "received_resource_metadata",
        "xaa-resource-fallback",
        "Resource metadata fallback",
        {
          message:
            error instanceof Error ? error.message : "Resource metadata lookup failed",
          using_authz_server_issuer: state.authzServerIssuer,
        },
        {
          level: "warning",
        },
      );
    }
  };

  const discoverAuthzMetadata = async () => {
    const state = currentState();
    const issuer = state.authzServerIssuer;

    if (!issuer) {
      machine.updateState({
        currentStep: "discover_authz_metadata",
        error:
          "Authorization Server issuer is missing. Configure it manually or retry resource metadata discovery.",
      });
      return;
    }

    const urls = buildAuthServerMetadataUrls(issuer);
    let lastError = "Authorization server metadata discovery failed.";

    for (const url of urls) {
      const request = {
        method: "GET",
        url,
        headers: mergeHeadersForAuthServer(undefined, {
          Accept: "application/json",
        }),
      };

      try {
        const result = await runRequest(
          "discover_authz_metadata",
          request,
          () => requestExecutor.externalRequest(url, request),
        );

        if (!result.ok) {
          lastError = extractErrorMessage(
            result.body,
            `Auth server metadata request failed with ${result.status}`,
          );
          continue;
        }

        const metadata = asRecord(result.body, "Authorization metadata");
        if (typeof metadata.token_endpoint !== "string") {
          throw new Error(
            "Authorization metadata did not include a token_endpoint.",
          );
        }

        const resolvedIssuer =
          typeof metadata.issuer === "string" ? metadata.issuer : issuer;

        machine.updateState({
          currentStep: "received_authz_metadata",
          authzMetadata: metadata as XAAFlowState["authzMetadata"],
          authzServerIssuer: resolvedIssuer,
          tokenEndpoint: metadata.token_endpoint,
          error: undefined,
        });

        pushInfo(
          "received_authz_metadata",
          "xaa-authz-metadata",
          "Authorization metadata",
          {
            issuer: resolvedIssuer,
            token_endpoint: metadata.token_endpoint,
            grant_types_supported: metadata.grant_types_supported,
          },
        );

        return;
      } catch (error) {
        lastError =
          error instanceof Error ? error.message : "Metadata request failed";
      }
    }

    machine.updateState({
      currentStep: "discover_authz_metadata",
      error: lastError,
    });
  };

  const authenticateUser = async () => {
    const state = currentState();
    const request = {
      method: "POST",
      url: "/authenticate",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        userId: state.userId,
        email: state.email,
        audience: state.clientId || "mcpjam-xaa-debugger",
      },
    };

    try {
      const result = await runRequest("user_authentication", request, () =>
        requestExecutor.internalRequest("/authenticate", {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
        }),
      );

      if (!result.ok) {
        throw new Error(
          extractErrorMessage(
            result.body,
            `Mock authentication failed with ${result.status}`,
          ),
        );
      }

      const body = asRecord(result.body, "Authentication response");
      if (typeof body.id_token !== "string") {
        throw new Error("Authentication response did not include an `id_token`.");
      }

      machine.updateState({
        currentStep: "received_identity_assertion",
        identityAssertion: body.id_token,
        error: undefined,
      });

      pushInfo(
        "received_identity_assertion",
        "xaa-identity-assertion",
        "Identity assertion issued",
        {
          userId: state.userId,
          email: state.email,
        },
      );
    } catch (error) {
      machine.updateState({
        currentStep: "user_authentication",
        error:
          error instanceof Error
            ? error.message
            : "Mock authentication failed",
      });
    }
  };

  const exchangeIdTokenForIdJag = async () => {
    const state = currentState();

    if (!state.identityAssertion) {
      machine.updateState({
        currentStep: "token_exchange_request",
        error: "No identity assertion is available. Complete mock authentication first.",
      });
      return;
    }

    if (!state.authzServerIssuer) {
      machine.updateState({
        currentStep: "token_exchange_request",
        error: "No authorization server issuer is available for the ID-JAG audience.",
      });
      return;
    }

    if (!state.clientId) {
      machine.updateState({
        currentStep: "token_exchange_request",
        error: "Client ID is required for the ID-JAG `client_id` claim.",
      });
      return;
    }

    const request = {
      method: "POST",
      url: "/token-exchange",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        identityAssertion: state.identityAssertion,
        audience: state.authzServerIssuer,
        resource: state.resourceUrl || state.serverUrl,
        clientId: state.clientId,
        scope: state.scope,
        negativeTestMode: state.negativeTestMode,
      },
    };

    try {
      const result = await runRequest("token_exchange_request", request, () =>
        requestExecutor.internalRequest("/token-exchange", {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
        }),
      );

      if (!result.ok) {
        throw new Error(
          extractErrorMessage(
            result.body,
            `Token exchange failed with ${result.status}`,
          ),
        );
      }

      const body = asRecord(result.body, "Token exchange response");
      if (typeof body.id_jag !== "string") {
        throw new Error("Token exchange response did not include an `id_jag`.");
      }

      machine.updateState({
        currentStep: "received_id_jag",
        idJag: body.id_jag,
        idJagDecoded: null,
        error: undefined,
      });

      pushInfo(
        "received_id_jag",
        "xaa-id-jag",
        "ID-JAG issued",
        {
          negativeTestMode: state.negativeTestMode,
          expectedFailure:
            NEGATIVE_TEST_MODE_DETAILS[state.negativeTestMode].expectedFailure,
        },
      );
    } catch (error) {
      machine.updateState({
        currentStep: "token_exchange_request",
        error:
          error instanceof Error ? error.message : "Token exchange failed",
      });
    }
  };

  const inspectIdJag = () => {
    const state = currentState();
    if (!state.idJag || !state.authzServerIssuer || !state.clientId) {
      machine.updateState({
        currentStep: "inspect_id_jag",
        error:
          "A complete ID-JAG, authorization server issuer, and client ID are required before inspection.",
      });
      return;
    }

    const inspection = buildIdJagInspection(state.idJag, {
      issuer: issuerBaseUrl,
      audience: state.authzServerIssuer,
      resource: state.resourceUrl || state.serverUrl || serverUrl,
      clientId: state.clientId,
      scope: state.scope,
      negativeTestMode: state.negativeTestMode,
    });

    machine.updateState({
      currentStep: "inspect_id_jag",
      idJagDecoded: inspection,
      error: undefined,
    });

    pushInfo("inspect_id_jag", "xaa-id-jag-inspection", "ID-JAG inspection", {
      issues: inspection.issues,
      mode: state.negativeTestMode,
    });
  };

  const requestAccessToken = async () => {
    const state = currentState();

    if (!state.idJag || !state.tokenEndpoint) {
      machine.updateState({
        currentStep: "jwt_bearer_request",
        error:
          "The flow is missing an ID-JAG or token endpoint. Finish discovery and token exchange first.",
      });
      return;
    }

    const request = {
      method: "POST",
      url: "/proxy/token",
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        tokenEndpoint: state.tokenEndpoint,
        assertion: state.idJag,
        clientId: state.clientId,
        scope: state.scope,
        resource: state.resourceUrl || state.serverUrl,
      },
    };

    try {
      const result = await runRequest("jwt_bearer_request", request, () =>
        requestExecutor.internalRequest("/proxy/token", {
          method: "POST",
          headers: request.headers,
          body: JSON.stringify(request.body),
        }),
      );

      if (!result.ok) {
        throw new Error(
          extractErrorMessage(
            result.body,
            `JWT bearer proxy failed with ${result.status}`,
          ),
        );
      }

      const proxyBody = asRecord(result.body, "JWT bearer response");
      const upstreamStatus =
        typeof proxyBody.status === "number" ? proxyBody.status : undefined;
      const upstreamPayload = proxyBody.body;

      if (!upstreamStatus || upstreamStatus < 200 || upstreamStatus >= 300) {
        const detail = extractErrorMessage(
          upstreamPayload,
          `Authorization server returned ${proxyBody.status ?? "an unknown status"}.`,
        );
        machine.updateState({
          currentStep: "jwt_bearer_request",
          error: `${detail} Does the authorization server trust the synthetic issuer JWKS and support \`urn:ietf:params:oauth:grant-type:jwt-bearer\`?`,
        });
        pushInfo(
          "jwt_bearer_request",
          "xaa-jwt-bearer-failure",
          "JWT bearer request failed",
          {
            status: proxyBody.status,
            body: upstreamPayload,
          },
          { level: "error" },
        );
        return;
      }

      const tokenResponse = asRecord(upstreamPayload, "JWT bearer token response");
      if (typeof tokenResponse.access_token !== "string") {
        throw new Error(
          "Authorization server response did not include an `access_token`.",
        );
      }

      machine.updateState({
        currentStep: "received_access_token",
        accessToken: tokenResponse.access_token,
        tokenType:
          typeof tokenResponse.token_type === "string"
            ? tokenResponse.token_type
            : "Bearer",
        expiresIn:
          typeof tokenResponse.expires_in === "number"
            ? tokenResponse.expires_in
            : undefined,
        error: undefined,
      });

      pushInfo(
        "received_access_token",
        "xaa-access-token",
        "Access token issued",
        {
          token_type: tokenResponse.token_type,
          expires_in: tokenResponse.expires_in,
        },
      );
    } catch (error) {
      machine.updateState({
        currentStep: "jwt_bearer_request",
        error:
          error instanceof Error ? error.message : "JWT bearer request failed",
      });
    }
  };

  const callAuthenticatedMcp = async () => {
    const state = currentState();

    if (!state.accessToken || !state.serverUrl) {
      machine.updateState({
        currentStep: "authenticated_mcp_request",
        error:
          "An access token and MCP server URL are required before the final authenticated request.",
      });
      return;
    }

    const body = {
      jsonrpc: "2.0",
      id: "mcpjam-xaa-debugger",
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: {
          name: "MCPJam XAA Debugger",
          version: "1.0.0",
        },
      },
    };

    const request = {
      method: "POST",
      url: state.serverUrl,
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Authorization: `Bearer ${state.accessToken}`,
      },
      body,
    };

    try {
      const result = await runRequest(
        "authenticated_mcp_request",
        request,
        () =>
          requestExecutor.externalRequest(state.serverUrl!, {
            method: "POST",
            headers: request.headers,
            body: JSON.stringify(body),
          }),
      );

      if (!result.ok) {
        machine.updateState({
          currentStep: "authenticated_mcp_request",
          error: extractErrorMessage(
            result.body,
            `Authenticated MCP request failed with ${result.status}`,
          ),
        });
        return;
      }

      machine.updateState({
        currentStep: "complete",
        error: undefined,
      });

      pushInfo(
        "complete",
        "xaa-authenticated-mcp",
        "Authenticated MCP response",
        {
          status: result.status,
          body: result.body,
        },
      );
    } catch (error) {
      machine.updateState({
        currentStep: "authenticated_mcp_request",
        error:
          error instanceof Error
            ? error.message
            : "Authenticated MCP request failed",
      });
    }
  };

  machine.proceedToNextStep = async () => {
    const step = currentState().currentStep;

    switch (step) {
      case "idle":
      case "discover_resource_metadata":
        await discoverResourceMetadata();
        return;
      case "received_resource_metadata":
      case "discover_authz_metadata":
        await discoverAuthzMetadata();
        return;
      case "received_authz_metadata":
      case "user_authentication":
        await authenticateUser();
        return;
      case "received_identity_assertion":
      case "token_exchange_request":
        await exchangeIdTokenForIdJag();
        return;
      case "received_id_jag":
      case "inspect_id_jag":
        if (step === "received_id_jag") {
          inspectIdJag();
          return;
        }
        await requestAccessToken();
        return;
      case "jwt_bearer_request":
        await requestAccessToken();
        return;
      case "received_access_token":
      case "authenticated_mcp_request":
        await callAuthenticatedMcp();
        return;
      case "complete":
        return;
      default: {
        const exhaustive: never = step;
        throw new Error(`Unhandled XAA flow step: ${exhaustive}`);
      }
    }
  };

  machine.resetFlow = () => {
    machine.updateState(
      createInitialXAAFlowState({
        serverUrl: currentState().serverUrl || serverUrl,
        resourceUrl: canonicalizeResourceUrl(currentState().serverUrl || serverUrl),
        negativeTestMode:
          currentState().negativeTestMode || negativeTestMode,
        userId: currentState().userId || userId,
        email: currentState().email || email,
        clientId: currentState().clientId || clientId,
        scope: currentState().scope || scope,
        authzServerIssuer:
          currentState().authzServerIssuer || authzServerIssuer,
      }),
    );
  };

  return machine;
}
