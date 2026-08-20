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
    const { fetchFn } = routedFetch({
      "tools/list": [{ tools: [{ name: "a" }], nextCursor: "always-more" }],
    });
    const listing = await dialToolListing({
      enteredUrl: URL_UNDER_TEST,
      fetchFn,
      maxListPages: 2,
    });
    // The cursor repeats, so the walk stops on the repeat rather than burning
    // the page budget — and either way it does NOT claim completeness.
    expect(listing.complete).toBe(false);
    expect(listing.paginationCapHit).toBe(true);
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
  it("skips the listings entirely when initialize failed", async () => {
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
    expect(evidence.tools).toBeUndefined();
    expect(calls.map((call) => call.method)).toEqual(["initialize"]);
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
