import { describe, expect, it } from "vitest";

import type { HttpExchangeLogEvent } from "@mcpjam/sdk";

import {
  attachHostedRpcLogs,
  bridgeHarnessRpcLogsToCollector,
  createHostedRpcLogCollector,
} from "../hosted-rpc-logs";
import { rpcLogBus } from "../../../services/rpc-log-bus";

/**
 * Hosted delivery of the headers-only HTTP channel.
 *
 * The regression these cover is the one the old bridge comment described as a
 * deliberate gap: hosted mode captured exchanges and then dropped them, so the
 * Tracing panel's HTTP filter was permanently empty in hosted mode while local
 * mode showed the same traffic. The failure mode is silent — a `-32020
 * HeaderMismatch` looks like an unexplained error because the disagreeing
 * header is invisible — so assert delivery end to end rather than just the
 * collector's internals.
 */

function exchange(
  serverId: string,
  overrides?: Partial<HttpExchangeLogEvent>
): HttpExchangeLogEvent {
  return {
    serverId,
    request: {
      method: "POST",
      url: "https://stateless.example.com/mcp?token=secret",
      headers: {
        "mcp-method": "tools/call",
        "mcp-name": "execute-sql",
        "mcp-protocol-version": "2026-07-28",
      },
    },
    response: { status: 400, statusText: "Bad Request", headers: {} },
    durationMs: 12,
    ...overrides,
  };
}

describe("HostedRpcLogCollector HTTP channel", () => {
  it("carries exchanges in the envelope under their own key", () => {
    const collector = createHostedRpcLogCollector({
      serverId: "srv-1",
      serverName: "stateless",
    });

    collector.httpLogger(exchange("srv-1"));

    const envelope = collector.buildEnvelope();
    expect(envelope._httpLogs).toHaveLength(1);
    expect(envelope._httpLogs?.[0]).toMatchObject({
      serverId: "srv-1",
      serverName: "stateless",
      exchange: { request: { headers: { "mcp-name": "execute-sql" } } },
    });
    // The RPC key stays absent rather than becoming an empty array: consumers
    // branch on presence, and an empty `_rpcLogs` would read as "frames were
    // captured and there were none".
    expect(envelope._rpcLogs).toBeUndefined();
  });

  it("attaches an HTTP-only envelope to the response payload", () => {
    const collector = createHostedRpcLogCollector({});
    collector.httpLogger(exchange("srv-1"));

    // `hasLogs()` gates this attach. Before the HTTP channel existed it
    // counted JSON-RPC frames only, so a turn that captured headers and no
    // frames — a connect that failed at the transport, a doctor probe — had its
    // whole envelope dropped here.
    const attached = attachHostedRpcLogs({ ok: true }, collector) as {
      ok: boolean;
      _httpLogs?: unknown[];
    };
    expect(attached.ok).toBe(true);
    expect(attached._httpLogs).toHaveLength(1);
  });

  it("streams exchanges as their own part type, after buffering", () => {
    const collector = createHostedRpcLogCollector({});
    const written: Array<{ type: string }> = [];

    // Logged BEFORE a writer exists — the buffered-then-flushed path.
    collector.httpLogger(exchange("srv-1"));
    collector.rpcLogger({
      direction: "send",
      message: { method: "tools/call" },
      serverId: "srv-1",
    });

    collector.attachStreamWriter({
      write: (chunk) => written.push(chunk as unknown as { type: string }),
    });

    expect(written.map((chunk) => chunk.type)).toEqual([
      "data-rpc-log",
      "data-http-log",
    ]);

    // And no re-delivery of what already streamed.
    collector.httpLogger(exchange("srv-1"));
    expect(written.map((chunk) => chunk.type)).toEqual([
      "data-rpc-log",
      "data-http-log",
      "data-http-log",
    ]);
  });
});

/**
 * Identity of hosted log events. The browser store keys rows on it, so the
 * collector must stamp every captured event exactly once, at capture — the
 * same event may be delivered twice (streamed as a part AND repeated in the
 * envelope when a mid-turn stream write fails and drops the writer).
 */
