import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMock,
  checkStateOutputs,
  fingerprintToolCall,
  MOCK_SEED_MAX_RECORDS,
  NO_REAL_SERVER,
  operationKeyMeta,
  validateMockDefinition,
} from "../index.js";
import type {
  JsonObject,
  MockCallEvent,
  MockDefinition,
  MockRecords,
  MockRecordStore,
} from "../index.js";
import { buildRealHandler, connectRealServer } from "./real-fixture.js";
import type { RealCalls } from "./real-fixture.js";
import { createMemoryRecordStore } from "./memory-record-store.js";

const closers: Array<() => Promise<void>> = [];
let events: MockCallEvent[];
beforeEach(() => {
  events = [];
});
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const idSchema = {
  type: "object",
  properties: { id: { type: "string" } },
  required: ["id"],
};

/** The engineering spec's ticket example, with an input schema for each tool. */
const ticketMock: MockDefinition = {
  seed: { tickets: { "123": { id: "123", status: "open" } } },
  tools: {
    lookup_ticket: {
      inputSchema: idSchema,
      state: { op: "get", collection: "tickets", key: "{{input.id}}" },
    },
    close_ticket: {
      inputSchema: idSchema,
      state: {
        op: "patch",
        collection: "tickets",
        key: "{{input.id}}",
        set: { status: "closed" },
      },
    },
  },
};

async function connect(
  definition: MockDefinition,
  records: MockRecords | undefined,
  real = NO_REAL_SERVER
) {
  expect(validateMockDefinition(definition)).toMatchObject({ ok: true });
  const handler = buildMock(definition, real, {
    records,
    observer: (event) => events.push(event),
  });
  const client = new Client({ name: "mock-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://mock.local/mcp"), {
      fetch: (input, init) =>
        handler.fetch(new Request(input as string | URL, init)),
    })
  );
  closers.push(() => client.close());
  return client;
}

const version = { scope: "version" } as const;
const structured = (result: unknown) =>
  (result as { structuredContent?: unknown }).structuredContent;
const textOf = (result: unknown) =>
  (result as { content: Array<{ text: string }> }).content[0]!.text;

describe("the ticket example", () => {
  it("lookup_ticket reads the seed and close_ticket returns the updated record", async () => {
    const store = createMemoryRecordStore(ticketMock.seed);
    const client = await connect(ticketMock, { store, context: version });
    const before = await client.callTool({
      name: "lookup_ticket",
      arguments: { id: "123" },
    });
    expect(structured(before)).toEqual({ id: "123", status: "open" });
    expect(JSON.parse(textOf(before))).toEqual({ id: "123", status: "open" });
    const closed = await client.callTool({
      name: "close_ticket",
      arguments: { id: "123" },
    });
    expect(structured(closed)).toEqual({ id: "123", status: "closed" });
    const after = await client.callTool({
      name: "lookup_ticket",
      arguments: { id: "123" },
    });
    expect(structured(after)).toEqual({ id: "123", status: "closed" });
    expect(events.map((e) => e.source)).toEqual(["state", "state", "state"]);
  });

  it("two state contexts stay independent", async () => {
    const store = createMemoryRecordStore(ticketMock.seed);
    const shared = await connect(ticketMock, { store, context: version });
    const run = await connect(ticketMock, {
      store,
      context: { scope: "run", runId: "r1", epoch: 1 },
    });
    await run.callTool({ name: "close_ticket", arguments: { id: "123" } });
    const inRun = await run.callTool({
      name: "lookup_ticket",
      arguments: { id: "123" },
    });
    const inShared = await shared.callTool({
      name: "lookup_ticket",
      arguments: { id: "123" },
    });
    expect(structured(inRun)).toEqual({ id: "123", status: "closed" });
    expect(structured(inShared)).toEqual({ id: "123", status: "open" });
  });
});

