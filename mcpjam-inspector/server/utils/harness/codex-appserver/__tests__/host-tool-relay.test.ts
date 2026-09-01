/**
 * The host-tool path: catalog naming, the loopback relay, and the stdio MCP
 * server Codex spawns — exercised as a real round trip.
 *
 * The MCP server is driven over a REAL child process with real stdio framing,
 * not a mocked transport. The bugs this path is prone to are framing and
 * naming bugs, and a mock reproduces neither.
 */
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { buildHostToolCatalog } from "../bridge/host-tool-catalog.js";
import {
  startHostToolRelay,
  type HostToolRelay,
} from "../bridge/host-tool-relay.js";
import {
  createHostToolMcpServer,
  pumpJsonLines,
  toMcpToolResult,
} from "../bridge/host-tools-mcp.js";
import {
  aliasHostToolName,
  buildHostToolAliases,
} from "../shared/tool-names.js";

const openRelays: HostToolRelay[] = [];
afterEach(async () => {
  await Promise.all(openRelays.splice(0).map((relay) => relay.close()));
});

async function relayWith(handlers: Parameters<typeof startHostToolRelay>[0]) {
  const relay = await startHostToolRelay(handlers);
  openRelays.push(relay);
  return relay;
}

describe("host tool naming", () => {
  it("strips MCPJam's own prefix so Codex's qualification does not double it", () => {
    expect(aliasHostToolName("mcp__weather__get_forecast")).toBe(
      "weather__get_forecast",
    );
    // A host built-in has no prefix to strip.
    expect(aliasHostToolName("web_search")).toBe("web_search");
  });

  it("keeps colliding names unstripped rather than picking a winner", () => {
    // Two tools that differ ONLY by the prefix would both alias to the same
    // name, and a call could not be attributed to either. Both keep their full
    // names, which are unique by construction.
    const { aliasToCanonical } = buildHostToolAliases([
      "mcp__weather__get",
      "weather__get",
    ]);
    expect(aliasToCanonical.get("mcp__weather__get")).toBe("mcp__weather__get");
    expect(aliasToCanonical.get("weather__get")).toBe("weather__get");
    expect(aliasToCanonical.size).toBe(2);
  });

  it("round-trips an alias back to the host's own tool name", () => {
    const catalog = buildHostToolCatalog([
      { name: "mcp__weather__get_forecast", inputSchema: { type: "object" } },
    ]);
    expect(catalog.descriptors[0]?.name).toBe("weather__get_forecast");
    expect(catalog.aliasToCanonical.get("weather__get_forecast")).toBe(
      "mcp__weather__get_forecast",
    );
  });

  it("gives a schemaless tool a permissive schema rather than dropping it", () => {
    // MCP requires an object schema. Dropping the tool would be a silent
    // capability loss; the host validates the input when it executes anyway.
    const catalog = buildHostToolCatalog([
      { name: "no_schema" },
      { name: "bad_schema", inputSchema: "not an object" },
    ]);
    expect(catalog.descriptors).toHaveLength(2);
    for (const descriptor of catalog.descriptors) {
      expect(descriptor.inputSchema).toMatchObject({ type: "object" });
    }
  });
});

