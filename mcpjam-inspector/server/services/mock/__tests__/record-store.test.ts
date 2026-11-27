/**
 * A mock's records through the host: the engineering spec's ticket example
 * served through the route against a stubbed backend (B5's `mockRecords:execute`),
 * and what a call hears when the backend refuses the run.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const backend = vi.hoisted(() => ({
  calls: [] as Array<Record<string, any>>,
  records: new Map<string, Record<string, unknown>>(),
  failure: undefined as unknown,
  full: false,
}));

vi.mock("../../../routes/web/auth.js", () => ({
  buildConvexAuthHeaders: (_caller: unknown, bearer: string) => ({ Authorization: `Bearer ${bearer}` }),
  createAuthorizedManager: vi.fn(),
}));
// `mockRecords:execute` as B5 describes it: one operation, record bodies as JSON text.
vi.mock("../../../routes/v1/convex-client.js", () => ({
  createConvexClient: () => ({
    mutation: async (_ref: unknown, args: Record<string, any>) => {
      backend.calls.push(args);
      if (backend.failure) throw backend.failure;
      if (backend.full) return { ok: false, code: "records_full" };
      const op = JSON.parse(args.opJson) as { op: string; key: string; set?: Record<string, unknown> };
      const scope = JSON.stringify(args.context);
      const key = `${scope}|${op.key}`;
      const stored = backend.records.get(key) ?? (args.context.scope === "version" ? backend.records.get(`seed|${op.key}`) : undefined);
      if (!stored) return { ok: false, code: "not_found" };
      if (op.op === "patch") {
        const next = { ...stored, ...op.set };
        backend.records.set(key, next);
        return { ok: true, kind: "record", key: op.key, recordJson: JSON.stringify(next) };
      }
      return { ok: true, kind: "record", key: op.key, recordJson: JSON.stringify(stored) };
    },
  }),
}));

import { ConvexError } from "convex/values";
import { MCPClientManager } from "@mcpjam/sdk";
import type { MockDefinition } from "@mcpjam/sdk/mocks";
import { serveMock, type MockDoor } from "../route.js";
import { dialMock, resolvedMock } from "./helpers.js";

const door: MockDoor = {
  kind: "http",
  bearerToken: "ann",
  caller: { authMethod: "authkit_jwt", workosUserId: "ann" },
  profile: { timeoutMs: 5_000 },
};

const idSchema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };

/** The engineering spec's ticket example. */
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

let client: MCPClientManager | undefined;
const call = async (tool: string, args: Record<string, unknown>) =>
  (await client!.executeTool("mock", tool, args)) as {
    isError?: boolean;
    structuredContent?: unknown;
    content: Array<{ text: string }>;
  };

beforeEach(async () => {
  backend.calls.length = 0;
  backend.records.clear();
  backend.records.set("seed|123", { id: "123", status: "open" });
  backend.failure = undefined;
  backend.full = false;
  await client?.disconnectAllServers();
  client = await dialMock((request) =>
    serveMock(request, "mock1", door, { resolve: async () => resolvedMock({ definition, version: 4 }) }),
  );
});

describe("the ticket example through the host", () => {
  it("reads the seed, closes the ticket and reads it closed, on the version's shared records", async () => {
    expect((await call("lookup_ticket", { id: "123" })).structuredContent).toEqual({ id: "123", status: "open" });
    expect((await call("close_ticket", { id: "123" })).structuredContent).toEqual({ id: "123", status: "closed" });
    expect((await call("lookup_ticket", { id: "123" })).structuredContent).toEqual({ id: "123", status: "closed" });

    expect(backend.calls.map((args) => JSON.parse(args.opJson).op)).toEqual(["get", "patch", "get"]);
    expect(backend.calls[0]).toMatchObject({ mockId: "mock1", version: 4, context: { scope: "version" } });
    expect(JSON.parse(backend.calls[1]!.opJson)).toEqual({
      op: "patch",
      collection: "tickets",
      key: "123",
      set: { status: "closed" },
    });
  });

  it("passes a missing key through as the store's not-found, never forwarding", async () => {
    const missing = await call("lookup_ticket", { id: "999" });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain("found no record");
  });

  it("sends a retry's operation key and fingerprint with a write, and none with a read", async () => {
    await client!.executeTool("mock", "close_ticket", { id: "123" }, { metadata: { "mcpjam.com/operationKey": "k1" } });
    await call("lookup_ticket", { id: "123" });
    expect(backend.calls[0]!.write).toMatchObject({ key: "k1" });
    expect(typeof backend.calls[0]!.write.fingerprint).toBe("string");
    expect(backend.calls[1]).not.toHaveProperty("write");
  });
});

describe("when the backend refuses the run", () => {
  const refuse = (code: string) => {
    backend.failure = new ConvexError({ code, message: "backend wording" });
  };

  it.each([
    ["MOCK_RUN_CLOSED", "was closed", "Open a new run"],
    ["MOCK_RUN_EXPIRED", "expired", "Open a new run"],
    ["MOCK_RUN_NOT_FOUND", "no longer exists", "Open a new run"],
    ["MOCK_RUN_FORBIDDEN", "opened by someone else", "Open your own run"],
    ["MOCK_RECORD_TOO_LARGE", "larger than a mock can store", "Store less"],
  ])("%s is a tool error that says what happened and what to do", async (code, said, todo) => {
    refuse(code);
    const result = await call("lookup_ticket", { id: "123" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(said);
    expect(result.content[0]!.text).toContain(todo);
    expect(result.content[0]!.text).not.toContain("backend wording");
  });

  it("a full scope of shared records is a tool error that says to delete some", async () => {
    backend.full = true;
    const result = await call("close_ticket", { id: "123" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(
      "This mock's shared records already hold 10,000 records, the most they can. Delete some records, then call again.",
    );
  });

  it("leaves any other failure as an error of the mock, not a tool answer", async () => {
    backend.failure = new Error("the backend is down");
    await expect(call("lookup_ticket", { id: "123" })).rejects.toThrow();
  });
});
