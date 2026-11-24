/**
 * The mock route's handler, for both doors.
 *
 * Over HTTP the bearer is the caller's own MCPJam API key or OAuth token. It
 * proves who they are to the backend and opens the real server, and it is
 * never a grant. In process, a dialer passes the grant it holds together with
 * the auth context it just authorized with, and the grant is honored only with
 * that context (`registry.ts`). Either way the backend decides whether this
 * caller may open this mock, and the version served is the backend's answer.
 *
 * A mock is built for one caller and one request: `buildMock` gets that
 * caller's own connection to the real server, so nothing of one caller's
 * credentials reaches another.
 */
import { buildMock, type MockObservedEvent, type MockRealServer } from "@mcpjam/sdk/mocks";
import type { ManagerCallerContext } from "../../routes/web/auth.js";
import { logger } from "../../utils/logger.js";
import { actorDigest, resolveMock, type ResolvedMock } from "./backend.js";
import { leaseRealServer, type MockLease, type OpenReal } from "./connection.js";
import { MockRefusal, mockRefusalResponse } from "./refusal.js";
import { recordUnmatchedCalls } from "./unmatched.js";
import type { MockDialProfile, MockDoorContext } from "./registry.js";

export const MOCK_VERSION_HEADER = "x-mcpjam-mock-version";
export const MOCK_LISTING_HASH_HEADER = "x-mcpjam-mock-real-listing-hash";
/**
 * Which calls of this response the mock answered itself, as `tool=source`
 * pairs (tool names URL-encoded). It is the trace's mark, out of band: nothing
 * in the result a model reads says so. Only a response that is complete when
 * its headers go out can carry it; a streamed one is marked on the RPC log.
 */
export const MOCK_ANSWERED_HEADER = "x-mcpjam-mock-answered";
export const DEFAULT_MOCK_PROFILE: MockDialProfile = { timeoutMs: 30_000 };

/** Who is calling and how they proved it, whichever door they came through. */
export type MockDoor =
  | { kind: "http"; bearerToken: string; caller: ManagerCallerContext; profile: MockDialProfile }
  | ({ kind: "in-process" } & MockDoorContext);

export interface MockRouteDeps {
  open?: OpenReal;
  resolve?: typeof resolveMock;
  recordUnmatched?: typeof recordUnmatchedCalls;
}

/**
 * Only who the caller is, never the request they came in on: the dialer's own
 * request log context must not be rewritten with the real server's details.
 */
function identityOf({ authMethod, workosUserId, mcpjamOrganizationId }: ManagerCallerContext) {
  return {
    ...(authMethod && { authMethod }),
    ...(workosUserId && { workosUserId }),
    ...(mcpjamOrganizationId && { mcpjamOrganizationId }),
  };
}

/**
 * A fixed phrase for why the real server could not be opened. The error's own
 * text can carry the server's name or address, and the mock names neither.
 */
function realUnreachable(error: unknown): MockRealServer {
  const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
  const cause = [status, code].some((n) => n === 401 || n === 403)
    ? "the real server did not accept your sign-in"
    : "the real server could not be opened";
  const fail = async (): Promise<never> => {
    throw new Error(cause);
  };
  return { describe: fail, listTools: fail, callTool: fail, request: fail, onListChanged: () => () => {} };
}

/** The response with these headers added, holding the lease until its body is read or dropped. */
function finish(response: Response, added: Record<string, string>, release?: () => Promise<void>) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(added)) headers.set(name, value);
  const init = { status: response.status, statusText: response.statusText, headers };
  // `release` never rejects: it logs its own failure.
  const settle = () => void release?.();
  if (!response.body) {
    settle();
    return new Response(null, init);
  }
  const reader = response.body.getReader();
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            settle();
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          settle();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          settle();
        }
      },
    }),
    init,
  );
}

export async function serveMock(
  request: Request,
  mockId: string,
  door: MockDoor,
  deps: MockRouteDeps = {},
): Promise<Response> {
  const { bearerToken } = door;
  const caller = identityOf(door.caller);
  let resolved: ResolvedMock;
  try {
    resolved = await (deps.resolve ?? resolveMock)({
      mockId,
      caller,
      bearerToken,
      ...(door.kind === "in-process" && { grant: door.grant }),
    });
    // A grant minted for one project opens nothing in another, whatever the
    // dialer's own context says.
    if (door.kind === "in-process" && door.projectId !== resolved.projectId) {
      throw new MockRefusal("forbidden");
    }
  } catch (error) {
    if (error instanceof MockRefusal) return mockRefusalResponse(error.kind);
    logger.error("[mock-route] resolving a mock failed", error, { mockId });
    return mockRefusalResponse("unavailable");
  }

  let lease: MockLease | undefined;
  let real: MockRealServer | undefined;
  if (resolved.baseServerId) {
    try {
      lease = await leaseRealServer({
        resolved,
        caller,
        bearerToken,
        profile: door.profile,
        signal: request.signal,
        open: deps.open,
      });
      real = lease.real;
    } catch (error) {
      logger.warn("[mock-route] could not open the real server of a mock", {
        mockId,
        error: error instanceof Error ? error.name : typeof error,
      });
      real = realUnreachable(error);
    }
  }
  const observed: MockObservedEvent[] = [];
  try {
    const response = await buildMock(resolved.definition, real, {
      observer: (event) => observed.push(event),
    }).fetch(request, {
      // Names the caller by a digest; carries no credential.
      authInfo: {
        token: "",
        clientId: actorDigest(caller, bearerToken).slice(0, 16),
        scopes: [],
        extra: { mockId, version: resolved.version },
      },
    });
    const hash = lease?.real.listingHash();
    const answered = observed.filter((e) => e.type === "answered");
    const marks = answered.map((e) => `${encodeURIComponent(e.tool)}=${e.source}`);
    // Whatever the response held back is reported once its body is done.
    const settle = async () => {
      const unmatched = observed.flatMap((e) =>
        e.type === "unmatched" ? [{ mockId, version: resolved.version, tool: e.tool, arguments: e.arguments }] : [],
      );
      if (unmatched.length > 0) {
        await (deps.recordUnmatched ?? recordUnmatchedCalls)({ caller: door.caller, bearerToken, calls: unmatched });
      }
      await lease?.release();
    };
    return finish(
      response,
      {
        [MOCK_VERSION_HEADER]: String(resolved.version),
        ...(hash && { [MOCK_LISTING_HASH_HEADER]: hash }),
        ...(marks.length > 0 && { [MOCK_ANSWERED_HEADER]: marks.join(",") }),
      },
      settle,
    );
  } catch (error) {
    await lease?.discard();
    if (request.signal.aborted) throw error;
    logger.error("[mock-route] a mock failed while serving", error, { mockId });
    return mockRefusalResponse("unavailable");
  }
}

/** The handler the registry holds for MCPJam's own dialers. */
export function inProcessMockHandler(deps: MockRouteDeps = {}) {
  return (mockId: string, request: Request, door: MockDoorContext) =>
    serveMock(request, mockId, { kind: "in-process", ...door }, deps);
}
