import { describe, expect, it } from "vitest";
import {
  createCapturingFetch,
  getWireField,
  hasWireField,
  parseSseEvents,
  redactHeadersForLog,
  type FetchLike,
} from "./raw-capture.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function sseResponse(frames: string): Response {
  return new Response(frames, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** A fetch whose response is fixed regardless of the request. */
function respondWith(response: () => Response): FetchLike {
  return async () => response();
}

describe("createCapturingFetch — response capture", () => {
  it("captures unnormalized JSON including wire-only 2026 members", async () => {
    // A modern tools/list result carrying members the SDK client would strip
    // (resultType) or hide (ttlMs/cacheScope, _meta serverInfo) before handing
    // the result to application code.
    const wire = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        resultType: "complete",
        tools: [{ name: "echo", inputSchema: { type: "object" } }],
        ttlMs: 5000,
        cacheScope: "public",
        _meta: {
          "io.modelcontextprotocol/serverInfo": {
            name: "fixture",
            version: "1.0.0",
          },
        },
      },
    };
    const cap = createCapturingFetch(respondWith(() => jsonResponse(wire)));
    await cap.fetch("http://test.local/mcp", { method: "POST" });

    expect(cap.exchanges).toHaveLength(1);
    const { response } = cap.exchanges[0];
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    // The raw fields survive capture untouched.
    expect(getWireField(response.json, "result.resultType")).toBe("complete");
    expect(getWireField(response.json, "result.ttlMs")).toBe(5000);
    expect(getWireField(response.json, "result.cacheScope")).toBe("public");
    // `_meta` keys contain dots, so address them with the array form.
    expect(
      hasWireField(response.json, [
        "result",
        "_meta",
        "io.modelcontextprotocol/serverInfo",
      ]),
    ).toBe(true);
    // bodyText is the exact wire bytes.
    expect(response.bodyText).toBe(JSON.stringify(wire));
  });

  it("does not consume the response — the real consumer still reads it", async () => {
    const wire = { jsonrpc: "2.0", id: 1, result: { resultType: "complete" } };
    const cap = createCapturingFetch(respondWith(() => jsonResponse(wire)));
    const res = await cap.fetch("http://test.local/mcp", { method: "POST" });
    // If capture had consumed the body, this would throw "body already read".
    const consumed = await res.json();
    expect(consumed).toEqual(wire);
    // And the capture still has its own copy.
    expect(cap.exchanges[0].response.json).toEqual(wire);
  });

  it("parses an SSE response into raw frames while teeing the stream", async () => {
    const frames =
      `event: message\n` +
      `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n` +
      `event: message\n` +
      `data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { resultType: "complete" } })}\n\n`;
    const cap = createCapturingFetch(respondWith(() => sseResponse(frames)));
    const res = await cap.fetch("http://test.local/mcp", { method: "POST" });

    const sse = cap.exchanges[0].response.sse;
    expect(sse).toBeDefined();
    expect(sse).toHaveLength(2);
    expect(getWireField(sse![0].json, "method")).toBe("notifications/progress");
    expect(getWireField(sse![1].json, "result.resultType")).toBe("complete");
    // The passthrough stream is still fully readable by the real consumer.
    expect(await res.text()).toBe(frames);
  });

  it("captures a 400 JSON-RPC protocol error with its numeric code", async () => {
    const errBody = {
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32020, message: "Mcp-Method header does not match body" },
    };
    const cap = createCapturingFetch(
      respondWith(() => jsonResponse(errBody, { status: 400 })),
    );
    await cap.fetch("http://test.local/mcp", { method: "POST" });
    const { response } = cap.exchanges[0];
    expect(response.status).toBe(400);
    expect(getWireField(response.json, "error.code")).toBe(-32020);
  });
});

