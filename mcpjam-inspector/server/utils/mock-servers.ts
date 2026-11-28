/**
 * Dials a mock server. A saved mock's row carries a placeholder address that
 * resolves nowhere (the backend refuses that host on any other row).
 *
 * Authorize answers for a mock's id with a `mock` marker and a grant in the
 * credential slot. A dialer that sees the marker (never the address) gets a
 * config whose `baseFetch` calls the mock route in this process, handing it
 * the grant and the auth context the dialer authorized with. Nothing is dialed
 * over a network. Without a marker, the dialer reaches the route's HTTP
 * address with the caller's own bearer, like every client outside MCPJam.
 *
 * `credentialSource: "mcpjam-backend"` keeps the connection out of stored
 * replay configs, and every grant is registered with the delivered-secret
 * scrubber, so no trace or error body carries one. A grant is short-lived and
 * has no refresh token: it is minted again by authorizing again, before it
 * expires and on any 401.
 */
import type { HttpServerConfig, MCPServerConfig } from "@mcpjam/sdk";
import { registerDeliveredSecret } from "../../shared/delivered-secret-registry.js";
import { mockIdFromPlaceholderUrl } from "../../shared/mock-address.js";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";
import type { ManagerCallerContext } from "../routes/web/auth.js";
import { currentMockAnswerSink } from "../services/mock/answer-marks.js";
import { mockServerAddress } from "../services/mock/address.js";
import { IN_APP_REFUSAL_MESSAGES, mockRefusalResponse, type MockRefusalKind } from "../services/mock/refusal.js";
import { getMockInProcessHandler, type MockDialProfile } from "../services/mock/registry.js";
import { logger } from "./logger.js";

/** `serverConfig.mock` on an authorize entry for a mock's id. */
export interface MockAuthorizeEntry {
  mockId: string;
  version: number;
  contentHash: string;
  /** Epoch milliseconds; the grant in `oauthAccessToken` is refused from then on. */
  grantExpiresAt: number;
}

/** What an authorize call answers for a server, as far as a mock's dialer reads it. */
export interface MockAuthorized {
  ok?: boolean;
  status?: number;
  oauthAccessToken?: string | null;
  serverConfig?: { mock?: MockAuthorizeEntry; [field: string]: unknown };
}

/** What a dialer holds that the route needs: who it is and how to authorize again. */
export interface MockDial {
  caller: ManagerCallerContext;
  bearerToken: string;
  projectId: string;
  xaaIssuer?: string;
  /** Authorizes this mock again for a fresh grant. */
  reauthorize(): Promise<MockAuthorized>;
}

/**
 * The transports `dispatchMockInProcess` built. A saved mock's placeholder
 * address may stay on a config only with one of these beside it, so a dialer
 * that reads the address (conformance) can tell a mock it must not dial from a
 * mock it reaches in process. A function is the only proof: nothing a caller
 * sends can put one here.
 */
const mockDispatchers = new WeakMap<object, typeof fetch>();

/** The in-process transport of a mock's config, or `undefined` for every other server. */
export function mockTransportOf(config: object): typeof fetch | undefined {
  const transport = "baseFetch" in config ? config.baseFetch : undefined;
  return typeof transport === "function" ? mockDispatchers.get(transport) : undefined;
}

/**
 * Records that `wrapped` is the mock's transport behind a layer a dialer put
 * over it (the backpressure, observation and deadline wrappers), so
 * `mockTransportOf` still recognizes the config the manager holds. A config
 * with no mock transport is left as it is.
 */
export function carryMockTransport(config: object, wrapped: typeof fetch): typeof fetch {
  const transport = mockTransportOf(config);
  if (transport) mockDispatchers.set(wrapped, transport);
  return wrapped;
}

/**
 * Refuses a mock for a feature that reads the server's address (the authorize
 * URL), which for a mock is a placeholder that resolves nowhere. `refusal`
 * says what the feature does not take and where to run it instead.
 */
export function refuseMockServer(
  authorized: { serverConfig?: { mock?: unknown } },
  refusal: string,
): void {
  if (authorized.serverConfig?.mock) {
    throw new WebRouteError(400, ErrorCode.FEATURE_NOT_SUPPORTED, refusal);
  }
}

/** A new grant is fetched this long before the old one expires. */
const RENEW_BEFORE_MS = 30_000;

const REFUSAL_BY_STATUS: Record<number, MockRefusalKind> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  429: "rate_limited",
};

function refusalFor(error: unknown, authMethod?: string): Response {
  const status = error instanceof WebRouteError ? error.status : 0;
  const kind = REFUSAL_BY_STATUS[status] ?? "unavailable";
  const message = IN_APP_REFUSAL_MESSAGES[kind];
  return mockRefusalResponse(kind, { authMethod, ...(message ? { message } : {}) });
}

