/**
 * The mock route's handler.
 *
 * The bearer is the caller's own MCPJam API key or OAuth token. It proves who
 * they are to the backend and is never a credential for anything else. The
 * backend decides on every request whether this caller may open this mock, and
 * the version served is the backend's answer; nothing about the answer is
 * kept for the next request.
 *
 * A mock is built for one caller and one request, with the SDK runtime, so
 * nothing of one caller's access reaches another.
 */
import { buildMock, NO_REAL_SERVER, type MockRealServer } from "@mcpjam/sdk/mocks";
import type { ManagerCallerContext } from "../../routes/web/auth.js";
import { logger } from "../../utils/logger.js";
import { actorDigest, resolveMock, type ResolvedMock } from "./backend.js";
import { MockRefusal, mockRefusalResponse } from "./refusal.js";

export const MOCK_VERSION_HEADER = "x-mcpjam-mock-version";

/** Who is calling and how they proved it. */
export interface MockDoor {
  bearerToken: string;
  caller: ManagerCallerContext;
}

export interface MockRouteDeps {
  resolve?: typeof resolveMock;
  /** The caller's connection to the mock's real server (default: none, so only saved answers serve). */
  realFor?: (resolved: ResolvedMock, door: MockDoor, signal: AbortSignal) => Promise<MockRealServer>;
}

/**
 * Only who the caller is, never the request they came in on: the caller's own
 * request log context must not be rewritten with the mock's details.
 */
function identityOf({ authMethod, workosUserId, mcpjamOrganizationId }: ManagerCallerContext) {
  return {
    ...(authMethod && { authMethod }),
    ...(workosUserId && { workosUserId }),
    ...(mcpjamOrganizationId && { mcpjamOrganizationId }),
  };
}

export async function serveMock(
  request: Request,
  mockId: string,
  door: MockDoor,
  deps: MockRouteDeps = {},
): Promise<Response> {
  const caller = identityOf(door.caller);
  let resolved: ResolvedMock;
  try {
    resolved = await (deps.resolve ?? resolveMock)({ mockId, caller, bearerToken: door.bearerToken });
  } catch (error) {
    if (error instanceof MockRefusal) return mockRefusalResponse(error.kind, { authMethod: caller.authMethod });
    logger.error("[mock-route] resolving a mock failed", error, { mockId });
    return mockRefusalResponse("unavailable");
  }
  try {
    const real = (await deps.realFor?.(resolved, door, request.signal)) ?? NO_REAL_SERVER;
    const response = await buildMock(resolved.definition, real).fetch(request, {
      // Names the caller by a digest; carries no credential.
      authInfo: {
        token: "",
        clientId: actorDigest(caller, door.bearerToken).slice(0, 16),
        scopes: [],
        extra: { mockId, version: resolved.version },
      },
    });
    const headers = new Headers(response.headers);
    headers.set(MOCK_VERSION_HEADER, String(resolved.version));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    if (request.signal.aborted) throw error;
    logger.error("[mock-route] a mock failed while serving", error, { mockId });
    return mockRefusalResponse("unavailable");
  }
}
