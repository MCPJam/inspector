/**
 * The route's one question to the backend: who is calling, and which version
 * of which mock may they open. `/web/mock/resolve` answers with the version's
 * definition and the real server's id, or refuses by name.
 *
 * Nothing about access is remembered. Every request asks, so a caller removed
 * from the project, or a flag turned off, is refused on the very next call.
 * The definition's bytes are the one thing that could be kept (by version and
 * hash), and the backend's answer is small enough that the route does not.
 */
import { createHash } from "node:crypto";
import {
  validateMockDefinition,
  type MockDefinition,
  type MockRealServer,
  type MockRealServerInfo,
} from "@mcpjam/sdk/mocks";
import { buildConvexAuthHeaders, type ManagerCallerContext } from "../../routes/web/auth.js";
import { logger } from "../../utils/logger.js";
import { MockRefusal, type MockRefusalKind } from "./refusal.js";

const RESOLVE_TIMEOUT_MS = 10_000;

export interface ResolvedMock {
  mockId: string;
  projectId: string;
  name: string;
  version: number;
  headVersion: number;
  contentHash: string;
  definition: MockDefinition;
  /** Null for a mock made from nothing. */
  baseServerId: string | null;
  /**
   * The base's listing pinned when this version was saved, as far as this
   * caller may read it. It serves discovery while forwarding is blocked.
   * Absent when none was captured or it is another member's private capture.
   */
  discovery?: PinnedDiscovery;
  /** Set when the request came in on a test run's URL: the run the backend just verified. */
  run?: { runId: string; epoch: number; expiresAt: number };
}

/** What B1 stores of the base's listing (`discoveryJson`); MCP list entries. */
export interface PinnedDiscovery {
  serverInfo?: MockRealServerInfo["serverInfo"];
  instructions?: string;
  capabilities?: MockRealServerInfo["capabilities"];
  tools?: Awaited<ReturnType<MockRealServer["listTools"]>>;
  prompts?: Array<Record<string, unknown>>;
  resources?: Array<Record<string, unknown>>;
  resourceTemplates?: Array<Record<string, unknown>>;
}

/** The pinned listing in a resolve answer (`discovery.listingJson`, as B1's `getMock` returns it). */
function readPinnedDiscovery(raw: unknown): PinnedDiscovery | undefined {
  const listingJson = (raw as { listingJson?: unknown } | null | undefined)?.listingJson;
  if (typeof listingJson !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(listingJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as PinnedDiscovery)
      : undefined;
  } catch {
    return undefined; // an unreadable pin serves nothing rather than half a listing
  }
}

export function digestOf(...parts: Array<string | number | undefined>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part ?? ""}\0`);
  return hash.digest("hex");
}

/** Who a request belongs to, as a digest that names the caller and carries no credential. */
export function actorDigest(caller: ManagerCallerContext, bearerToken: string): string {
  return digestOf(caller.authMethod, caller.workosUserId, caller.mcpjamOrganizationId, bearerToken);
}

const KIND_BY_BACKEND_CODE: Record<string, MockRefusalKind> = {
  MOCK_SERVERS_FLAG_OFF: "flag_off",
  MOCK_UNAUTHORIZED: "unauthorized",
  MOCK_GRANT_INVALID: "unauthorized",
  MOCK_GRANT_EXPIRED: "grant_expired",
  MOCK_GRANT_CALLER_MISMATCH: "forbidden",
  MOCK_GUEST_REFUSED: "guest",
  MOCK_FORBIDDEN: "forbidden",
  MOCK_NOT_FOUND: "not_found",
  MOCK_VERSION_NOT_FOUND: "not_found",
  MOCK_RUN_NOT_FOUND: "run_not_found",
  MOCK_RUN_FORBIDDEN: "run_forbidden",
  MOCK_RUN_CLOSED: "run_closed",
  MOCK_RUN_EXPIRED: "run_expired",
  MOCK_RUN_STALE_EPOCH: "run_stale_epoch",
};
const KIND_BY_STATUS: Record<number, MockRefusalKind> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  429: "rate_limited",
};

function asResolved(body: unknown): ResolvedMock {
  const b = (body ?? {}) as Record<string, unknown>;
  const validated = validateMockDefinition(b.definition);
  if (
    typeof b.mockId !== "string" ||
    typeof b.projectId !== "string" ||
    typeof b.contentHash !== "string" ||
    !Number.isInteger(b.version) ||
    !validated.ok
  ) {
    // An answer this build cannot read is never served from.
    throw new MockRefusal("invalid_definition");
  }
  const version = b.version as number;
  return {
    mockId: b.mockId,
    projectId: b.projectId,
    name: typeof b.name === "string" ? b.name : "",
    version,
    headVersion: Number.isInteger(b.headVersion) ? (b.headVersion as number) : version,
    contentHash: b.contentHash,
    definition: validated.definition,
    baseServerId: typeof b.baseServerId === "string" ? b.baseServerId : null,
    discovery: readPinnedDiscovery(b.discovery),
    ...readRun(b.run),
  };
}

/** The run a resolve answered for, when it did; a malformed one is as good as none. */
function readRun(raw: unknown): { run?: ResolvedMock["run"] } {
  const run = raw as { runId?: unknown; epoch?: unknown; expiresAt?: unknown } | null | undefined;
  return typeof run?.runId === "string" && Number.isInteger(run.epoch) && typeof run.expiresAt === "number"
    ? { run: { runId: run.runId, epoch: run.epoch as number, expiresAt: run.expiresAt } }
    : {};
}

export interface ResolveInput {
  mockId: string;
  caller: ManagerCallerContext;
  bearerToken: string;
  /** In process only: the grant the dialer holds. Absent over HTTP. */
  grant?: string;
  /** Over HTTP only: the test run the request's URL names. The backend checks it on every request. */
  run?: { runId: string; epoch: number };
}

export async function resolveMock(
  input: ResolveInput,
  deps: { fetch?: typeof fetch } = {},
): Promise<ResolvedMock> {
  const convexUrl = process.env.CONVEX_HTTP_URL;
  if (!convexUrl) {
    logger.warn("[mock-route] CONVEX_HTTP_URL is not set; cannot check a mock");
    throw new MockRefusal("unavailable");
  }
  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(`${convexUrl}/web/mock/resolve`, {
      method: "POST",
      headers: buildConvexAuthHeaders(input.caller, input.bearerToken),
      body: JSON.stringify(
        input.grant
          ? { grant: input.grant }
          : input.run
            ? { runId: input.run.runId, epoch: input.run.epoch, mockId: input.mockId }
            : { mockId: input.mockId },
      ),
      signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    });
  } catch (error) {
    logger.warn("[mock-route] the backend check did not complete", {
      error: error instanceof Error ? error.name : typeof error,
    });
    throw new MockRefusal("unavailable");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined; // not JSON: the status alone decides
  }
  if (!response.ok) {
    const code = (body as { code?: unknown } | undefined)?.code;
    throw new MockRefusal(
      (typeof code === "string" ? KIND_BY_BACKEND_CODE[code] : undefined) ??
        KIND_BY_STATUS[response.status] ??
        "unavailable",
    );
  }
  return asResolved(body);
}
