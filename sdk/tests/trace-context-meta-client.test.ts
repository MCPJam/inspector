import { describe, expect, it } from "vitest";
import type { ProtocolEra } from "@modelcontextprotocol/client";
import type { ManagedMcpClient } from "../src/mcp-client-manager/managed-mcp-client.js";
import { TraceContextMetaClient } from "../src/mcp-client-manager/trace-context-meta-client.js";
import type { TraceContext } from "../src/mcp-client-manager/trace-context.js";
import { wrapLegacyClient } from "../src/mcp-client-manager/managed-mcp-client-factory.js";

const TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01";

interface Recorded {
  method: string;
  params: Record<string, unknown> | undefined;
}

/**
 * Minimal `ManagedMcpClient` that records the params it was handed. Only the
 * members the decorator touches are implemented; anything else throws so a
 * missed pass-through shows up as a failure rather than a silent undefined.
 */
function makeRecorder(era: ProtocolEra | undefined) {
  const calls: Recorded[] = [];
  const record =
    (method: string) =>
    async (params?: Record<string, unknown>): Promise<unknown> => {
      calls.push({ method, params });
      return {};
    };
  const inner = {
    getProtocolEra: () => era,
    listTools: record("tools/list"),
    callTool: record("tools/call"),
    listResources: record("resources/list"),
    readResource: record("resources/read"),
    listResourceTemplates: record("resources/templates/list"),
    listPrompts: record("prompts/list"),
    getPrompt: record("prompts/get"),
    subscribeResource: record("resources/subscribe"),
    unsubscribeResource: record("resources/unsubscribe"),
    complete: record("completion/complete"),
    ping: async () => {
      calls.push({ method: "ping", params: undefined });
      return {};
    },
    request: async (req: { method: string; params?: unknown }) => {
      calls.push({
        method: req.method,
        params: req.params as Record<string, unknown> | undefined,
      });
      return {};
    },
    requestWithSchema: async (req: { method: string; params?: unknown }) => {
      calls.push({
        method: `schema:${req.method}`,
        params: req.params as Record<string, unknown> | undefined,
      });
      return {};
    },
  } as unknown as ManagedMcpClient;
  return { inner, calls };
}

function metaOf(call: Recorded): Record<string, unknown> | undefined {
  return call.params?._meta as Record<string, unknown> | undefined;
}

