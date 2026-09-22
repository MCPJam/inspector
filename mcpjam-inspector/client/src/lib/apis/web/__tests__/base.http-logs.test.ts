import { beforeEach, describe, expect, it, vi } from "vitest";

const authFetchMock = vi.fn();

vi.mock("@/lib/config", () => ({
  HOSTED_MODE: true,
}));

vi.mock("@/lib/session-token", () => ({
  authFetch: (...args: unknown[]) => authFetchMock(...args),
  addTokenToUrl: vi.fn((url: string) => url),
}));

import { webPost } from "../base";
import { useTrafficLogStore } from "@/stores/traffic-log-store";

/**
 * The hosted `_httpLogs` envelope, from the wire to the store.
 *
 * These assert the ingested item matches what the LOCAL SSE path produces for
 * the same exchange — `direction: "HTTP"`, `kind: "http"`, a `METHOD /path`
 * label. The source funnel filters on `kind` and `HttpExchangeDetails` reads
 * the payload, so a shape drift here shows up as hosted mode rendering the
 * Tracing panel differently from local mode rather than as a test failure.
 */

const EXCHANGE = {
  serverId: "srv-1",
  request: {
    method: "POST",
    // Query string present on purpose: the row label must drop it (a query can
    // carry a token, and the label feeds the Tracing agent snapshot).
    url: "https://stateless.mcpjam.com/mcp?session=secret",
    headers: {
      "mcp-method": "tools/call",
      "mcp-name": "execute-sql",
      "mcp-protocol-version": "2026-07-28",
    },
  },
  response: { status: 400, statusText: "Bad Request", headers: {} },
  durationMs: 9,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("web/base hosted http logs", () => {
  beforeEach(() => {
    authFetchMock.mockReset();
    useTrafficLogStore.getState().clear();
  });

  it("strips and ingests an HTTP-only envelope", async () => {
    authFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        _httpLogs: [
          {
            serverId: "srv-1",
            serverName: "stateless",
            timestamp: "2026-07-29T12:00:00.000Z",
            exchange: EXCHANGE,
          },
        ],
      }),
    );

    // No `_rpcLogs` at all: the payload must still come back clean. The old
    // strip helper bailed out when `_rpcLogs` was missing, which would have
    // left `_httpLogs` on the typed result AND dropped the logs.
    const result = await webPost<{ request: boolean }, { ok: boolean }>(
      "/api/web/tools/execute",
      { request: true },
    );
    expect(result).toEqual({ ok: true });

    const items = useTrafficLogStore.getState().mcpServerItems;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      serverId: "srv-1",
      serverName: "stateless",
      direction: "HTTP",
      kind: "http",
      method: "POST /mcp",
      timestamp: "2026-07-29T12:00:00.000Z",
    });
    // The payload is the exchange itself — what HttpExchangeDetails renders.
    expect(items[0].payload).toEqual(EXCHANGE);
  });

  it("ingests both kinds when a response carries both", async () => {
    authFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        _rpcLogs: [
          {
            serverId: "srv-1",
            serverName: "stateless",
            direction: "send",
            timestamp: "2026-07-29T12:00:00.000Z",
            message: { jsonrpc: "2.0", id: 1, method: "tools/call" },
          },
        ],
        _httpLogs: [
          {
            serverId: "srv-1",
            serverName: "stateless",
            timestamp: "2026-07-29T12:00:01.000Z",
            exchange: EXCHANGE,
          },
        ],
      }),
    );

    await webPost("/api/web/tools/execute", {});

    const kinds = useTrafficLogStore
      .getState()
      .mcpServerItems.map((item) => item.kind ?? "rpc");
    expect(kinds.sort()).toEqual(["http", "rpc"]);
  });

  it("ingests HTTP logs from an error response too", async () => {
    // The -32020 case: the request FAILED, and the header that explains why is
    // only in the exchange. Dropping the envelope on the error path would lose
    // exactly the evidence the panel exists to show.
    authFetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          code: "INTERNAL_ERROR",
          message: "boom",
          _httpLogs: [
            {
              serverId: "srv-1",
              serverName: "stateless",
              timestamp: "2026-07-29T12:00:00.000Z",
              exchange: EXCHANGE,
            },
          ],
        },
        500,
      ),
    );

    await expect(webPost("/api/web/tools/execute", {})).rejects.toMatchObject({
      status: 500,
      code: "INTERNAL_ERROR",
    });

    expect(useTrafficLogStore.getState().mcpServerItems).toEqual([
      expect.objectContaining({ kind: "http", method: "POST /mcp" }),
    ]);
  });

  it("drops malformed entries instead of rendering a broken row", async () => {
    authFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        _httpLogs: [
          // No `exchange.request` — the renderer needs it for the label and
          // every mirrored-header verdict.
          {
            serverId: "srv-1",
            serverName: "stateless",
            timestamp: "2026-07-29T12:00:00.000Z",
            exchange: { serverId: "srv-1" },
          },
          { nonsense: true },
        ],
      }),
    );

    await webPost("/api/web/tools/execute", {});
    expect(useTrafficLogStore.getState().mcpServerItems).toHaveLength(0);
  });

  it("drops entries whose header values are not strings", async () => {
    // Every consumer treats header values as strings — `decodeMcpHeaderValue`
    // calls `startsWith` on each — so a number from a mis-serializing producer
    // would throw while rendering the expanded row, turning one bad entry into
    // a broken panel. An array passes `typeof === "object"` too, so it is
    // rejected explicitly.
    authFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        _httpLogs: [
          {
            serverId: "srv-1",
            serverName: "stateless",
            timestamp: "2026-07-29T12:00:00.000Z",
            exchange: {
              serverId: "srv-1",
              request: {
                method: "POST",
                url: "https://example.com/mcp",
                headers: { "content-length": 42 },
              },
              durationMs: 1,
            },
          },
          {
            serverId: "srv-1",
            serverName: "stateless",
            timestamp: "2026-07-29T12:00:01.000Z",
            exchange: {
              serverId: "srv-1",
              request: {
                method: "POST",
                url: "https://example.com/mcp",
                headers: ["not", "a", "record"],
              },
              durationMs: 1,
            },
          },
        ],
      }),
    );

    await webPost("/api/web/tools/execute", {});
    expect(useTrafficLogStore.getState().mcpServerItems).toHaveLength(0);
  });

  it("keeps an exchange that failed at the transport, with no response", async () => {
    // The counterpart to the guard above: `response` is legitimately absent on
    // a DNS/TLS/abort failure, and that is a row the reader especially needs.
    authFetchMock.mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        _httpLogs: [
          {
            serverId: "srv-1",
            serverName: "stateless",
            timestamp: "2026-07-29T12:00:00.000Z",
            exchange: {
              serverId: "srv-1",
              request: {
                method: "POST",
                url: "https://example.com/mcp",
                headers: { "mcp-method": "tools/call" },
              },
              error: "fetch failed",
              durationMs: 30,
            },
          },
        ],
      }),
    );

    await webPost("/api/web/tools/execute", {});
    expect(useTrafficLogStore.getState().mcpServerItems).toHaveLength(1);
  });
});
