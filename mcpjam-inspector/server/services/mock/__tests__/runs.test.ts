/**
 * The door for a test run's URL (`?run=<runId>&epoch=<n>`): the backend decides
 * on every request whether the run may be used, the run's own records are the
 * ones served, and a closed, expired, reset or foreign run is refused at once
 * with words that say what happened and what to do. The backend (B6 resolve,
 * B5 records) is stubbed; its rules are its own tests'.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  /** `${scope}|${key}` -> record, for every state context. */
  records: new Map<string, Record<string, unknown>>(),
  /** The run's current epoch, as the backend holds it. */
  epoch: 1,
  full: false,
  writes: [] as Array<{ context: unknown; op: string }>,
}));

vi.mock("../../../routes/web/auth.js", () => ({
  buildConvexAuthHeaders: (_caller: unknown, bearer: string) => ({ Authorization: `Bearer ${bearer}` }),
  createAuthorizedManager: vi.fn(),
}));
// B5, per state context: a run's copy is seeded from the version; a write from an old epoch is refused.
vi.mock("../../../routes/v1/convex-client.js", () => ({
  createConvexClient: () => ({
    mutation: async (_ref: unknown, args: { context: { scope: string; runId?: string; epoch?: number }; opJson: string }) => {
      const op = JSON.parse(args.opJson) as { op: string; key: string; set?: Record<string, unknown> };
      backend.writes.push({ context: args.context, op: op.op });
      if (backend.full) return { ok: false, code: "records_full" };
      if (args.context.scope === "run" && args.context.epoch !== backend.epoch) return { ok: false, code: "stale_epoch" };
      const scope = args.context.scope === "run" ? `run:${args.context.runId}:${args.context.epoch}` : "version";
      const key = `${scope}|${op.key}`;
      const record = backend.records.get(key) ?? { id: op.key, status: "open" };
      const next = op.op === "patch" ? { ...record, ...op.set } : record;
      backend.records.set(key, next);
      return { ok: true, kind: "record", key: op.key, recordJson: JSON.stringify(next) };
    },
  }),
}));

import type { MockDefinition } from "@mcpjam/sdk/mocks";
import { resolveMock, type ResolvedMock } from "../backend.js";
import { serveMock, type MockDoor } from "../route.js";
import { dialMock, resolvedMock } from "./helpers.js";

const door: MockDoor = {
  kind: "http",
  bearerToken: "ann",
  caller: { authMethod: "authkit_jwt", workosUserId: "ann" },
  profile: { timeoutMs: 5_000 },
};
const idSchema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
const definition: MockDefinition = {
  seed: { tickets: { "123": { id: "123", status: "open" } } },
  tools: {
    lookup_ticket: { inputSchema: idSchema, state: { op: "get", collection: "tickets", key: "{{input.id}}" } },
    close_ticket: {
      inputSchema: idSchema,
      state: { op: "patch", collection: "tickets", key: "{{input.id}}", set: { status: "closed" } },
    },
  },
};

/** What `/web/mock/resolve` answers for a run's URL, as B6 describes it. */
const resolveStub = (over: { version?: number; refuse?: { status: number; code: string } } = {}) =>
  vi.fn(async (input: Parameters<typeof resolveMock>[0]): Promise<ResolvedMock> => {
    if (over.refuse) {
      return resolveMock(input, {
        fetch: (async () => Response.json({ code: over.refuse!.code, message: "backend" }, { status: over.refuse!.status })) as typeof fetch,
      });
    }
    return resolvedMock({
      definition,
      version: over.version ?? 7,
      ...(input.run && { run: { runId: input.run.runId, epoch: input.run.epoch, expiresAt: 1_790_000_000_000 } }),
    });
  });

const urlOf = (run?: string) => `https://mock.test/api/web/mock-mcp/mock1${run ?? ""}`;
const serveAt = (url: string, resolve = resolveStub()) =>
  (request: Request) => serveMock(new Request(url, request), "mock1", door, { resolve });

const call = async (url: string, tool: string, args: Record<string, unknown>, resolve = resolveStub()) => {
  const client = await dialMock(serveAt(url, resolve));
  try {
    return (await client.executeTool("mock", tool, args)) as { isError?: boolean; structuredContent?: any; content: Array<{ text: string }> };
  } finally {
    await client.disconnectAllServers();
  }
};

beforeEach(() => {
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex-http.test");
  backend.records.clear();
  backend.writes.length = 0;
  backend.epoch = 1;
  backend.full = false;
});

