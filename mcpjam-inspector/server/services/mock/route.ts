/**
 * The mock route's handler, for both doors.
 *
 * Over HTTP the bearer is the caller's own MCPJam API key or OAuth token. It
 * proves who they are to the backend and opens the real server, and it is
 * never a grant. In process, a dialer passes the grant it holds together with
 * the auth context it just authorized with, and the grant is honored only with
 * that context (`registry.ts`). Either way the backend decides on every
 * request whether this caller may open this mock, and the version served is
 * the backend's answer; nothing about the answer is kept for the next request.
 *
 * A mock is built for one caller and one request, with the SDK runtime and
 * that caller's own connection to the real server (`forwarding.ts`), so
 * nothing of one caller's credentials reaches another.
 */
import {
  buildMock,
  NO_REAL_SERVER,
  type MockCallEvent,
  type MockRealServer,
  type MockRecordStore,
  type MockStateContext,
  type MockTaskStore,
} from "@mcpjam/sdk/mocks";
import type { ManagerCallerContext } from "../../routes/web/auth.js";
import { logger } from "../../utils/logger.js";
import type { MockCallMark } from "../../../shared/mock-answer-span.js";
import { MOCK_CALLS_HEADER, formatMockCalls } from "./answer-marks.js";
import { actorDigest, resolveMock, type ResolvedMock } from "./backend.js";
import { openAuthorizedReal, type OpenReal } from "./connection.js";
import { acquireSharedBus, createEventBus, sharedBusKey, withFeed } from "./event-bus.js";
import { reportMockOutcome } from "./call-outcomes.js";
import { checkForwardWithBackend, type ForwardVerdict } from "./forward-policy.js";
import { takeMockForward } from "./forward-fan-out.js";
import { forwardingRealServer, type ForwardingReal } from "./forwarding.js";
import { IN_APP_REFUSAL_MESSAGES, MockRefusal, mockRefusalResponse } from "./refusal.js";
import type { MockDialProfile, MockDoorContext } from "./registry.js";
import { backendRecordStore } from "./record-store.js";
import { readRequestFacts, runOfUrl } from "./request-facts.js";
import { backendTaskStore } from "./task-store.js";

export const MOCK_VERSION_HEADER = "x-mcpjam-mock-version";
export const DEFAULT_MOCK_PROFILE: MockDialProfile = { timeoutMs: 30_000 };

/** Who is calling and how they proved it, whichever door they came through. */
export type MockDoor =
  | {
      kind: "http";
      bearerToken: string;
      caller: ManagerCallerContext;
      profile: MockDialProfile;
      /** A bearer the backend's functions accept for this caller, when the request's own is not one (an API key). */
      convexBearer?: () => Promise<string>;
    }
  | ({ kind: "in-process" } & MockDoorContext);

export interface MockRouteDeps {
  resolve?: typeof resolveMock;
  open?: OpenReal;
  /** Where tasks live (default: the backend's, through the caller's own bearer). */
  taskStore?: (input: { mockId: string; door: MockDoor }) => MockTaskStore;
  /** Where records live (default: the backend's, through the caller's own bearer). */
  recordStore?: (input: { mockId: string; version: number; door: MockDoor }) => MockRecordStore;
  /** The forwarding policy and access check (default: the backend's). */
  check?: (input: {
    resolved: ResolvedMock;
    door: MockDoor;
    signal?: AbortSignal;
  }) => Promise<ForwardVerdict>;
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

/** The response with these headers added, holding the connection until its body is read or dropped. */
function finish(response: Response, added: Record<string, string>, release: () => Promise<void>) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(added)) headers.set(name, value);
  const init = { status: response.status, statusText: response.statusText, headers };
  // `release` never rejects: it logs its own failure.
  const settle = () => void release();
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

/** The bearer the backend's functions take for this caller. */
const convexBearerOf = (door: MockDoor) => async () =>
  door.kind === "http" && door.convexBearer ? door.convexBearer() : door.bearerToken;

const taskStoreFor = ({ mockId, door }: { mockId: string; door: MockDoor }) =>
  backendTaskStore(convexBearerOf(door), mockId);

const recordStoreFor = ({ mockId, version, door }: { mockId: string; version: number; door: MockDoor }) =>
  backendRecordStore(convexBearerOf(door), mockId, version);