describe("HostedRpcLogCollector eventIds", () => {
  it("stamps every captured event, and the stream and the envelope agree", () => {
    const collector = createHostedRpcLogCollector({});
    const written: Array<{ data: { eventId?: string } }> = [];

    collector.attachStreamWriter({
      write: (chunk) =>
        written.push(chunk as unknown as { data: { eventId?: string } }),
    });
    collector.rpcLogger({
      direction: "send",
      message: { jsonrpc: "2.0", id: 14, method: "tools/call" },
      serverId: "srv-1",
    });
    collector.httpLogger(exchange("srv-1"));
    collector.rpcLogger({
      direction: "receive",
      message: { jsonrpc: "2.0", id: 14, result: {} },
      serverId: "srv-1",
    });

    const envelope = collector.buildEnvelope();
    const envelopeIds = [
      ...(envelope._rpcLogs ?? []).map((log) => log.eventId),
      ...(envelope._httpLogs ?? []).map((log) => log.eventId),
    ];
    expect(envelopeIds).toHaveLength(3);
    expect(
      envelopeIds.every((id) => typeof id === "string" && id.length > 0)
    ).toBe(true);
    expect(new Set(envelopeIds).size).toBe(3);

    // The envelope repeats what already streamed (the documented fallback when
    // a stream write fails mid-turn). Identical ids are what lets the browser
    // fold those repeats onto the rows it already has.
    const streamedIds = written.map((chunk) => chunk.data.eventId);
    expect(new Set(streamedIds)).toEqual(new Set(envelopeIds));
  });

  it("gives identical-looking frames distinct eventIds (retries and MRTR rounds stay separate)", () => {
    const collector = createHostedRpcLogCollector({});
    // Same method, same JSON-RPC id, same payload — a retry, or two rounds of
    // one MRTR flow. These are separate physical events and must not collapse.
    const frame = {
      direction: "send" as const,
      message: { jsonrpc: "2.0", id: 14, method: "tools/call" },
      serverId: "srv-1",
    };
    collector.rpcLogger(frame);
    collector.rpcLogger(frame);
    collector.httpLogger(exchange("srv-1"));
    collector.httpLogger(exchange("srv-1"));

    const envelope = collector.buildEnvelope();
    const ids = [
      ...(envelope._rpcLogs ?? []).map((log) => log.eventId),
      ...(envelope._httpLogs ?? []).map((log) => log.eventId),
    ];
    expect(new Set(ids).size).toBe(4);
  });

  it("does not reuse eventIds across collectors (concurrent turns)", () => {
    const a = createHostedRpcLogCollector({});
    const b = createHostedRpcLogCollector({});
    a.httpLogger(exchange("srv-1"));
    b.httpLogger(exchange("srv-1"));

    expect(a.buildEnvelope()._httpLogs?.[0]?.eventId).not.toBe(
      b.buildEnvelope()._httpLogs?.[0]?.eventId
    );
  });
});

describe("bridgeHarnessRpcLogsToCollector", () => {
  it("bridges both kinds off the bus", () => {
    const collector = createHostedRpcLogCollector({});
    const stop = bridgeHarnessRpcLogsToCollector(["srv-1"], collector);

    rpcLogBus.publish({
      serverId: "srv-1",
      direction: "send",
      timestamp: "t",
      message: { method: "tools/call" },
    });
    rpcLogBus.publish({
      kind: "http",
      serverId: "srv-1",
      timestamp: "t",
      exchange: exchange("srv-1"),
    });
    stop();

    const envelope = collector.buildEnvelope();
    expect(envelope._rpcLogs).toHaveLength(1);
    expect(envelope._httpLogs).toHaveLength(1);
  });

  it("still scopes by server id", () => {
    const collector = createHostedRpcLogCollector({});
    const stop = bridgeHarnessRpcLogsToCollector(["srv-1"], collector);

    rpcLogBus.publish({
      kind: "http",
      serverId: "srv-2",
      timestamp: "t",
      exchange: exchange("srv-2"),
    });
    stop();

    expect(collector.buildEnvelope()._httpLogs).toBeUndefined();
  });
});