describe("operations", () => {
  const def: MockDefinition = {
    seed: { notes: { a: { text: "one" }, b: { text: "two" } } },
    tools: {
      get_note: {
        inputSchema: idSchema,
        state: { op: "get", collection: "notes", key: "{{input.id}}" },
      },
      add_note: {
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" }, id: { type: "string" } },
          required: ["text"],
        },
        state: {
          op: "create",
          collection: "notes",
          key: "{{input.id}}",
          value: { text: "{{input.text}}" },
        },
      },
      add_anon_note: {
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        },
        state: {
          op: "create",
          collection: "notes",
          value: { text: "{{input.text}}" },
        },
      },
      edit_note: {
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" }, text: { type: "string" } },
          required: ["id", "text"],
        },
        state: {
          op: "patch",
          collection: "notes",
          key: "{{input.id}}",
          set: { text: "{{input.text}}" },
        },
      },
      remove_note: {
        inputSchema: idSchema,
        state: { op: "delete", collection: "notes", key: "{{input.id}}" },
      },
    },
  };

  async function start() {
    const store = createMemoryRecordStore(def.seed);
    const client = await connect(def, { store, context: version });
    return { client, store };
  }

  it("get, patch and delete on a missing key are tool errors", async () => {
    const { client } = await start();
    for (const name of ["get_note", "remove_note"]) {
      const result = await client.callTool({ name, arguments: { id: "zz" } });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("no record");
    }
    const patched = await client.callTool({
      name: "edit_note",
      arguments: { id: "zz", text: "x" },
    });
    expect(patched.isError).toBe(true);
    expect(events.every((e) => e.refusal === "record_refused")).toBe(true);
  });

  it("create returns the new record; an existing key is a tool error; no key gets a generated one", async () => {
    const { client } = await start();
    const made = await client.callTool({
      name: "add_note",
      arguments: { id: "c", text: "three" },
    });
    expect(structured(made)).toEqual({ text: "three" });
    const again = await client.callTool({
      name: "add_note",
      arguments: { id: "c", text: "four" },
    });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toContain("already has one");
    const anon = await client.callTool({
      name: "add_anon_note",
      arguments: { text: "five" },
    });
    expect(structured(anon)).toEqual({ text: "five" });
  });

  it("delete answers { deleted, key } and the record is gone", async () => {
    const { client } = await start();
    const gone = await client.callTool({
      name: "remove_note",
      arguments: { id: "a" },
    });
    expect(structured(gone)).toEqual({ deleted: true, key: "a" });
    const after = await client.callTool({
      name: "get_note",
      arguments: { id: "a" },
    });
    expect(after.isError).toBe(true);
  });

  it("a state tool never forwards, even on a real tool's name", async () => {
    const calls: RealCalls = { calls: [], hideTools: new Set(), asked: [] };
    const connected = await connectRealServer(buildRealHandler(calls), calls);
    closers.push(connected.close);
    const mock: MockDefinition = {
      seed: { notes: { hi: { text: "hello" } } },
      tools: {
        echo: {
          state: { op: "get", collection: "notes", key: "{{input.message}}" },
        },
      },
    };
    const store = createMemoryRecordStore(mock.seed);
    const client = await connect(
      mock,
      { store, context: version },
      connected.real
    );
    const hit = await client.callTool({
      name: "echo",
      arguments: { message: "hi" },
    });
    expect(structured(hit)).toEqual({ text: "hello" });
    const miss = await client.callTool({
      name: "echo",
      arguments: { message: "nope" },
    });
    expect(miss.isError).toBe(true);
    expect(calls.calls).toEqual([]);
  });

  it("a mock opened without records answers with an error that says so", async () => {
    const client = await connect(ticketMock, undefined);
    const result = await client.callTool({
      name: "lookup_ticket",
      arguments: { id: "123" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("has none");
  });

  it("a full scope is a tool error that says to delete records", async () => {
    const full: MockRecordStore = { execute: async () => ({ ok: false, code: "records_full" }) };
    const client = await connect(ticketMock, { store: full, context: version });
    const result = await client.callTool({ name: "lookup_ticket", arguments: { id: "123" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("10,000 records");
    expect(textOf(result)).toContain("Delete some records");
  });

  it("validates the input against the tool's schema before binding references", async () => {
    const spy: MockRecordStore & { calls: number } = {
      calls: 0,
      async execute() {
        spy.calls += 1;
        return { ok: false, code: "not_found" };
      },
    };
    const client = await connect(ticketMock, { store: spy, context: version });
    const wrong = await client.callTool({
      name: "lookup_ticket",
      arguments: { id: 123 },
    });
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toContain("Input validation error");
    const missing = await client.callTool({
      name: "lookup_ticket",
      arguments: {},
    });
    expect(missing.isError).toBe(true);
    expect(spy.calls).toBe(0);
    expect(events.map((e) => e.refusal)).toEqual([
      "invalid_input",
      "invalid_input",
    ]);
  });

  it("names a reference the call has no value for instead of storing literal text", async () => {
    const store = createMemoryRecordStore(def.seed);
    const client = await connect(def, { store, context: version });
    // `id` is optional on add_note, so the schema passes and the key reference is unbound.
    const result = await client.callTool({
      name: "add_note",
      arguments: { text: "x" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("{{input.id}}");
  });
});

describe("list", () => {
  const notes = Object.fromEntries(
    ["a", "b", "c", "d", "e"].map((k) => [
      k,
      { n: k, kind: k < "c" ? "early" : "late" },
    ])
  );
  const def: MockDefinition = {
    seed: { notes },
    tools: {
      list_notes: {
        inputSchema: {
          type: "object",
          properties: {
            cursor: { type: "string" },
            limit: { type: "integer" },
            kind: { type: "string" },
          },
        },
        state: {
          op: "list",
          collection: "notes",
          where: { kind: "{{input.kind}}" },
          limit: "{{input.limit}}",
          cursor: "{{input.cursor}}",
        },
      },
      all_notes: {
        state: { op: "list", collection: "notes" },
      },
    },
  };

  it("pages in key order with a continuation cursor", async () => {
    const store = createMemoryRecordStore({ notes });
    const client = await connect(
      {
        ...def,
        tools: {
          list_notes: {
            ...def.tools!.list_notes!,
            state: {
              op: "list",
              collection: "notes",
              limit: "{{input.limit}}",
              cursor: "{{input.cursor}}",
            },
          },
        },
      },
      { store, context: version }
    );
    const first = await client.callTool({
      name: "list_notes",
      arguments: { limit: 2 },
    });
    const page1 = structured(first) as {
      records: Array<{ n: string }>;
      nextCursor?: string;
    };
    expect(page1.records.map((r) => r.n)).toEqual(["a", "b"]);
    expect(page1.nextCursor).toBeDefined();
    const second = await client.callTool({
      name: "list_notes",
      arguments: { limit: 2, cursor: page1.nextCursor },
    });
    const page2 = structured(second) as typeof page1;
    expect(page2.records.map((r) => r.n)).toEqual(["c", "d"]);
    const third = await client.callTool({
      name: "list_notes",
      arguments: { limit: 2, cursor: page2.nextCursor },
    });
    const page3 = structured(third) as typeof page1;
    expect(page3.records.map((r) => r.n)).toEqual(["e"]);
    expect(page3.nextCursor).toBeUndefined();
  });

  it("defaults the limit to 50, filters with where, and refuses a limit over 200", async () => {
    const store = createMemoryRecordStore({ notes });
    const client = await connect(def, { store, context: version });
    const all = await client.callTool({
      name: "all_notes",
      arguments: {},
    });
    expect((structured(all) as { records: unknown[] }).records).toHaveLength(5);
    const late = await client.callTool({
      name: "list_notes",
      arguments: { kind: "late" },
    });
    expect(
      (structured(late) as { records: Array<{ n: string }> }).records.map(
        (r) => r.n
      )
    ).toEqual(["c", "d", "e"]);
    const tooMany = await client.callTool({
      name: "list_notes",
      arguments: { kind: "late", limit: 201 },
    });
    expect(tooMany.isError).toBe(true);
    expect(textOf(tooMany)).toContain("1 to 200");
  });
});

describe("result templates and the output schema", () => {
  const outputSchema = {
    type: "object",
    properties: { ticket: { type: "string" }, state: { type: "string" } },
    required: ["ticket", "state"],
  };
  const templated = (result: JsonObject): MockDefinition => ({
    seed: ticketMock.seed,
    tools: {
      lookup_ticket: {
        inputSchema: idSchema,
        outputSchema,
        state: {
          op: "get",
          collection: "tickets",
          key: "{{input.id}}",
          result,
        },
      },
    },
  });

  it("returns a template that fits the schema, filled from the record and the input", async () => {
    const def = templated({
      ticket: "{{input.id}}",
      state: "{{record.status}}",
    });
    expect(checkStateOutputs(def)).toEqual([]);
    const store = createMemoryRecordStore(def.seed);
    const client = await connect(def, { store, context: version });
    const result = await client.callTool({
      name: "lookup_ticket",
      arguments: { id: "123" },
    });
    expect(structured(result)).toEqual({ ticket: "123", state: "open" });
  });

  it("a template that breaks the schema fails at save with its path", async () => {
    const def = templated({ ticket: "{{record.id}}", state: 7 });
    const issues = checkStateOutputs(def);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: "invalid_value",
      path: "tools.lookup_ticket.state.result",
    });
    expect(issues[0]!.message).toContain('record "123"');
  });

  it("without a template, the seed record is checked against the schema", () => {
    const def: MockDefinition = {
      seed: ticketMock.seed,
      tools: {
        lookup_ticket: {
          inputSchema: idSchema,
          outputSchema,
          state: { op: "get", collection: "tickets", key: "{{input.id}}" },
        },
      },
    };
    expect(checkStateOutputs(def).map((i) => i.path)).toEqual([
      "tools.lookup_ticket.state",
    ]);
  });

  it("checks a patch's record after the declared fields change", () => {
    const def: MockDefinition = {
      seed: ticketMock.seed,
      tools: {
        close_ticket: {
          inputSchema: idSchema,
          outputSchema: {
            type: "object",
            properties: { status: { enum: ["open"] } },
          },
          state: {
            op: "patch",
            collection: "tickets",
            key: "{{input.id}}",
            set: { status: "closed" },
          },
        },
      },
    };
    expect(checkStateOutputs(def).map((i) => i.path)).toEqual([
      "tools.close_ticket.state",
    ]);
  });

  it("a call checks the filled result again", async () => {
    const def = templated({
      ticket: "{{input.id}}",
      state: "{{record.status}}",
    });
    const store = createMemoryRecordStore({
      tickets: { "9": { id: "9", status: 5 } },
    });
    const client = await connect(def, { store, context: version });
    const result = await client.callTool({
      name: "lookup_ticket",
      arguments: { id: "9" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("output schema");
  });
});

describe("validation at save", () => {
  const issuesOf = (tool: unknown, seed?: unknown) => {
    const result = validateMockDefinition({
      ...(seed !== undefined && { seed }),
      tools: { t: tool },
    });
    return result.ok ? [] : result.issues.map((i) => [i.code, i.path]);
  };

  it("names the field path of each malformed declaration", () => {
    expect(issuesOf({ state: { op: "fetch", collection: "c" } })).toEqual([
      ["invalid_value", "tools.t.state.op"],
    ]);
    expect(issuesOf({ state: { op: "get", collection: "c" } })).toEqual([
      ["invalid_value", "tools.t.state.key"],
    ]);
    expect(
      issuesOf({ state: { op: "list", collection: "", key: "k" } }).sort()
    ).toEqual([
      ["invalid_type", "tools.t.state.collection"],
      ["unknown_field", "tools.t.state.key"],
    ]);
    expect(
      issuesOf({
        state: { op: "patch", collection: "c", key: "k", set: {} },
      })
    ).toEqual([["invalid_value", "tools.t.state.set"]]);
    expect(
      issuesOf({ state: { op: "list", collection: "c", limit: 500 } })
    ).toEqual([["invalid_value", "tools.t.state.limit"]]);
  });

  it("refuses expressions and references that are not available there", () => {
    expect(
      issuesOf({
        state: { op: "get", collection: "c", key: "{{input.id + 1}}" },
      })
    ).toEqual([["invalid_value", "tools.t.state.key"]]);
    expect(
      issuesOf({
        state: {
          op: "patch",
          collection: "c",
          key: "k",
          set: { a: "{{record.a}}" },
        },
      })
    ).toEqual([["invalid_value", "tools.t.state.set.a"]]);
    expect(
      issuesOf({
        state: {
          op: "get",
          collection: "c",
          key: "k",
          result: { r: "{{records.0}}" },
        },
      })
    ).toEqual([["invalid_value", "tools.t.state.result.r"]]);
  });

  it("a tool cannot have both a saved answer and a state declaration", () => {
    const issues = issuesOf({
      state: { op: "get", collection: "c", key: "k" },
      answer: { from: "saved", cases: [{ result: { content: [] } }] },
    });
    expect(issues).toEqual([["param_conflict", "tools.t"]]);
  });

  it("checks the seed's shape", () => {
    expect(issuesOf({}, { tickets: { "1": "open" } })).toEqual([
      ["invalid_type", "seed.tickets.1"],
    ]);
    expect(issuesOf({}, { tickets: [] })).toEqual([
      ["invalid_type", "seed.tickets"],
    ]);
  });

  it("refuses a seed over the record limit, naming the path, the count and the limit", () => {
    const rows = (from: number, n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${from + i}`, { n: i }]));
    expect(issuesOf({}, { a: rows(0, MOCK_SEED_MAX_RECORDS) })).toEqual([]);
    const result = validateMockDefinition({
      seed: { a: rows(0, 1500), b: rows(0, 501) },
    });
    expect(result).toMatchObject({
      ok: false,
      issues: [{ code: "too_large", path: "seed" }],
    });
    const message = (result as { issues: Array<{ message: string }> }).issues[0]!.message;
    expect(message).toContain("2001 records");
    // A value that is not a record is its own issue and does not count toward the limit.
    const notRecords = validateMockDefinition({
      seed: { a: { ...rows(0, MOCK_SEED_MAX_RECORDS), extra: "text" } },
    });
    expect(notRecords).toMatchObject({ ok: false, issues: [{ code: "invalid_type", path: "seed.a.extra" }] });
    expect(message).toContain("at most 2000");
  });
});

describe("retries with an operation key", () => {
  const def: MockDefinition = {
    seed: { counters: { a: { n: 0 } } },
    tools: {
      add_row: {
        inputSchema: {
          type: "object",
          properties: { v: { type: "string" } },
          required: ["v"],
        },
        state: {
          op: "create",
          collection: "rows",
          value: { v: "{{input.v}}" },
        },
      },
    },
  };

  it("a repeated key with the same input returns the saved outcome and writes once", async () => {
    const store = createMemoryRecordStore();
    const client = await connect(def, { store, context: version });
    const call = () =>
      client.callTool({
        name: "add_row",
        arguments: { v: "x" },
        _meta: operationKeyMeta("k1"),
      });
    const first = await call();
    const second = await call();
    expect(structured(second)).toEqual(structured(first));
    expect(second.isError).toBeFalsy();
    expect(store.applied).toBe(1);
  });

  it("the same key with different input is a conflict", async () => {
    const store = createMemoryRecordStore();
    const client = await connect(def, { store, context: version });
    await client.callTool({
      name: "add_row",
      arguments: { v: "x" },
      _meta: operationKeyMeta("k1"),
    });
    const other = await client.callTool({
      name: "add_row",
      arguments: { v: "y" },
      _meta: operationKeyMeta("k1"),
    });
    expect(other.isError).toBe(true);
    expect(textOf(other)).toContain("operation key");
    expect(store.applied).toBe(1);
  });

  it("two fresh keys, or no key, write each time", async () => {
    const store = createMemoryRecordStore();
    const client = await connect(def, { store, context: version });
    for (const meta of [
      operationKeyMeta("k1"),
      operationKeyMeta("k2"),
      undefined,
      undefined,
    ]) {
      await client.callTool({
        name: "add_row",
        arguments: { v: "x" },
        ...(meta && { _meta: meta }),
      });
    }
    expect(store.applied).toBe(4);
  });

  it("passes the key and the method, tool and arguments fingerprint to the store", async () => {
    const seen: unknown[] = [];
    const store: MockRecordStore = {
      async execute(_context, _op, write) {
        seen.push(write);
        return { ok: true, kind: "record", key: "g", record: { v: "x" } };
      },
    };
    const client = await connect(def, { store, context: version });
    await client.callTool({
      name: "add_row",
      arguments: { v: "x" },
      _meta: operationKeyMeta("k9"),
    });
    await client.callTool({ name: "add_row", arguments: { v: "x" } });
    expect(seen).toEqual([
      { key: "k9", fingerprint: fingerprintToolCall("add_row", { v: "x" }) },
      undefined,
    ]);
    expect(fingerprintToolCall("t", { a: 1, b: 2 })).toBe(
      fingerprintToolCall("t", { b: 2, a: 1 })
    );
  });

  it("refuses an operation key that is not a usable string", async () => {
    const store = createMemoryRecordStore();
    const client = await connect(def, { store, context: version });
    const result = await client.callTool({
      name: "add_row",
      arguments: { v: "x" },
      _meta: { "mcpjam.com/operationKey": 5 },
    });
    expect(result.isError).toBe(true);
    expect(store.applied).toBe(0);
  });

  it("refuses a write from an old epoch and leaves the reset copy alone", async () => {
    const store = createMemoryRecordStore(ticketMock.seed);
    const old = await connect(ticketMock, {
      store,
      context: { scope: "run", runId: "r1", epoch: 1 },
    });
    expect(store.reset("r1")).toBe(2);
    const stale = await old.callTool({
      name: "close_ticket",
      arguments: { id: "123" },
    });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("reset");
    const fresh = await connect(ticketMock, {
      store,
      context: { scope: "run", runId: "r1", epoch: 2 },
    });
    const read = await fresh.callTool({
      name: "lookup_ticket",
      arguments: { id: "123" },
    });
    expect(structured(read)).toEqual({ id: "123", status: "open" });
  });
});