describe("TraceContextMetaClient", () => {
  it("injects nothing when the provider has no context", async () => {
    const { inner, calls } = makeRecorder("modern");
    const client = new TraceContextMetaClient(inner, () => undefined);
    await client.listTools();
    await client.callTool({ name: "add", arguments: { a: 1 } });
    expect(calls.map(metaOf)).toEqual([undefined, undefined]);
    // `listTools()` with no params must stay params-less, not become `{}`.
    expect(calls[0].params).toBeUndefined();
  });

  it("injects all three reserved keys on the modern era", async () => {
    const context: TraceContext = {
      traceparent: TRACEPARENT,
      tracestate: "rojo=00f067aa0ba902b7",
      baggage: "userId=alice",
    };
    const { inner, calls } = makeRecorder("modern");
    const client = new TraceContextMetaClient(inner, () => context);
    await client.callTool({ name: "add", arguments: { a: 1 } });
    expect(metaOf(calls[0])).toEqual({
      traceparent: TRACEPARENT,
      tracestate: "rojo=00f067aa0ba902b7",
      baggage: "userId=alice",
    });
    // The rest of `params` survives untouched.
    expect(calls[0].params?.name).toBe("add");
    expect(calls[0].params?.arguments).toEqual({ a: 1 });
  });

  it("omits tracestate/baggage when the context has none", async () => {
    const { inner, calls } = makeRecorder("modern");
    const client = new TraceContextMetaClient(inner, () => ({
      traceparent: TRACEPARENT,
    }));
    await client.listTools();
    expect(metaOf(calls[0])).toEqual({ traceparent: TRACEPARENT });
  });

  it("injects nothing on the legacy era", async () => {
    const context: TraceContext = {
      traceparent: TRACEPARENT,
      tracestate: "rojo=1",
      baggage: "userId=alice",
    };
    for (const era of ["legacy", undefined] as const) {
      const { inner, calls } = makeRecorder(era);
      const client = new TraceContextMetaClient(inner, () => context);
      await client.listTools();
      await client.callTool({ name: "add", arguments: {} });
      await client.readResource({ uri: "file:///a" });
      await client.getPrompt({ name: "p" });
      await client.complete({
        ref: { type: "ref/prompt", name: "p" },
        argument: { name: "a", value: "" },
      } as Parameters<ManagedMcpClient["complete"]>[0]);
      await client.request({ method: "tools/list" });
      await client.requestWithSchema({ method: "tools/list" }, {} as never);
      // Byte-identical to an undecorated call: no `_meta`, and a params-less
      // call stays params-less.
      expect(calls.map(metaOf)).toEqual(calls.map(() => undefined));
      expect(calls[0].params).toBeUndefined();
      expect(calls[5].params).toBeUndefined();
      expect(calls[6].params).toBeUndefined();
    }
  });

  it("rejects a malformed traceparent rather than forwarding it", async () => {
    const { inner, calls } = makeRecorder("modern");
    const client = new TraceContextMetaClient(inner, () => ({
      traceparent: "00-not-a-trace-id-01",
      tracestate: "rojo=1",
      baggage: "userId=alice",
    }));
    await client.listTools();
    expect(metaOf(calls[0])).toBeUndefined();
  });

  it("drops a malformed tracestate/baggage but keeps the valid parent", async () => {
    const { inner, calls } = makeRecorder("modern");
    const client = new TraceContextMetaClient(inner, () => ({
      traceparent: TRACEPARENT,
      tracestate: "ROJO=1",
      baggage: "no-equals-sign",
    }));
    await client.listTools();
    expect(metaOf(calls[0])).toEqual({ traceparent: TRACEPARENT });
  });

  it("lets caller-supplied `_meta` keys win", async () => {
    const { inner, calls } = makeRecorder("modern");
    const client = new TraceContextMetaClient(inner, () => ({
      traceparent: TRACEPARENT,
      tracestate: "rojo=1",
    }));
    await client.callTool({
      name: "add",
      arguments: {},
      _meta: {
        traceparent:
          "00-11111111111111111111111111111111-2222222222222222-00",
        progressToken: 7,
      },
    } as Parameters<ManagedMcpClient["callTool"]>[0]);
    expect(metaOf(calls[0])).toEqual({
      traceparent: "00-11111111111111111111111111111111-2222222222222222-00",
      tracestate: "rojo=1",
      progressToken: 7,
    });
  });

  it("reads the provider fresh on every request", async () => {
    const { inner, calls } = makeRecorder("modern");
    let current: TraceContext | undefined;
    const client = new TraceContextMetaClient(inner, () => current);
    await client.listTools();
    current = { traceparent: TRACEPARENT };
    await client.listTools();
    current = undefined;
    await client.listTools();
    expect(calls.map(metaOf)).toEqual([
      undefined,
      { traceparent: TRACEPARENT },
      undefined,
    ]);
  });

  it("carries the context through the explicit-schema seam (MRTR legs)", async () => {
    const { inner, calls } = makeRecorder("modern");
    const client = new TraceContextMetaClient(inner, () => ({
      traceparent: TRACEPARENT,
    }));
    await client.request({ method: "tools/call", params: { name: "add" } });
    await client.requestWithSchema(
      { method: "tools/call", params: { name: "add" } },
      {} as never,
    );
    expect(calls.map(metaOf)).toEqual([
      { traceparent: TRACEPARENT },
      { traceparent: TRACEPARENT },
    ]);
  });

  it("leaves `ping` and the subscriptions stream untouched", async () => {
    const { inner, calls } = makeRecorder("modern");
    const client = new TraceContextMetaClient(inner, () => ({
      traceparent: TRACEPARENT,
    }));
    await client.ping();
    expect(calls[0].params).toBeUndefined();
    // `listen` is not implemented by the recorder, so the decorator's own
    // guard is what we observe — proof it does not synthesize params either.
    expect(() => client.listen?.({} as never)).toThrow(
      /does not implement subscriptions\/listen/,
    );
  });
});

describe("managed client factory wiring", () => {
  // `wrapLegacyClient` takes an upstream `Client`; the decorators only ever
  // call the members `OfficialSdkClientAdapter` forwards, so a structural
  // stand-in is enough to observe which layers were applied.
  const fakeUpstream = () =>
    ({
      getProtocolEra: () => "modern" as ProtocolEra,
    }) as never;

  it("does not add the trace decorator when no provider is supplied", () => {
    const managed = wrapLegacyClient(fakeUpstream());
    expect(managed).not.toBeInstanceOf(TraceContextMetaClient);
  });

  it("adds the trace decorator when a provider is supplied", () => {
    const managed = wrapLegacyClient(fakeUpstream(), undefined, () => ({
      traceparent: TRACEPARENT,
    }));
    expect(managed).toBeInstanceOf(TraceContextMetaClient);
  });
});
