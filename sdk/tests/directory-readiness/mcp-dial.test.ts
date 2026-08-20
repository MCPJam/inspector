import { describe, expect, it, vi } from "vitest";

import {
  dialAppResources,
  dialInitialize,
  dialMcpServer,
  dialToolListing,
} from "../../src/directory-readiness/mcp-dial.js";

const URL_UNDER_TEST = "https://example.test/mcp";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A `fetchFn` that answers each JSON-RPC method from a queue of replies. */
function routedFetch(
  routes: Record<string, unknown[]>,
  onCall?: (method: string, params: unknown) => void,
): { fetchFn: typeof fetch; calls: { method: string; params: any }[] } {
  const calls: { method: string; params: any }[] = [];
  const cursors: Record<string, number> = {};
  const fetchFn = vi.fn(async (_url: any, init?: any) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const method = String(body.method);
    calls.push({ method, params: body.params });
    onCall?.(method, body.params);
    const queue = routes[method];
    if (!queue) {
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        error: { code: -32601, message: `no such method: ${method}` },
      });
    }
    const index = Math.min(cursors[method] ?? 0, queue.length - 1);
    cursors[method] = (cursors[method] ?? 0) + 1;
    const reply = queue[index];
    return reply instanceof Response
      ? reply
      : jsonResponse({ jsonrpc: "2.0", id: body.id, result: reply });
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

const INITIALIZE_OK = {
  protocolVersion: "2025-06-18",
  capabilities: { tools: {} },
  serverInfo: { name: "demo", version: "1.2.3" },
};

describe("dialInitialize", () => {
  it("reads the negotiated protocol, server info and session id", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, result: INITIALIZE_OK }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "sess-1",
            },
          },
        ),
    ) as unknown as typeof fetch;

    const evidence = await dialInitialize({
      enteredUrl: URL_UNDER_TEST,
      fetchFn,
    });
    expect(evidence.ok).toBe(true);
    expect(evidence.serverInfo).toEqual({ name: "demo", version: "1.2.3" });
    expect(evidence.sessionId).toBe("sess-1");
  });

  it("separates a refusing server from an unreachable one", async () => {
    const refusing = await dialInitialize({
      enteredUrl: URL_UNDER_TEST,
      fetchFn: (async () =>
        jsonResponse(
          { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "nope" } },
          200,
        )) as unknown as typeof fetch,
    });
    expect(refusing.ok).toBe(false);
    expect(refusing.unreachable).toBeUndefined();

    const dead = await dialInitialize({
      enteredUrl: URL_UNDER_TEST,
      fetchFn: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(dead.ok).toBe(false);
    expect(dead.unreachable).toBe(true);
  });
});

