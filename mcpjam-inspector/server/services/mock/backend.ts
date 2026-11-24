/**
 * The route's one question to the backend: who is calling, and which version
 * of which mock may they open. `/web/mock/resolve` answers with the version's
 * definition and the real server's id, or refuses by name.
 *
 * An answer is cached for 60 seconds as the answer and its expiry, never as a
 * credential: the key is a digest, and an answer for a grant never outlives
 * the grant. A refusal is remembered for 30 seconds, so a caller that keeps
 * sending what the backend refused costs one call, not one a request.
 */
import { createHash } from "node:crypto";
import { validateMockDefinition, type MockDefinition } from "@mcpjam/sdk/mocks";
import { buildConvexAuthHeaders, type ManagerCallerContext } from "../../routes/web/auth.js";
import { logger } from "../../utils/logger.js";
import { grantExpiryMs } from "./grant-claims.js";
import { AnswerCache, MOCK_REFUSED_BEARER_MS } from "./limits.js";
import { MockRefusal, type MockRefusalKind } from "./refusal.js";

const MOCK_ANSWER_TTL_MS = 60_000;
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
}

const answers = new AnswerCache<ResolvedMock>(MOCK_ANSWER_TTL_MS);
const refusals = new AnswerCache<MockRefusalKind>(MOCK_REFUSED_BEARER_MS);

export function digestOf(...parts: Array<string | number | undefined>): string {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(`${part ?? ""}\0`);
  return hash.digest("hex");
}

/** Who a connection belongs to, as a digest the pool and caches can key on. */
export function actorDigest(caller: ManagerCallerContext, bearerToken: string): string {
  return digestOf(caller.authMethod, caller.workosUserId, caller.mcpjamOrganizationId, bearerToken);
}

const KIND_BY_BACKEND_CODE: Record<string, MockRefusalKind> = {
  MOCK_UNAUTHORIZED: "unauthorized",
  MOCK_GRANT_INVALID: "unauthorized",
  MOCK_GRANT_EXPIRED: "grant_expired",
  MOCK_GUEST_REFUSED: "guest",
  MOCK_FORBIDDEN: "forbidden",
  MOCK_GRANT_CALLER_MISMATCH: "forbidden",
  MOCK_NOT_FOUND: "not_found",
  MOCK_VERSION_NOT_FOUND: "not_found",
  // The operator switch. Not in REMEMBERED: the pause is about every caller and
  // is short, so it is never held past the call. A pause still reaches a caller
  // only after the 60 s answer cache above lets go of its last good answer,
  // which is accepted: no extra cache or poll for it.
  MOCK_SERVING_PAUSED: "paused",
};
const KIND_BY_STATUS: Record<number, MockRefusalKind> = {
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  429: "rate_limited",
};
/** Only a verdict about this caller is worth remembering. */
const REMEMBERED: ReadonlySet<MockRefusalKind> = new Set(["unauthorized", "guest", "forbidden", "not_found"]);

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
  };
}

export interface ResolveInput {
  mockId: string;
  caller: ManagerCallerContext;
  bearerToken: string;
  /** In process only: the grant the dialer holds. Absent over HTTP. */
  grant?: string;
}

export async function resolveMock(
  input: ResolveInput,
  deps: { fetch?: typeof fetch } = {},
): Promise<ResolvedMock> {
  const actor = actorDigest(input.caller, input.bearerToken);
  const refusalKey = digestOf(actor, input.mockId);
  const remembered = refusals.get(refusalKey);
  if (remembered) throw new MockRefusal(remembered);
  const answerKey = digestOf(actor, input.mockId, input.grant ? `grant:${digestOf(input.grant)}` : "head");
  const cached = answers.get(answerKey);
  if (cached) return cached;

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
      body: JSON.stringify(input.grant ? { grant: input.grant } : { mockId: input.mockId }),
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
    const kind =
      (typeof code === "string" ? KIND_BY_BACKEND_CODE[code] : undefined) ??
      KIND_BY_STATUS[response.status] ??
      "unavailable";
    if (REMEMBERED.has(kind)) refusals.set(refusalKey, kind);
    throw new MockRefusal(kind);
  }
  const resolved = asResolved(body);
  answers.set(answerKey, resolved, input.grant ? grantExpiryMs(input.grant) : undefined);
  return resolved;
}

/** Test seam. */
export function resetMockBackendCachesForTests(): void {
  answers.clear();
  refusals.clear();
}
