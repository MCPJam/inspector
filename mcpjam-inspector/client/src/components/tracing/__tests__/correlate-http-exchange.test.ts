import { describe, expect, it } from "vitest";

import {
  findExchangeForFrame,
  frameIdentity,
  type CorrelatableLogItem,
} from "../correlate-http-exchange";

/**
 * Correlation is the only place this feature can produce a WRONG answer rather
 * than no answer, so the negative cases carry as much weight as the positive
 * one: pairing a frame with a different call's exchange would have a reader
 * chase a mirrored-header verdict that belongs somewhere else.
 */

let seq = 0;

function frame(
  method: string,
  at: string,
  extra?: {
    serverId?: string;
    direction?: string;
    params?: Record<string, unknown>;
  },
): CorrelatableLogItem {
  seq += 1;
  return {
    id: `frame-${seq}`,
    serverId: extra?.serverId ?? "srv-1",
    direction: extra?.direction ?? "SEND",
    timestamp: at,
    source: "mcp-server",
    payload: {
      jsonrpc: "2.0",
      id: seq,
      method,
      ...(extra?.params ? { params: extra.params } : {}),
    },
  };
}

function httpItem(
  at: string,
  bodyValues: { method?: string; name?: string } | undefined,
  extra?: { serverId?: string; url?: string; status?: number },
): CorrelatableLogItem {
  seq += 1;
  return {
    id: `http-${seq}`,
    serverId: extra?.serverId ?? "srv-1",
    direction: "HTTP",
    timestamp: at,
    source: "http",
    payload: {
      serverId: extra?.serverId ?? "srv-1",
      request: {
        method: "POST",
        url: extra?.url ?? "https://example.com/mcp",
        headers: { "mcp-method": bodyValues?.method ?? "" },
      },
      response: {
        status: extra?.status ?? 200,
        statusText: "OK",
        headers: {},
      },
      durationMs: 5,
      ...(bodyValues ? { bodyValues } : {}),
    },
  };
}

describe("frameIdentity", () => {
  it("reads the routing target from name, uri, or a routed taskId", () => {
    expect(
      frameIdentity({ method: "tools/call", params: { name: "echo" } }),
    ).toEqual({ method: "tools/call", name: "echo" });
    expect(
      frameIdentity({ method: "resources/read", params: { uri: "demo://x" } }),
    ).toEqual({ method: "resources/read", name: "demo://x" });
    expect(
      frameIdentity({ method: "tasks/get", params: { taskId: "t-1" } }),
    ).toEqual({ method: "tasks/get", name: "t-1" });
  });

  it("ignores taskId on methods that do not route by it", () => {
    // `tools/call` with a task opt-in carries a taskId that is NOT its
    // `Mcp-Name` source; reading it here would make every task-augmented call
    // look name-mismatched against its own exchange.
    expect(
      frameIdentity({
        method: "tools/call",
        params: { name: "run-task", taskId: "t-1" },
      }),
    ).toEqual({ method: "tools/call", name: "run-task" });
  });

  it("rejects payloads that are not a single request", () => {
    expect(frameIdentity(undefined)).toBeUndefined();
    expect(frameIdentity([{ method: "tools/call" }])).toBeUndefined();
    expect(frameIdentity({ jsonrpc: "2.0", id: 1, result: {} })).toBeUndefined();
  });
});