describe("dialToolListing", () => {
  it("walks every page rather than stopping at the first", async () => {
    const { fetchFn, calls } = routedFetch({
      "tools/list": [
        { tools: [{ name: "a" }, { name: "b" }], nextCursor: "p2" },
        { tools: [{ name: "c" }] },
      ],
    });
    const listing = await dialToolListing({
      enteredUrl: URL_UNDER_TEST,
      fetchFn,
    });
    expect(listing.entries.map((tool) => tool.name)).toEqual(["a", "b", "c"]);
    expect(listing.pagesWalked).toBe(2);
    expect(listing.complete).toBe(true);
    expect(calls[1]!.params).toEqual({ cursor: "p2" });
  });

  it("records the page cap instead of reporting a truncated list as whole", async () => {
    // DISTINCT cursors, so only the cap can stop this walk. A fixture that
    // repeated one cursor would be eligible for the repeat guard too, and a
    // change to that guard could silently retire this case.
    const { fetchFn } = routedFetch({
      "tools/list": [
        { tools: [{ name: "a" }], nextCursor: "p2" },
        { tools: [{ name: "b" }], nextCursor: "p3" },
        { tools: [{ name: "c" }], nextCursor: "p4" },
      ],
    });
    const listing = await dialToolListing({
      enteredUrl: URL_UNDER_TEST,
      fetchFn,
      maxListPages: 2,
    });
    expect(listing.pagesWalked).toBe(2);
    expect(listing.paginationCapHit).toBe(true);
    expect(listing.error).toBeUndefined();
    expect(listing.complete).toBe(false);
  });

  it("stops a server that echoes one cursor forever", async () => {
    const { fetchFn, calls } = routedFetch({
      "tools/list": [{ tools: [{ name: "a" }], nextCursor: "same" }],
    });
    const listing = await dialToolListing({
      enteredUrl: URL_UNDER_TEST,
      fetchFn,
      maxListPages: 50,
    });
    expect(calls.length).toBeLessThan(5);
    expect(listing.complete).toBe(false);
    expect(listing.error).toContain("repeated cursor");
  });

  it("records the entry cap when a server lists more than the budget", async () => {
    const { fetchFn } = routedFetch({
      "tools/list": [{ tools: [{ name: "a" }, { name: "b" }, { name: "c" }] }],
    });
    const listing = await dialToolListing({
      enteredUrl: URL_UNDER_TEST,
      fetchFn,
      maxListEntries: 2,
    });
    expect(listing.entries).toHaveLength(2);
    expect(listing.entryCapHit).toBe(true);
    expect(listing.complete).toBe(false);
  });

  it("treats an unimplemented method as a complete answer of none", async () => {
    const { fetchFn } = routedFetch({});
    const listing = await dialToolListing({
      enteredUrl: URL_UNDER_TEST,
      fetchFn,
    });
    expect(listing.entries).toEqual([]);
    expect(listing.unsupported).toBe(true);
    // The server answered the question. "None" is an answer; a gap is not.
    expect(listing.complete).toBe(true);
  });

  it("treats an unreachable listing as incomplete, not as an empty one", async () => {
    const listing = await dialToolListing({
      enteredUrl: URL_UNDER_TEST,
      fetchFn: (async () => {
        throw new Error("socket hang up");
      }) as unknown as typeof fetch,
    });
    expect(listing.unreachable).toBe(true);
    expect(listing.complete).toBe(false);
  });
});

describe("dialAppResources", () => {
  it("keeps templates that carry the profile and those that only carry the media type", async () => {
    const { fetchFn } = routedFetch({
      "resources/list": [
        {
          resources: [
            { uri: "ui://a", mimeType: "text/html;profile=mcp-app" },
            { uri: "ui://b", mimeType: "text/html" },
            { uri: "data://c", mimeType: "application/json" },
          ],
        },
      ],
    });
    const evidence = await dialAppResources(
      { enteredUrl: URL_UNDER_TEST, fetchFn },
      "text/html;profile=mcp-app",
      [
        { name: "show", _meta: { "openai/outputTemplate": "ui://a" } },
        { name: "also_show", _meta: { "mcp/ui": { uri: "ui://a" } } },
      ],
    );
    // `ui://b` is collected so the MIME check can GRADE it; dropping it here
    // would make a non-conforming template vanish rather than fail.
    expect(evidence.appResources.map((r) => r.uri)).toEqual([
      "ui://a",
      "ui://b",
    ]);
    expect(evidence.referencedByTools).toEqual({
      "ui://a": ["also_show", "show"],
    });
  });
});

describe("dialMcpServer", () => {
  it("makes no listing request when initialize failed, but says why", async () => {
    // No request goes out — every listing would fail the same way, and three
    // copies of one transport error buries the cause. What DOES survive is the
    // reason, on a listing marked incomplete: a caller reading `tools` sees an
    // empty set either way, and only one of them has an explanation.
    const { fetchFn, calls } = routedFetch({
      initialize: [
        jsonResponse(
          { jsonrpc: "2.0", id: 1, error: { code: -32001, message: "auth" } },
          401,
        ),
      ],
    });
    const evidence = await dialMcpServer({
      enteredUrl: URL_UNDER_TEST,
      fetchFn,
      appHtmlMime: "text/html;profile=mcp-app",
    });
    expect(evidence.initialize.ok).toBe(false);
    expect(calls.map((call) => call.method)).toEqual(["initialize"]);
    expect(evidence.tools?.entries).toEqual([]);
    expect(evidence.tools?.complete).toBe(false);
    expect(evidence.tools?.error).toContain("auth");
    expect(evidence.appResources).toBeUndefined();
  });

  it("carries the session id onto the listing requests", async () => {
    const seen: Record<string, string | null> = {};
    const fetchFn = vi.fn(async (_url: any, init?: any) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const headers = new Headers(init?.headers ?? {});
      seen[String(body.method)] = headers.get("mcp-session-id");
      if (body.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: INITIALIZE_OK,
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "sess-9",
            },
          },
        );
      }
      return jsonResponse({
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: [] },
      });
    }) as unknown as typeof fetch;

    await dialMcpServer({ enteredUrl: URL_UNDER_TEST, fetchFn });
    expect(seen["initialize"]).toBeNull();
    expect(seen["tools/list"]).toBe("sess-9");
  });
});

