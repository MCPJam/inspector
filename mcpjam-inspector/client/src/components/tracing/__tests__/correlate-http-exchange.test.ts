import { describe, expect, it } from "vitest";

import { TASK_ROUTED_METHODS } from "@mcpjam/sdk/browser";

import {
  findExchangeForFrame,
  findFrameForExchange,
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
  }
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
  extra?: { serverId?: string; url?: string; status?: number }
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
      frameIdentity({ method: "tools/call", params: { name: "echo" } })
    ).toEqual({ method: "tools/call", name: "echo" });
    expect(
      frameIdentity({ method: "resources/read", params: { uri: "demo://x" } })
    ).toEqual({ method: "resources/read", name: "demo://x" });
    expect(
      frameIdentity({ method: "tasks/get", params: { taskId: "t-1" } })
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
      })
    ).toEqual({ method: "tools/call", name: "run-task" });
  });

  it("rejects payloads that are not a single request", () => {
    expect(frameIdentity(undefined)).toBeUndefined();
    expect(frameIdentity([{ method: "tools/call" }])).toBeUndefined();
    expect(
      frameIdentity({ jsonrpc: "2.0", id: 1, result: {} })
    ).toBeUndefined();
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
      "https://example.com/mcp"
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
      { serverId: "srv-2", url: "https://other.example.com/mcp" }
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
      { url: "https://example.com/first" }
    );
    const secondExchange = httpItem(
      "2026-07-29T12:00:01.500Z",
      { method: "tools/call", name: "echo" },
      { url: "https://example.com/second" }
    );

    // Deliberately shuffled: the list is newest-first in the store, and order
    // of arrival must not decide the pairing.
    const items = [secondExchange, second, firstExchange, first];
    expect(findExchangeForFrame(first, items)?.request.url).toBe(
      "https://example.com/first"
    );
    expect(findExchangeForFrame(second, items)?.request.url).toBe(
      "https://example.com/second"
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
      { url: "https://example.com/list" }
    );
    const callExchange = httpItem(
      "2026-07-29T12:00:00.300Z",
      { method: "tools/call", name: "echo" },
      { url: "https://example.com/call" }
    );

    const items = [callExchange, listExchange, list, call];
    expect(findExchangeForFrame(call, items)?.request.url).toBe(
      "https://example.com/call"
    );
    expect(findExchangeForFrame(list, items)?.request.url).toBe(
      "https://example.com/list"
    );
  });

  it("returns nothing for an http row itself", () => {
    const h = httpItem("2026-07-29T12:00:00.000Z", { method: "tools/list" });
    expect(findExchangeForFrame(h, [h])).toBeUndefined();
  });

  it("ignores rows from other traffic sources", () => {
    // OAuth and Apps rows are already excluded by their direction strings, so
    // this asserts the ALLOW-LIST rather than the symptom: correctness must
    // not depend on a direction literal owned by another module.
    const oauthish: CorrelatableLogItem = {
      ...frame("tools/call", "2026-07-29T12:00:00.000Z", {
        params: { name: "echo" },
      }),
      source: "oauth",
    };
    const h = httpItem("2026-07-29T12:00:00.100Z", {
      method: "tools/call",
      name: "echo",
    });

    expect(findExchangeForFrame(oauthish, [oauthish, h])).toBeUndefined();
  });

  it("does not let a foreign-source row shift a real frame's ordinal", () => {
    // The sibling scan decides the ordinal. An Apps/OAuth row that looked like
    // the same call would push this frame to index 1 and pair it with the
    // NEXT exchange — the wrong-headers failure mode.
    const foreign: CorrelatableLogItem = {
      ...frame("tools/call", "2026-07-29T11:59:59.000Z", {
        params: { name: "echo" },
      }),
      source: "mcp-apps",
    };
    const real = frame("tools/call", "2026-07-29T12:00:00.000Z", {
      params: { name: "echo" },
    });
    const mine = httpItem(
      "2026-07-29T12:00:00.500Z",
      { method: "tools/call", name: "echo" },
      { url: "https://example.com/mine" }
    );

    expect(findExchangeForFrame(real, [foreign, real, mine])?.request.url).toBe(
      "https://example.com/mine"
    );
  });
});

describe("task routing reads the SDK's set, not a local copy", () => {
  it("routes by taskId for exactly the methods the capture side does", () => {
    // The capture side (`deriveMirroredBodyValues`) reads `params.taskId` for
    // the SDK's `TASK_ROUTED_METHODS` and nothing else. This module imports
    // that same set; iterating it here guards against anyone reintroducing a
    // local literal, which `tsc` could not check against the original.
    for (const method of TASK_ROUTED_METHODS) {
      expect(frameIdentity({ method, params: { taskId: "t-1" } })).toEqual({
        method,
        name: "t-1",
      });
    }
    // A `tasks/*` method NOT in the set must ignore taskId entirely.
    expect(
      frameIdentity({ method: "tasks/list", params: { taskId: "t-1" } })
    ).toEqual({ method: "tasks/list" });
  });
});