describe("findExchangeForFrame", () => {
  it("pairs a frame with the exchange logged just after it", () => {
    const f = frame("tools/call", "2026-07-29T12:00:00.000Z", {
      params: { name: "execute-sql" },
    });
    const h = httpItem("2026-07-29T12:00:00.120Z", {
      method: "tools/call",
      name: "execute-sql",
    });

    expect(findExchangeForFrame(f, [f, h])?.request.url).toBe(
      "https://example.com/mcp",
    );
  });

  it("never pairs a response frame", () => {
    const f = frame("tools/call", "2026-07-29T12:00:00.000Z", {
      direction: "RECEIVE",
      params: { name: "execute-sql" },
    });
    const h = httpItem("2026-07-29T12:00:00.120Z", {
      method: "tools/call",
      name: "execute-sql",
    });

    expect(findExchangeForFrame(f, [f, h])).toBeUndefined();
  });

  it("does not cross servers", () => {
    const f = frame("tools/call", "2026-07-29T12:00:00.000Z", {
      params: { name: "echo" },
    });
    const h = httpItem(
      "2026-07-29T12:00:00.120Z",
      { method: "tools/call", name: "echo" },
      { serverId: "srv-2", url: "https://other.example.com/mcp" },
    );

    expect(findExchangeForFrame(f, [f, h])).toBeUndefined();
  });

  it("does not pair when the routing target disagrees", () => {
    const f = frame("tools/call", "2026-07-29T12:00:00.000Z", {
      params: { name: "echo" },
    });
    const h = httpItem("2026-07-29T12:00:00.120Z", {
      method: "tools/call",
      name: "execute-sql",
    });

    expect(findExchangeForFrame(f, [f, h])).toBeUndefined();
  });

  it("does not pair with an exchange that carries no single-request body", () => {
    // A batched or non-JSON body: `bodyValues` is absent, so its headers
    // describe no single frame.
    const f = frame("tools/call", "2026-07-29T12:00:00.000Z", {
      params: { name: "echo" },
    });
    const h = httpItem("2026-07-29T12:00:00.120Z", undefined);

    expect(findExchangeForFrame(f, [f, h])).toBeUndefined();
  });

  it("does not reach backwards to an earlier call's exchange", () => {
    const stale = httpItem("2026-07-29T11:59:00.000Z", {
      method: "tools/call",
      name: "echo",
    });
    const f = frame("tools/call", "2026-07-29T12:00:00.000Z", {
      params: { name: "echo" },
    });

    // The only candidate predates the frame by a minute — the fetch resolves
    // after the frame is logged, so this cannot be its exchange.
    expect(findExchangeForFrame(f, [stale, f])).toBeUndefined();
  });

  it("pairs repeated identical calls by ordinal, in order", () => {
    const first = frame("tools/call", "2026-07-29T12:00:00.000Z", {
      params: { name: "echo" },
    });
    const second = frame("tools/call", "2026-07-29T12:00:01.000Z", {
      params: { name: "echo" },
    });
    const firstExchange = httpItem(
      "2026-07-29T12:00:00.500Z",
      { method: "tools/call", name: "echo" },
      { url: "https://example.com/first" },
    );
    const secondExchange = httpItem(
      "2026-07-29T12:00:01.500Z",
      { method: "tools/call", name: "echo" },
      { url: "https://example.com/second" },
    );

    // Deliberately shuffled: the list is newest-first in the store, and order
    // of arrival must not decide the pairing.
    const items = [secondExchange, second, firstExchange, first];
    expect(findExchangeForFrame(first, items)?.request.url).toBe(
      "https://example.com/first",
    );
    expect(findExchangeForFrame(second, items)?.request.url).toBe(
      "https://example.com/second",
    );
  });

  it("leaves the second of two frames unpaired when only one exchange exists", () => {
    // In-flight: the second call's fetch has not resolved yet. Showing the
    // first call's headers under it would be the wrong answer, not a partial
    // one.
    const first = frame("tools/call", "2026-07-29T12:00:00.000Z", {
      params: { name: "echo" },
    });
    const second = frame("tools/call", "2026-07-29T12:00:01.000Z", {
      params: { name: "echo" },
    });
    const only = httpItem("2026-07-29T12:00:00.500Z", {
      method: "tools/call",
      name: "echo",
    });

    const items = [second, only, first];
    expect(findExchangeForFrame(first, items)).toBeDefined();
    expect(findExchangeForFrame(second, items)).toBeUndefined();
  });

  it("keeps distinct methods on the same server independent", () => {
    const call = frame("tools/call", "2026-07-29T12:00:00.000Z", {
      params: { name: "echo" },
    });
    const list = frame("tools/list", "2026-07-29T12:00:00.100Z");
    const listExchange = httpItem(
      "2026-07-29T12:00:00.200Z",
      { method: "tools/list" },
      { url: "https://example.com/list" },
    );
    const callExchange = httpItem(
      "2026-07-29T12:00:00.300Z",
      { method: "tools/call", name: "echo" },
      { url: "https://example.com/call" },
    );

    const items = [callExchange, listExchange, list, call];
    expect(findExchangeForFrame(call, items)?.request.url).toBe(
      "https://example.com/call",
    );
    expect(findExchangeForFrame(list, items)?.request.url).toBe(
      "https://example.com/list",
    );
  });

  it("returns nothing for an http row itself", () => {
    const h = httpItem("2026-07-29T12:00:00.000Z", { method: "tools/list" });
    expect(findExchangeForFrame(h, [h])).toBeUndefined();
  });
});
