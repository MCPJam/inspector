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
import { validateMockDefinition, type MockDefinition } from "@mcpjam/sdk/mocks";
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
  MOCK_GUEST_REFUSED: "guest",
  MOCK_FORBIDDEN: "forbidden",
  MOCK_NOT_FOUND: "not_found",
  MOCK_VERSION_NOT_FOUND: "not_found",
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
  };
}

export interface ResolveInput {
  mockId: string;
  caller: ManagerCallerContext;
  bearerToken: string;
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
      body: JSON.stringify({ mockId: input.mockId }),
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