/**
 * The inverse direction, used by the dedicated HTTP row to reach the frame
 * whose `params.arguments` its `Mcp-Param-*` verdicts need. It must agree with
 * the forward direction exactly — disagreeing would show one call's arguments
 * beside another call's headers, the one failure correlation exists to avoid.
 */
describe("findFrameForExchange", () => {
  it("returns the frame the forward direction pairs with", () => {
    const f = frame("tools/call", "2026-07-29T12:00:00.000Z", {
      params: { name: "execute-sql" },
    });
    const http = httpItem("2026-07-29T12:00:00.200Z", {
      method: "tools/call",
      name: "execute-sql",
    });
    const items = [f, http];

    expect(findFrameForExchange(http, items)).toBe(f);
    expect(findExchangeForFrame(f, items)).toBe(http.payload);
  });

  it("picks the ordinal-matching frame among identical repeats", () => {
    const first = frame("tools/call", "2026-07-29T12:00:00.000Z", {
      params: { name: "execute-sql" },
    });
    const second = frame("tools/call", "2026-07-29T12:00:02.000Z", {
      params: { name: "execute-sql" },
    });
    const firstHttp = httpItem("2026-07-29T12:00:00.200Z", {
      method: "tools/call",
      name: "execute-sql",
    });
    const secondHttp = httpItem("2026-07-29T12:00:02.200Z", {
      method: "tools/call",
      name: "execute-sql",
    });
    const items = [first, second, firstHttp, secondHttp];

    expect(findFrameForExchange(secondHttp, items)).toBe(second);
    expect(findFrameForExchange(firstHttp, items)).toBe(first);
  });

  it("counts its ordinal per tool, not per method", () => {
    // Two DIFFERENT tools interleaved. A method-only ordinal makes these one
    // cohort, so the `read-file` exchange (ordinal 1 among `tools/call`
    // exchanges) would look up frame #1 — the `execute-sql` frame — fail the
    // forward confirmation, and lose its headers entirely. The forward
    // direction groups by method AND name, so this direction must too.
    const sql = frame("tools/call", "2026-07-29T12:00:00.000Z", {
      params: { name: "execute-sql" },
    });
    const read = frame("tools/call", "2026-07-29T12:00:01.000Z", {
      params: { name: "read-file" },
    });
    const sqlHttp = httpItem("2026-07-29T12:00:00.200Z", {
      method: "tools/call",
      name: "execute-sql",
    });
    const readHttp = httpItem("2026-07-29T12:00:01.200Z", {
      method: "tools/call",
      name: "read-file",
    });
    const items = [sql, read, sqlHttp, readHttp];

    expect(findFrameForExchange(readHttp, items)).toBe(read);
    expect(findFrameForExchange(sqlHttp, items)).toBe(sql);
  });

  it("stays consistent when a repeat of one tool precedes another", () => {
    // `execute-sql` twice, then `read-file`. Under a method-only ordinal the
    // `read-file` exchange is #2 and would grab the second `execute-sql`
    // frame's slot; per-tool it is #0 within its own cohort.
    const sqlA = frame("tools/call", "2026-07-29T12:00:00.000Z", {
      params: { name: "execute-sql" },
    });
    const sqlB = frame("tools/call", "2026-07-29T12:00:01.000Z", {
      params: { name: "execute-sql" },
    });
    const read = frame("tools/call", "2026-07-29T12:00:02.000Z", {
      params: { name: "read-file" },
    });
    const sqlAHttp = httpItem("2026-07-29T12:00:00.200Z", {
      method: "tools/call",
      name: "execute-sql",
    });
    const sqlBHttp = httpItem("2026-07-29T12:00:01.200Z", {
      method: "tools/call",
      name: "execute-sql",
    });
    const readHttp = httpItem("2026-07-29T12:00:02.200Z", {
      method: "tools/call",
      name: "read-file",
    });
    const items = [sqlA, sqlB, read, sqlAHttp, sqlBHttp, readHttp];

    expect(findFrameForExchange(readHttp, items)).toBe(read);
    expect(findFrameForExchange(sqlBHttp, items)).toBe(sqlB);
    expect(findFrameForExchange(sqlAHttp, items)).toBe(sqlA);
  });

  it("returns undefined when nothing pairs", () => {
    const http = httpItem("2026-07-29T12:00:00.200Z", {
      method: "tools/call",
      name: "execute-sql",
    });
    expect(findFrameForExchange(http, [http])).toBeUndefined();
  });

  it("returns undefined for a row that is not an HTTP exchange", () => {
    const f = frame("tools/call", "2026-07-29T12:00:00.000Z", {
      params: { name: "execute-sql" },
    });
    expect(findFrameForExchange(f, [f])).toBeUndefined();
  });
});