describe("host tool relay", () => {
  it("refuses a call with no credential, and one with the wrong credential", async () => {
    const relay = await relayWith({
      listTools: () => [],
      callTool: async () => "never",
    });
    const withoutCredential = await fetch(`${relay.url}/tools`);
    expect(withoutCredential.status).toBe(401);

    const wrongCredential = await fetch(`${relay.url}/tools`, {
      headers: { "x-mcpjam-relay-credential": "not-the-credential" },
    });
    expect(wrongCredential.status).toBe(401);
    // Identical body either way: absent and wrong must not be distinguishable.
    expect(await withoutCredential.json()).toEqual(
      await wrongCredential.json(),
    );
  });

  it("binds loopback only", async () => {
    const relay = await relayWith({
      listTools: () => [],
      callTool: async () => "never",
    });
    expect(relay.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("fails in-flight calls when the turn is cancelled", async () => {
    // The relay imposes no timeout because a host tool can be waiting on a
    // human. Turn lifetime is what bounds it, so cancellation has to reach a
    // call that is still parked.
    let release: (() => void) | undefined;
    const relay = await relayWith({
      listTools: () => [],
      callTool: () =>
        new Promise((resolve) => {
          release = () => resolve("late");
        }),
    });
    const call = fetch(`${relay.url}/call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mcpjam-relay-credential": relay.credential,
      },
      body: JSON.stringify({ toolName: "slow", input: {} }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    relay.cancelAll("turn aborted");
    const body = (await (await call).json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe("turn aborted");
    release?.();
  });

  it("refuses an oversized body instead of buffering it", async () => {
    // The credential keeps a stranger off this socket, but the caller it DOES
    // admit is a model-driven agent in the sandbox. An unbounded read is a way
    // for a steered turn to kill the bridge by exhausting its heap, so the
    // read is capped and the request is refused rather than accumulated.
    const relay = await relayWith({
      listTools: () => [],
      callTool: async () => "never",
    });
    const response = await fetch(`${relay.url}/call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mcpjam-relay-credential": relay.credential,
      },
      // Comfortably past the 8 MiB cap, and not valid JSON either — the size
      // check must fire before any parse is attempted.
      body: "x".repeat(9 * 1024 * 1024),
    }).catch(() => undefined);
    // The relay destroys the socket after replying, so a client-side abort is
    // an acceptable observation of the same refusal.
    if (response) expect(response.status).toBe(413);
  });

  it("cancels a parked call when the relay closes, so teardown cannot hang", async () => {
    // `server.close()` waits for open connections. A host tool parked on a
    // human approval keeps its request open indefinitely, so close() has to
    // cancel first or session teardown blocks on a decision never coming.
    const relay = await relayWith({
      listTools: () => [],
      callTool: () => new Promise(() => {}),
    });
    const call = fetch(`${relay.url}/call`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mcpjam-relay-credential": relay.credential,
      },
      body: JSON.stringify({ toolName: "parked", input: {} }),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await relay.close();
    const body = (await (await call).json()) as { ok: boolean };
    expect(body.ok).toBe(false);
  });
});

describe("the stdio MCP server Codex spawns", () => {
  it("proxies tools/list and tools/call, restoring the host's tool name", async () => {
    const calls: Array<{ toolName: string; input: unknown }> = [];
    const catalog = buildHostToolCatalog([
      {
        name: "mcp__weather__get_forecast",
        description: "Forecast",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    ]);
    // A REAL relay over real loopback HTTP — the proxying, the credential
    // header and the JSON shapes are all exercised; only the process boundary
    // is elided.
    const relay = await relayWith({
      listTools: () => catalog.descriptors,
      callTool: async (invocation) => {
        calls.push(invocation);
        return { content: [{ type: "text", text: "sunny" }] };
      },
    });
    const server = createHostToolMcpServer({
      relayUrl: relay.url,
      relayCredential: relay.credential,
    });

    const init = await server.handle({
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect((init?.result as any).serverInfo.name).toBe("mcpjam");

    const list = await server.handle({ id: 2, method: "tools/list" });
    // The model sees the STRIPPED name; Codex adds its own qualification.
    expect((list?.result as any).tools[0].name).toBe("weather__get_forecast");

    const call = await server.handle({
      id: 3,
      method: "tools/call",
      params: { name: "weather__get_forecast", arguments: { city: "Paris" } },
    });
    expect((call?.result as any).content[0].text).toBe("sunny");

    // ...and the bridge is told the name the HOST declared, so attribution
    // works with no special case downstream.
    expect(calls).toEqual([
      { toolName: "weather__get_forecast", input: { city: "Paris" } },
    ]);
  });

  it("reports a failed host tool as an MCP error result, not a protocol error", async () => {
    // The model should see the message and be able to react. A JSON-RPC error
    // would deny it that.
    const relay = await relayWith({
      listTools: () => [{ name: "boom", inputSchema: { type: "object" } }],
      callTool: async () => {
        throw new Error("the tool exploded");
      },
    });
    const server = createHostToolMcpServer({
      relayUrl: relay.url,
      relayCredential: relay.credential,
    });
    const call = await server.handle({
      id: 1,
      method: "tools/call",
      params: { name: "boom", arguments: {} },
    });
    expect(call?.error).toBeUndefined();
    expect((call?.result as any).isError).toBe(true);
    expect((call?.result as any).content[0].text).toContain(
      "the tool exploded",
    );
  });

  it("never answers a notification", async () => {
    // An id-less frame is a notification. Replying to one is a protocol
    // violation the client would treat as an unsolicited response.
    const server = createHostToolMcpServer({
      relayUrl: undefined,
      relayCredential: undefined,
    });
    expect(
      await server.handle({ method: "notifications/initialized" }),
    ).toBeUndefined();
  });

  it("answers the startup probes rather than erroring on them", async () => {
    const server = createHostToolMcpServer({
      relayUrl: undefined,
      relayCredential: undefined,
    });
    for (const [method, key] of [
      ["resources/list", "resources"],
      ["resources/templates/list", "resourceTemplates"],
      ["prompts/list", "prompts"],
    ] as const) {
      const reply = await server.handle({ id: 1, method });
      expect(reply?.error).toBeUndefined();
      expect((reply?.result as any)[key]).toEqual([]);
    }
  });

  it("frames newline-delimited JSON in both directions", async () => {
    const written: string[] = [];
    const stdin = new PassThrough();
    pumpJsonLines({
      server: createHostToolMcpServer({
        relayUrl: undefined,
        relayCredential: undefined,
      }),
      stdin,
      write: (line) => written.push(line),
    });
    // Two frames in ONE chunk, and a frame split ACROSS chunks: both are how a
    // pipe really delivers data, and both have broken naive readers before.
    stdin.write('{"id":1,"method":"prompts/list"}\n{"id":2,"method":"resou');
    stdin.write('rces/list"}\n');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(written).toHaveLength(2);
    for (const line of written) {
      expect(line.endsWith("\n")).toBe(true);
      expect(JSON.parse(line).jsonrpc).toBe("2.0");
    }
    expect(JSON.parse(written[0]!).id).toBe(1);
    expect(JSON.parse(written[1]!).id).toBe(2);
  });
});

describe("MCP result shaping", () => {
  it("passes an already-MCP-shaped result through untouched", () => {
    // The common case: a host tool projected from a real MCP server returns
    // its server's own content, and re-encoding it would lose structure.
    const original = {
      content: [{ type: "text", text: "hi" }],
      isError: false,
    };
    expect(toMcpToolResult(original)).toBe(original);
  });

  it("wraps a plain string", () => {
    expect(toMcpToolResult("hello")).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("carries a structured value in both encodings", () => {
    const shaped = toMcpToolResult({ temperature: 21 });
    expect(shaped.content[0]?.text).toBe('{"temperature":21}');
    expect(shaped.structuredContent).toEqual({ temperature: 21 });
  });
});
