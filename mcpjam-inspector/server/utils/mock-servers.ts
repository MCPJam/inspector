/**
 * Dials a mock server. Authorize answers for a mock's id with the placeholder
 * address, a grant in the credential slot and a `mock` marker. A dialer that
 * sees the marker (never the address) gets a config whose `baseFetch` calls
 * the mock route in this process, handing it the grant and the auth context
 * the dialer authorized with. Nothing is dialed over a network.
 *
 * `credentialSource: "mcpjam-backend"` keeps the connection out of stored
 * replay configs, and every grant is registered with the delivered-secret
 * scrubber, so no trace or error body carries one. A grant lasts an hour and
 * has no refresh token: it is minted again by authorizing again, before it
 * expires and on any 401.
 */
import type { HttpServerConfig } from "@mcpjam/sdk";
import { registerDeliveredSecret } from "../../shared/delivered-secret-registry.js";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";
import type { ManagerCallerContext } from "../routes/web/auth.js";
import { observeMockAnswered } from "../services/mock/answer-marks.js";
import { mockRefusalResponse, type MockRefusalKind } from "../services/mock/refusal.js";
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

/** The version a run used of one mock, as the backend records it on the run. */
export interface MockPin {
  serverId: string;
  version: number;
  contentHash: string;
}

/** The pins on a run's replay metadata; anything that is not a well-formed pin is left out. */
export function readMockPins(raw: unknown): MockPin[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((pin: unknown) => {
    const p = (pin ?? {}) as Record<string, unknown>;
    return typeof p.serverId === "string" &&
      typeof p.version === "number" &&
      Number.isInteger(p.version) &&
      p.version >= 1 &&
      typeof p.contentHash === "string"
      ? [{ serverId: p.serverId, version: p.version, contentHash: p.contentHash }]
      : [];
  });
}

/** `authorize`'s `mockVersions`: the version to open for each pinned mock, by its id. */
export function mockVersionsOf(pins: readonly MockPin[]): Record<string, number> | undefined {
  return pins.length ? Object.fromEntries(pins.map((p) => [p.serverId, p.version])) : undefined;
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
  /** The eval run this connection serves, read on every call; absent outside an eval run. */
  runKey?: () => string | undefined;
  /** Authorizes this mock again, with the same pin, for a fresh grant. */
  reauthorize(): Promise<MockAuthorized>;
}

/** A new grant is fetched this long before the old one expires. */
const RENEW_BEFORE_MS = 30_000;

const REFUSAL_BY_STATUS: Record<number, MockRefusalKind> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  429: "rate_limited",
};

function refusalFor(error: unknown): Response {
  const status = error instanceof WebRouteError ? error.status : 0;
  return mockRefusalResponse(REFUSAL_BY_STATUS[status] ?? "unavailable");
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
 * `config` (what the dialer built for any HTTP server) with the mock's
 * dispatch laid over it: the pins, timeout and capabilities it carries stay.
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

  const dispatch: typeof fetch = async (input, init) => {
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
      return refusalFor(error);
    }
    return handler(first.mock.mockId, new Request(input, init), {
      grant: token,
      bearerToken: dial.bearerToken,
      caller: dial.caller,
      projectId: dial.projectId,
      ...(dial.runKey?.() ? { runKey: dial.runKey() } : {}),
      profile: { ...profile, ...(dial.xaaIssuer ? { xaaIssuer: dial.xaaIssuer } : {}) },
    });
  };

  // The route's mark that it answered a call itself goes to the running tool call.
  const baseFetch = observeMockAnswered(dispatch);
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
