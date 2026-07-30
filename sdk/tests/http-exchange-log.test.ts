import { describe, expect, it, vi } from "vitest";
import {
  deriveMirroredBodyValues,
  wrapFetchForHttpLogging,
  type HttpExchangeLogEvent,
} from "../src/mcp-client-manager/http-exchange-log.js";
import { wrapFetchForTaskRouting } from "../src/mcp-client-manager/transport-utils.js";

const MODERN = "2026-07-28";

function okResponse(headers: Record<string, string> = {}): Response {
  return new Response("{}", { status: 200, statusText: "OK", headers });
}

function collector() {
  const events: HttpExchangeLogEvent[] = [];
  return { events, log: (event: HttpExchangeLogEvent) => events.push(event) };
}

describe("wrapFetchForHttpLogging", () => {
  it("records the request and response header sets", async () => {
    const { events, log } = collector();
    const base = vi.fn(async () =>
      okResponse({ "mcp-session-id": "sess-1", "content-type": "application/json" }),
    ) as unknown as typeof fetch;

    const wrapped = wrapFetchForHttpLogging("srv", log, base);
    await wrapped("https://example.test/mcp", {
      method: "POST",
      headers: { "Mcp-Method": "tools/list", "MCP-Protocol-Version": MODERN },
    });

    expect(events).toHaveLength(1);
    expect(events[0].serverId).toBe("srv");
    expect(events[0].request.method).toBe("POST");
    expect(events[0].request.url).toBe("https://example.test/mcp");
    // Header NAMES normalize to lowercase through `Headers`; comparisons are
    // case-insensitive per RFC 9110, and the UI classifies accordingly.
    expect(events[0].request.headers["mcp-method"]).toBe("tools/list");
    expect(events[0].request.headers["mcp-protocol-version"]).toBe(MODERN);
    expect(events[0].response?.status).toBe(200);
    expect(events[0].response?.headers["mcp-session-id"]).toBe("sess-1");
  });

  it("redacts credential headers but keeps the auth scheme", async () => {
    const { events, log } = collector();
    const base = vi.fn(async () =>
      okResponse({ "set-cookie": "session=abc" }),
    ) as unknown as typeof fetch;

    const wrapped = wrapFetchForHttpLogging("srv", log, base);
    await wrapped("https://example.test/mcp", {
      method: "POST",
      headers: {
        Authorization: "Bearer super-secret-token",
        Cookie: "a=b",
        "x-api-key": "k",
      },
    });

    const headers = events[0].request.headers;
    expect(headers["authorization"]).toBe("Bearer <redacted>");
    expect(headers["authorization"]).not.toContain("super-secret-token");
    expect(headers["cookie"]).toBe("<redacted>");
    expect(headers["x-api-key"]).toBe("<redacted>");
    expect(events[0].response?.headers["set-cookie"]).toBe("<redacted>");
  });

  it("records the exchange and rethrows when the fetch itself fails", async () => {
    const { events, log } = collector();
    const base = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const wrapped = wrapFetchForHttpLogging("srv", log, base);
    await expect(
      wrapped("https://example.test/mcp", { method: "POST" }),
    ).rejects.toThrow("ECONNREFUSED");

    expect(events).toHaveLength(1);
    expect(events[0].response).toBeUndefined();
    expect(events[0].error).toBe("ECONNREFUSED");
  });

  it("never lets a throwing logger fail the request", async () => {
    const base = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    const wrapped = wrapFetchForHttpLogging(
      "srv",
      () => {
        throw new Error("logger bug");
      },
      base,
    );
    await expect(
      wrapped("https://example.test/mcp", { method: "POST" }),
    ).resolves.toBeInstanceOf(Response);
  });

  it("does not read the response body", async () => {
    const { log } = collector();
    const response = okResponse();
    const base = vi.fn(async () => response) as unknown as typeof fetch;
    const wrapped = wrapFetchForHttpLogging("srv", log, base);

    const returned = await wrapped("https://example.test/mcp", { method: "POST" });
    expect(returned.bodyUsed).toBe(false);
    await expect(returned.text()).resolves.toBe("{}");
  });

  it("captures the headers that actually leave, including task routing's", async () => {
    // Composition order is load-bearing: the log wrapper is the BASE, so
    // `wrapFetchForTaskRouting` has already injected `mcp-name` by the time
    // the exchange is recorded.
    const { events, log } = collector();
    const base = vi.fn(async () => okResponse()) as unknown as typeof fetch;
    const fetchFn = wrapFetchForTaskRouting(
      wrapFetchForHttpLogging("srv", log, base),
    );

    await fetchFn("https://example.test/mcp", {
      method: "POST",
      headers: { "mcp-protocol-version": MODERN },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tasks/get",
        params: { taskId: "task-7" },
      }),
    });

    expect(events[0].request.headers["mcp-name"]).toBe("task-7");
    expect(events[0].request.headers["mcp-method"]).toBe("tasks/get");
  });
});

describe("deriveMirroredBodyValues", () => {
  it("pulls the values the mirrored headers must equal", () => {
    expect(
      deriveMirroredBodyValues(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "execute_sql",
            _meta: { "io.modelcontextprotocol/protocolVersion": MODERN },
          },
        }),
      ),
    ).toEqual({
      method: "tools/call",
      name: "execute_sql",
      protocolVersion: MODERN,
    });
  });

  it("reads params.uri as the name source for resources/read", () => {
    expect(
      deriveMirroredBodyValues(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "resources/read",
          params: { uri: "file:///a.txt" },
        }),
      ),
    ).toEqual({
      method: "resources/read",
      name: "file:///a.txt",
      protocolVersion: undefined,
    });
  });

  it("reads params.taskId as the name source for the SEP-2663 routed methods", () => {
    // Without this the tracing verdict has nothing to compare `Mcp-Name`
    // against on a task poll, and reports the required header as optional.
    expect(
      deriveMirroredBodyValues(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/get",
          params: { taskId: "task-42" },
        }),
      ),
    ).toEqual({
      method: "tasks/get",
      name: "task-42",
      protocolVersion: undefined,
    });
  });

  it("ignores a taskId on a method the routing requirement does not cover", () => {
    // Only get/update/cancel mirror the task id; reading it elsewhere would
    // cross-check `Mcp-Name` against a field it was never copied from.
    expect(
      deriveMirroredBodyValues(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tasks/list",
          params: { taskId: "task-42" },
        }),
      ),
    ).toEqual({
      method: "tasks/list",
      name: undefined,
      protocolVersion: undefined,
    });
  });

  it("returns nothing for a batch, a non-JSON body, or a non-string body", () => {
    expect(deriveMirroredBodyValues(JSON.stringify([{ method: "a" }]))).toBeUndefined();
    expect(deriveMirroredBodyValues("not json")).toBeUndefined();
    expect(deriveMirroredBodyValues(undefined)).toBeUndefined();
    expect(deriveMirroredBodyValues(new Uint8Array([1, 2]))).toBeUndefined();
  });
});