describe("a run's records are full", () => {
  it("says to delete some or reset the run", async () => {
    backend.full = true;
    const result = await call(urlOf("?run=run-a&epoch=1"), "close_ticket", { id: "123" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(
      "This test run already holds 10,000 records, the most it can. Delete some records, or reset the run to start from the saved seed.",
    );
  });
});

describe("a run's URL", () => {
  it("is resolved by the backend on every request, with the run and epoch it names", async () => {
    const resolve = resolveStub();
    await call(urlOf("?run=run-a&epoch=1"), "lookup_ticket", { id: "123" }, resolve);
    expect(resolve).toHaveBeenCalled();
    for (const [input] of resolve.mock.calls) {
      expect(input).toMatchObject({ mockId: "mock1", run: { runId: "run-a", epoch: 1 } });
    }
  });

  it("serves the run's pinned version and its own records", async () => {
    const resolve = resolveStub({ version: 3 });
    await call(urlOf("?run=run-a&epoch=1"), "close_ticket", { id: "123" }, resolve);
    expect(backend.writes[0]).toMatchObject({ op: "patch", context: { scope: "run", runId: "run-a", epoch: 1 } });
  });

  it("keeps two runs apart, and apart from the shared records", async () => {
    await call(urlOf("?run=run-a&epoch=1"), "close_ticket", { id: "123" });
    const inA = await call(urlOf("?run=run-a&epoch=1"), "lookup_ticket", { id: "123" });
    const inB = await call(urlOf("?run=run-b&epoch=1"), "lookup_ticket", { id: "123" });
    const shared = await call(urlOf(), "lookup_ticket", { id: "123" });
    expect(inA.structuredContent).toEqual({ id: "123", status: "closed" });
    expect(inB.structuredContent).toEqual({ id: "123", status: "open" });
    expect(shared.structuredContent).toEqual({ id: "123", status: "open" });
    expect(backend.writes.filter((w) => (w.context as { scope: string }).scope === "version")).toHaveLength(1);
  });

  it("refuses a write from the epoch before a reset, and reads the new epoch's copy", async () => {
    await call(urlOf("?run=run-a&epoch=1"), "close_ticket", { id: "123" });
    // A reset raised the epoch. A delayed request with the old URL reaches the records store.
    backend.epoch = 2;
    const late = await call(urlOf("?run=run-a&epoch=1"), "close_ticket", { id: "123" });
    expect(late.isError).toBe(true);
    expect(late.content[0]!.text).toContain("reset");
    expect(late.content[0]!.text).toContain("Reconnect");
    const fresh = await call(urlOf("?run=run-a&epoch=2"), "lookup_ticket", { id: "123" });
    expect(fresh.structuredContent).toEqual({ id: "123", status: "open" });
  });
});

describe("a run that cannot be used is refused at once, before anything is served", () => {
  const refuse = async (code: string, status: number, run = "?run=run-a&epoch=1") => {
    const resolve = resolveStub({ refuse: { code, status } });
    const response = await serveAt(urlOf(run), resolve)(
      new Request(urlOf(run), {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    return { response, body: (await response.json()) as { error: { message: string; data: { mockCode: string } } } };
  };

  it.each([
    ["MOCK_RUN_CLOSED", 410, "mock_run_closed", "was closed", "Open a new run"],
    ["MOCK_RUN_EXPIRED", 410, "mock_run_expired", "expired", "Open a new run"],
    ["MOCK_RUN_NOT_FOUND", 404, "mock_run_not_found", "not found", "open a new run"],
    ["MOCK_RUN_FORBIDDEN", 403, "mock_run_forbidden", "someone else", "Open your own run"],
    ["MOCK_RUN_STALE_EPOCH", 409, "mock_run_reset", "was reset", "current URL"],
  ])("%s", async (code, status, mockCode, said, todo) => {
    const { response, body } = await refuse(code, status);
    expect(response.status).toBe(status);
    expect(body.error.data.mockCode).toBe(mockCode);
    expect(body.error.message).toContain(said);
    expect(body.error.message).toContain(todo);
    expect(backend.writes).toEqual([]);
  });

  it("names the missing half of a URL that has a run without an epoch, and never asks the backend", async () => {
    const resolve = resolveStub();
    for (const run of ["?run=run-a", "?epoch=1", "?run=run-a&epoch=abc", "?run=run-a&epoch=0"]) {
      const response = await serveAt(urlOf(run), resolve)(new Request(urlOf(run), { method: "POST", body: "{}" }));
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: { data: { mockCode: string } } }).error.data.mockCode).toBe("mock_run_url_invalid");
    }
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not take a run from an in-process caller's URL", async () => {
    const resolve = resolveStub();
    const inProcess: MockDoor = { kind: "in-process", grant: "g", bearerToken: "ann", caller: door.caller, projectId: "proj1", profile: door.profile };
    await serveMock(new Request(urlOf("?run=run-a&epoch=1"), { method: "POST", body: "{}" }), "mock1", inProcess, { resolve });
    expect(resolve.mock.calls[0]![0]).not.toHaveProperty("run");
  });
});

describe("the backend resolve call", () => {
  it("sends the run, its epoch and the path's mock, and nothing else, for a run URL", async () => {
    const fetch = vi.fn(async () => Response.json({ code: "MOCK_RUN_CLOSED" }, { status: 410 }));
    await expect(
      resolveMock(
        { mockId: "mock1", caller: door.caller, bearerToken: "ann", run: { runId: "run-a", epoch: 2 } },
        { fetch: fetch as unknown as typeof globalThis.fetch },
      ),
    ).rejects.toMatchObject({ kind: "run_closed" });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ runId: "run-a", epoch: 2, mockId: "mock1" });
  });
});
