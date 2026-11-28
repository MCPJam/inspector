/**
 * The backend as a mock's dialers see it, for tests that run a real mock
 * route in process: authorize (single and batch) answers a mock row with the
 * placeholder address and a grant, `/web/mock/resolve` answers the current
 * definition, `/web/mock/forward-check` the workspace policy. A request for
 * the placeholder address itself is recorded and refused, so a test proves a
 * path never dialed it by reading `placeholderRequests`.
 */
import { vi } from "vitest";
import type { MockDefinition } from "@mcpjam/sdk/mocks";

export const BACKEND = "https://backend.test";
const realFetch = globalThis.fetch;

export interface MockBackendStub {
  /** Edit it between calls: the next resolve serves the new definition. */
  definition: MockDefinition;
  version: number;
  /** The mock's base row as authorize answers it for the base server's id. */
  base: { transportType: "http"; url: string };
  forwarding: "allow" | "block";
  /** When set, authorize refuses the mock's row with this message (a flag off, a guest). */
  authorizeRefusal?: string;
  /** Every request made to the placeholder host. Must stay empty. */
  placeholderRequests: string[];
  /** Backend calls: path, request headers and parsed body. */
  calls: Array<{ path: string; headers: Record<string, string>; body: Record<string, unknown> }>;
  restore(): void;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const rowEntry = (serverConfig: Record<string, unknown>, oauthAccessToken?: string) => ({
  ok: true,
  role: "owner",
  accessLevel: "project_member",
  permissions: { chatOnly: false },
  serverConfig,
  ...(oauthAccessToken ? { oauthAccessToken } : {}),
});

export function stubMockBackend(options: {
  definition: MockDefinition;
  base: MockBackendStub["base"];
  mockRowId?: string;
  baseRowId?: string;
  /** A mock made from nothing: the resolve answer names no base server. */
  baseless?: boolean;
}): MockBackendStub {
  const mockRowId = options.mockRowId ?? "mock-row";
  const baseRowId = options.baseRowId ?? "base1";
  const stub: MockBackendStub = {
    definition: options.definition,
    version: 1,
    base: options.base,
    forwarding: "allow",
    placeholderRequests: [],
    calls: [],
    restore: () => vi.unstubAllGlobals(),
  };
  const mockConfig = () => ({
    transportType: "http",
    url: "https://mock.mcpjam.invalid/mock1",
    headers: {},
    mock: {
      mockId: "mock1",
      version: stub.version,
      contentHash: "h".repeat(64),
      grantExpiresAt: Date.now() + 3_600_000,
    },
  });
  const serverEntry = (id: string) =>
    id === mockRowId
      ? stub.authorizeRefusal
        ? { ok: false, status: 403, code: "FORBIDDEN", message: stub.authorizeRefusal }
        : rowEntry(mockConfig(), "grant-1")
      : rowEntry(stub.base);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : undefined;
      const url = new URL(String(request?.url ?? input));
      if (url.hostname === "mock.mcpjam.invalid") {
        stub.placeholderRequests.push(url.href);
        throw new TypeError("fetch failed: the placeholder address resolves nowhere");
      }
      if (url.origin !== BACKEND) return realFetch(input, init);
      const headers: Record<string, string> = {};
      new Headers(init?.headers ?? request?.headers).forEach((value, name) => {
        headers[name] = value;
      });
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      stub.calls.push({ path: url.pathname, headers, body });
      switch (url.pathname) {
        case "/web/authorize": {
          const id = String(body.serverId);
          const entry = serverEntry(id);
          return json({ authorized: true, ...entry, serverConfig: entry.serverConfig });
        }
        case "/web/authorize-batch":
        case "/web/authorize-batch-local": {
          const ids = body.serverIds as string[];
          return json({ results: Object.fromEntries(ids.map((id) => [id, serverEntry(id)])) });
        }
        case "/web/mock/resolve":
          return json({
            mockId: "mock1",
            projectId: "proj1",
            name: "Tickets",
            version: stub.version,
            headVersion: stub.version,
            contentHash: "h".repeat(64),
            baseServerId: options.baseless ? null : baseRowId,
            forwarding: { policy: stub.forwarding },
            definition: stub.definition,
          });
        case "/web/mock/forward-check":
          return stub.forwarding === "allow"
            ? json({ allowed: true })
            : json({ allowed: false, reason: "blocked_by_policy" });
        default:
          throw new Error(`Unexpected backend call ${url.pathname}`);
      }
    }),
  );
  return stub;
}