describe("createCapturingFetch — request capture", () => {
  it("records method, url, standard headers, and the _meta envelope in the body", async () => {
    const cap = createCapturingFetch(
      respondWith(() => jsonResponse({ jsonrpc: "2.0", id: 1, result: {} })),
    );
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "echo",
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      },
    });
    await cap.fetch("http://test.local/mcp", {
      method: "post",
      headers: {
        "Mcp-Method": "tools/call",
        "Mcp-Name": "echo",
        "MCP-Protocol-Version": "2026-07-28",
      },
      body,
    });

    const { request } = cap.exchanges[0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("http://test.local/mcp");
    // Header names are lowercased by the Headers contract.
    expect(request.headers["mcp-method"]).toBe("tools/call");
    expect(request.headers["mcp-name"]).toBe("echo");
    expect(request.headers["mcp-protocol-version"]).toBe("2026-07-28");
    expect(request.bodyText).toBe(body);
    expect(
      getWireField(request.json, [
        "params",
        "_meta",
        "io.modelcontextprotocol/protocolVersion",
      ]),
    ).toBe("2026-07-28");
  });

  it("captures a body carried on a Request object (no init.body)", async () => {
    const cap = createCapturingFetch(
      respondWith(() => jsonResponse({ ok: true })),
    );
    const req = new Request("http://test.local/mcp", {
      method: "POST",
      body: JSON.stringify({ hello: "world" }),
    });
    await cap.fetch(req);
    expect(cap.exchanges[0].request.method).toBe("POST");
    expect(getWireField(cap.exchanges[0].request.json, "hello")).toBe("world");
  });
});

describe("parseSseEvents", () => {
  it("joins multiple data lines and strips one leading space", () => {
    const [evt] = parseSseEvents("event: note\ndata: line one\ndata: line two\n\n");
    expect(evt.event).toBe("note");
    expect(evt.data).toBe("line one\nline two");
  });

  it("ignores comment lines and blank frames", () => {
    const events = parseSseEvents(": keep-alive\n\ndata: 1\n\n\n\ndata: 2\n\n");
    expect(events.map((e) => e.data)).toEqual(["1", "2"]);
  });

  it("carries id and parses JSON data", () => {
    const [evt] = parseSseEvents('id: 42\ndata: {"a":1}\n\n');
    expect(evt.id).toBe("42");
    expect(evt.json).toEqual({ a: 1 });
  });
});

describe("getWireField / hasWireField", () => {
  const obj = { a: { b: { c: 1 } }, empty: null };
  it("reads nested present paths", () => {
    expect(getWireField(obj, "a.b.c")).toBe(1);
  });
  it("returns undefined for absent paths without throwing", () => {
    expect(getWireField(obj, "a.x.y")).toBeUndefined();
    expect(hasWireField(obj, "a.b.c")).toBe(true);
    expect(hasWireField(obj, "a.b.z")).toBe(false);
  });
  it("treats a null intermediate as absent", () => {
    expect(hasWireField(obj, "empty.whatever")).toBe(false);
  });
  it("addresses keys that contain dots via the array form", () => {
    const meta = { _meta: { "io.modelcontextprotocol/serverInfo": { name: "x" } } };
    // Dot-path cannot reach it (the key itself has dots)...
    expect(getWireField(meta, "_meta.io.modelcontextprotocol/serverInfo")).toBeUndefined();
    // ...but the array form can.
    expect(
      getWireField(meta, ["_meta", "io.modelcontextprotocol/serverInfo", "name"]),
    ).toBe("x");
  });
});

describe("redactHeadersForLog", () => {
  it("redacts secret-bearing headers and leaves the raw capture intact", () => {
    const raw = {
      authorization: "Bearer secret.token.value",
      "mcp-method": "tools/call",
      cookie: "session=abc",
    };
    const logged = redactHeadersForLog(raw);
    expect(logged["authorization"]).toBe("<redacted>");
    expect(logged["cookie"]).toBe("<redacted>");
    expect(logged["mcp-method"]).toBe("tools/call");
    // Original is unchanged — assertions still see the real token.
    expect(raw["authorization"]).toBe("Bearer secret.token.value");
  });
});
