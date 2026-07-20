import { describe, expect, it } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  createFixtureHandler,
  FIXTURE_GREETING_URI,
} from "./dual-era-fixture.js";
import {
  createCapturingFetch,
  getWireField,
  hasWireField,
  type RawExchange,
} from "./raw-capture.js";

function byMethod(
  exchanges: RawExchange[],
  method: string,
): RawExchange | undefined {
  return exchanges.find((e) => getWireField(e.request.json, "method") === method);
}

/**
 * Connect a modern-pinned client to the fixture in-process, capturing every
 * frame. `handler.fetch` serves the request without a socket — the URL is
 * never dialed.
 */
async function connectModern() {
  const handler = createFixtureHandler();
  const cap = createCapturingFetch((input, init) =>
    handler.fetch(new Request(input as string | URL, init)),
  );
  const client = new Client(
    { name: "dual-era-fixture-test", version: "1.0.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL("http://fixture.local/mcp"),
    { fetch: cap.fetch },
  );
  await client.connect(transport);
  return { client, cap };
}

/**
 * Connect a default (legacy) client to the SAME handler. `createMcpHandler`
 * serves the 2025-era stateless idiom by default, so no pin is needed — the
 * client runs the ordinary `initialize` handshake.
 */
async function connectLegacy() {
  const handler = createFixtureHandler();
  const cap = createCapturingFetch((input, init) =>
    handler.fetch(new Request(input as string | URL, init)),
  );
  const client = new Client({ name: "dual-era-fixture-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://fixture.local/mcp"),
    { fetch: cap.fetch },
  );
  await client.connect(transport);
  return { client, cap };
}

describe("dual-era fixture — modern (2026-07-28)", () => {
  it("negotiates the modern era and serves the primitive surface", async () => {
    const { client } = await connectModern();
    expect(client.getProtocolEra()).toBe("modern");

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("echo");

    const resources = await client.listResources();
    expect(resources.resources.map((r) => r.uri)).toContain(FIXTURE_GREETING_URI);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((p) => p.name)).toContain("welcome");

    const called = await client.callTool({
      name: "echo",
      arguments: { message: "round-trip" },
    });
    const first = Array.isArray(called.content) ? called.content[0] : undefined;
    expect(first).toMatchObject({ type: "text", text: "round-trip" });

    await client.close();
  });

  it("fires server/discover and carries the modern wire invariants on the raw frames", async () => {
    // The SDK client hides these members before results reach app code, so we
    // assert them on the captured frames (raw-capture), not on the returned
    // objects.
    const { client, cap } = await connectModern();
    await client.listTools();
    const readResult = await client.readResource({ uri: FIXTURE_GREETING_URI });
    expect(
      Array.isArray(readResult.contents) ? readResult.contents[0]?.text : undefined,
    ).toBe("hello from the fixture");

    // server/discover fired during connect (SEP-2575).
    expect(byMethod(cap.exchanges, "server/discover")).toBeDefined();

    // resultType is REQUIRED on every modern result (SEP-2322).
    const list = byMethod(cap.exchanges, "tools/list");
    expect(list, "tools/list exchange captured").toBeDefined();
    expect(getWireField(list!.response.json, "result.resultType")).toBe("complete");

    // CacheableResult: ttlMs + cacheScope on list/read results (SEP-2549). The
    // server always emits both on the modern era (defaulting to 0 / 'private').
    expect(hasWireField(list!.response.json, "result.ttlMs")).toBe(true);
    expect(hasWireField(list!.response.json, "result.cacheScope")).toBe(true);
    const read = byMethod(cap.exchanges, "resources/read");
    expect(hasWireField(read!.response.json, "result.ttlMs")).toBe(true);
    expect(hasWireField(read!.response.json, "result.cacheScope")).toBe(true);

    // Standard SEP-2243 request header mirrors the method.
    expect(list!.request.headers["mcp-method"]).toBe("tools/list");
    // The per-request _meta envelope carries the negotiated protocol version.
    expect(
      getWireField(list!.request.json, [
        "params",
        "_meta",
        "io.modelcontextprotocol/protocolVersion",
      ]),
    ).toBe("2026-07-28");

    // No sessions in the modern era (SEP-2567): the server must never mint one.
    for (const ex of cap.exchanges) {
      expect(ex.response.headers["mcp-session-id"]).toBeUndefined();
    }

    await client.close();
  });
});

describe("dual-era fixture — legacy (2025-era)", () => {
  it("serves the same handler over the legacy era with no modern wire members", async () => {
    const { client, cap } = await connectLegacy();
    expect(client.getProtocolEra()).toBe("legacy");

    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("echo");

    // The legacy era carries no `resultType` on the wire — the modern-only
    // member must not leak onto a 2025-era result.
    const list = byMethod(cap.exchanges, "tools/list");
    expect(list, "tools/list exchange captured").toBeDefined();
    expect(hasWireField(list!.response.json, "result.resultType")).toBe(false);

    await client.close();
  });
});