export async function serveMock(
  request: Request,
  mockId: string,
  door: MockDoor,
  deps: MockRouteDeps = {},
): Promise<Response> {
  const { bearerToken } = door;
  const caller = identityOf(door.caller);
  const grant = door.kind === "in-process" ? door.grant : undefined;
  let resolved: ResolvedMock;
  try {
    // A test run's URL (external clients only) names the run to serve; the
    // backend checks it, and its owner and epoch, on this and every request.
    const run = door.kind === "http" ? runOfUrl(request.url) : undefined;
    if (run === "incomplete") throw new MockRefusal("run_url_invalid");
    resolved = await (deps.resolve ?? resolveMock)({ mockId, caller, bearerToken, grant, ...(run && { run }) });
    // A grant minted for one project opens nothing in another, whatever the
    // dialer's own context says.
    if (door.kind === "in-process" && door.projectId !== resolved.projectId) {
      throw new MockRefusal("forbidden");
    }
  } catch (error) {
    if (error instanceof MockRefusal) {
      const message = door.kind === "in-process" ? IN_APP_REFUSAL_MESSAGES[error.kind] : undefined;
      return mockRefusalResponse(error.kind, { authMethod: caller.authMethod, ...(message ? { message } : {}) });
    }
    logger.error("[mock-route] resolving a mock failed", error, { mockId });
    return mockRefusalResponse("unavailable");
  }

  const check = (signal?: AbortSignal) =>
    deps.check
      ? deps.check({ resolved, door, signal })
      : checkForwardWithBackend({
          mockId,
          version: resolved.version,
          caller,
          bearerToken,
          grant,
          signal,
        });
  const facts = await readRequestFacts(request);
  // An ordinary connection works on the version's shared records; a run's URL on the run's own copy.
  const context: MockStateContext = resolved.run
    ? { scope: "run", runId: resolved.run.runId, epoch: resolved.run.epoch }
    : { scope: "version" };
  let forwarding: ForwardingReal | undefined;
  let real: MockRealServer = NO_REAL_SERVER;
  if (resolved.baseServerId) {
    forwarding = forwardingRealServer({
      resolved: { ...resolved, baseServerId: resolved.baseServerId },
      caller,
      bearerToken,
      profile: door.profile,
      signal: request.signal,
      open: deps.open ?? openAuthorizedReal,
      check,
      ...(facts.taskCall && { taskCall: facts.taskCall }),
      // Only MCPJam's own dialers fan out this way; the HTTP door has its own limits.
      ...(door.kind === "in-process" && {
        takeForward: () => takeMockForward(caller.workosUserId ?? actorDigest(caller, bearerToken)),
      }),
    });
    real = forwarding.real;
  }
  // One bus per caller and mock version, so a stream on one request hears a
  // change a saved case raised on another; a stream also hears, privately, what
  // the real server sends while it is open.
  const onBusError = (error: unknown) =>
    logger.warn("[mock-route] a change listener failed", {
      error: error instanceof Error ? error.name : typeof error,
    });
  const sharedBus = acquireSharedBus(
    sharedBusKey({ caller, bearerToken, mockId, version: resolved.version, run: resolved.run }),
    onBusError,
  );
  const feedBus = facts.listen && forwarding ? createEventBus(onBusError) : undefined;
  const stopFeed = feedBus && forwarding && facts.listen
    ? await forwarding.feedChanges(facts.listen, feedBus.publish)
    : undefined;
  const release = async () => {
    await stopFeed?.();
    sharedBus.release();
    await forwarding?.close();
  };
  const marks: MockCallMark[] = [];
  const observer = (event: MockCallEvent) => {
    if (event.cause !== undefined) {
      logger.warn("[mock-route] a forward was refused: the policy could not be read", {
        mockId,
        error: event.cause instanceof Error ? event.cause.name : typeof event.cause,
      });
    }
    const mark: MockCallMark = {
      mockId,
      version: resolved.version,
      tool: event.tool,
      source: event.source,
      ...(event.realTool && resolved.baseServerId
        ? { realServerId: resolved.baseServerId, realTool: event.realTool }
        : {}),
      ...(event.caseIndex !== undefined ? { caseIndex: event.caseIndex } : {}),
      ...(event.catchAll ? { catchAll: true } : {}),
      ...(event.refusal ? { refusal: event.refusal } : {}),
    };
    marks.push(mark);
    // Both doors report; the HTTP door's answer may have streamed before this ran.
    reportMockOutcome(actorDigest(caller, bearerToken), { caller, bearerToken }, mark);
    // In process the mark goes straight to the running call, so an answer that
    // streams is marked too; its headers were sent before the call settled.
    if (door.kind === "in-process") door.onCall?.(mark);
  };
  try {
    const response = await buildMock(resolved.definition, real, {
      observer,
      bus: feedBus ? withFeed(sharedBus.bus, feedBus) : sharedBus.bus,
      records: {
        store: (deps.recordStore ?? recordStoreFor)({ mockId, version: resolved.version, door }),
        context,
      },
      tasks: {
        store: (deps.taskStore ?? taskStoreFor)({ mockId, door }),
        owner: caller.workosUserId ?? actorDigest(caller, bearerToken),
        onError: (error) =>
          logger.warn("[mock-route] a mock task could not be stored", {
            mockId,
            error: error instanceof Error ? error.name : typeof error,
          }),
      },
    }).fetch(request, {
      // Names the caller by a digest; carries no credential.
      authInfo: {
        token: "",
        clientId: actorDigest(caller, bearerToken).slice(0, 16),
        scopes: [],
        extra: { mockId, version: resolved.version },
      },
    });
    return finish(
      response,
      {
        [MOCK_VERSION_HEADER]: String(resolved.version),
        ...(door.kind === "http" && marks.length > 0 && { [MOCK_CALLS_HEADER]: formatMockCalls(marks) }),
      },
      release,
    );
  } catch (error) {
    await release();
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