function entryOf(authorized: MockAuthorized): { token: string; mock: MockAuthorizeEntry } {
  const mock = authorized.serverConfig?.mock;
  const token = authorized.oauthAccessToken;
  if (authorized.ok === false || !mock || !token) {
    // A refusal keeps its status; an answer with no grant in it is a 401.
    const status = authorized.ok === false ? (authorized.status ?? 502) : 401;
    throw new WebRouteError(
      status,
      status === 403 ? ErrorCode.FORBIDDEN : ErrorCode.UNAUTHORIZED,
      "MCPJam could not renew this mock server's access. Connect again.",
    );
  }
  return { token, mock };
}

/**
 * `config` with the mock's dispatch laid over it: what the dialer built for
 * any HTTP server (pins, timeout, capabilities) stays.
 */
export function dispatchMockInProcess(
  config: HttpServerConfig,
  authorized: MockAuthorized,
  profile: Omit<MockDialProfile, "xaaIssuer">,
  dial: MockDial | undefined,
): HttpServerConfig {
  if (!dial) {
    // Fail closed: without the dialer's context there is nothing to serve it with.
    throw new WebRouteError(
      400,
      ErrorCode.FEATURE_NOT_SUPPORTED,
      "This connection cannot open a mock server yet. Connect from MCPJam, or call the mock's address with your API key.",
    );
  }
  const first = entryOf(authorized);
  const grant = { token: first.token, expiresAt: first.mock.grantExpiresAt };
  registerDeliveredSecret(grant.token, "mock-grant", grant);
  let inflight: Promise<string> | undefined;

  /** One renewal at a time; everyone waiting gets the same new grant. */
  const renew = (force: boolean): Promise<string> => {
    if (!force && grant.expiresAt - Date.now() > RENEW_BEFORE_MS) {
      return Promise.resolve(grant.token);
    }
    inflight ??= (async () => {
      const next = entryOf(await dial.reauthorize());
      grant.token = next.token;
      grant.expiresAt = next.mock.grantExpiresAt;
      registerDeliveredSecret(grant.token, "mock-grant", grant);
      return grant.token;
    })().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };

  const baseFetch: typeof fetch = async (input, init) => {
    const handler = getMockInProcessHandler();
    // Never falls through to the network: the placeholder address resolves nowhere.
    if (!handler) return mockRefusalResponse("unavailable");
    let token: string;
    try {
      token = await renew(false);
    } catch (error) {
      logger.warn("[mock-dial] renewing a mock's grant failed", {
        error: error instanceof Error ? error.name : typeof error,
      });
      return refusalFor(error, dial.caller.authMethod);
    }
    // Reported to whichever tool call is running in this async chain, if any.
    const sink = currentMockAnswerSink();
    return handler(first.mock.mockId, new Request(input, init), {
      grant: token,
      bearerToken: dial.bearerToken,
      caller: dial.caller,
      projectId: dial.projectId,
      ...(sink ? { onCall: (mark) => sink([mark]) } : {}),
      profile: { ...profile, ...(dial.xaaIssuer ? { xaaIssuer: dial.xaaIssuer } : {}) },
    });
  };

  mockDispatchers.set(baseFetch, baseFetch);
  const headers = new Headers(config.requestInit?.headers);
  headers.set("Authorization", `Bearer ${grant.token}`);
  return {
    ...config,
    requestInit: { ...config.requestInit, headers },
    baseFetch,
    credentialSource: "mcpjam-backend",
    // The route speaks Streamable HTTP only.
    preferSSE: false,
    disableSseFallback: true,
    onUnauthorized: async () => ({ accessToken: await renew(true) }),
  };
}

/**
 * `config` pointed at the mock route's HTTP address, carrying `bearerToken`.
 * Anything that is not a mock's placeholder is returned as it is.
 */
export function pointAtMockRoute<T extends MCPServerConfig>(
  config: T,
  bearerToken: string | undefined,
): T {
  const mockId = "url" in config ? mockIdFromPlaceholderUrl(String(config.url)) : undefined;
  if (mockId === undefined) return config;
  const address = mockServerAddress(mockId);
  if (!address) {
    throw new WebRouteError(
      500,
      ErrorCode.INTERNAL_ERROR,
      "This MCPJam deployment has no public address, so it cannot serve mock servers. Set the public URL, or open the mock from the hosted app.",
    );
  }
  const headers: Record<string, string> = {};
  new Headers(config.requestInit?.headers).forEach((value, name) => {
    headers[name] = value;
  });
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
  return {
    ...config,
    url: address,
    requestInit: { ...config.requestInit, headers },
    // The route speaks Streamable HTTP only.
    preferSSE: false,
    disableSseFallback: true,
  };
}

/** The config a dialer uses for an authorized server: the mock's door when it is a mock, else as it was. */
export function dialMockOr(
  config: HttpServerConfig,
  authorized: MockAuthorized,
  profile: Omit<MockDialProfile, "xaaIssuer">,
  dial: MockDial | undefined,
): HttpServerConfig {
  return authorized.serverConfig?.mock
    ? dispatchMockInProcess(config, authorized, profile, dial)
    : pointAtMockRoute(config, dial?.bearerToken);
}