describe("the handshake a server is entitled to insist on", () => {
  it("sends notifications/initialized before it asks for anything", async () => {
    const { fetchFn, calls } = routedFetch({
      initialize: [INITIALIZE_OK],
      "notifications/initialized": [{}],
      "tools/list": [{ tools: [{ name: "search", description: "Search." }] }],
    });

    await dialMcpServer({ enteredUrl: URL_UNDER_TEST, fetchFn });

    // Server frameworks enforce the lifecycle literally — the Python SDK
    // errors any request that arrives before this notification. Skipping it
    // would make every server built on one report an unreadable tool listing,
    // which grades as a coverage gap and reads as "we could not see this
    // server" about a server that is perfectly conformant.
    const order = calls.map((call) => call.method);
    expect(order[0]).toBe("initialize");
    expect(order[1]).toBe("notifications/initialized");
    expect(order.indexOf("tools/list")).toBeGreaterThan(1);
  });

  it("carries the session id on the notification", async () => {
    const seen: (string | null)[] = [];
    const fetchFn = vi.fn(async (_url: any, init?: any) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.method === "notifications/initialized") {
        seen.push(new Headers(init?.headers).get("mcp-session-id"));
        return jsonResponse({});
      }
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: body.id, result: INITIALIZE_OK }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
            "mcp-session-id": "sess-9",
          },
        },
      );
    }) as unknown as typeof fetch;

    await dialInitialize({ enteredUrl: URL_UNDER_TEST, fetchFn });
    expect(seen).toEqual(["sess-9"]);
  });

  it("does not fail the dial when the notification itself fails", async () => {
    // Whether a notification landed is not evidence about the target — it has
    // no answer to grade. The listings that follow report their own
    // reachability.
    const fetchFn = vi.fn(async (_url: any, init?: any) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.method === "notifications/initialized") {
        throw new Error("connection reset");
      }
      return jsonResponse({ jsonrpc: "2.0", id: body.id, result: INITIALIZE_OK });
    }) as unknown as typeof fetch;

    const evidence = await dialInitialize({
      enteredUrl: URL_UNDER_TEST,
      fetchFn,
    });
    expect(evidence.ok).toBe(true);
  });
});

describe("a listing that stopped halfway is not a listing", () => {
  it("refuses to call a part-walked listing complete when a later page 404s the method", async () => {
    const { fetchFn } = routedFetch({
      initialize: [INITIALIZE_OK],
      "notifications/initialized": [{}],
      "tools/list": [
        { tools: [{ name: "one", description: "First." }], nextCursor: "p2" },
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 99,
            error: { code: -32601, message: "method not found" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ],
    });

    const listing = await dialToolListing({
      enteredUrl: URL_UNDER_TEST,
      fetchFn,
    });

    // "The method is not implemented" answers the whole question only when it
    // answers the FIRST page. Here the server served a page, handed over a
    // cursor, and then broke — so what we hold is half a listing, and a half
    // that reads as whole would stand in for the set.
    expect(listing.entries).toHaveLength(1);
    expect(listing.complete).toBe(false);
    expect(listing.unsupported).toBeUndefined();
  });

  it("still reads a first-page -32601 as the answer it is", async () => {
    // `routedFetch` answers an unrouted method with -32601, so omitting
    // `tools/list` is a server that does not implement it at all.
    const { fetchFn } = routedFetch({
      initialize: [INITIALIZE_OK],
      "notifications/initialized": [{}],
    });

    const listing = await dialToolListing({
      enteredUrl: URL_UNDER_TEST,
      fetchFn,
    });

    // A server with no such method answered the question. Grading that as a
    // gap would report it as one nobody could reach.
    expect(listing.entries).toHaveLength(0);
    expect(listing.unsupported).toBe(true);
    expect(listing.complete).toBe(true);
  });
});
