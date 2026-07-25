import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  enqueueHarnessRpcLog,
  flushHarnessRpcLogs,
  getInspectorInstanceId,
  isRpcLogSinkConfigured,
  readCrossInstanceRpcLogs,
  __resetHarnessRpcLogSinkForTest,
} from "../harness-rpc-log-sink";

const CONVEX = "https://convex.example.com";

function configure() {
  vi.stubEnv("CONVEX_HTTP_URL", CONVEX);
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "svc-token");
}

function lastFetchBody(fetchMock: ReturnType<typeof vi.fn>): any {
  const call = fetchMock.mock.calls.at(-1)!;
  return JSON.parse((call[1] as RequestInit).body as string);
}

beforeEach(() => {
  __resetHarnessRpcLogSinkForTest();
});

afterEach(() => {
  __resetHarnessRpcLogSinkForTest();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("config gate", () => {
  it("no-ops (no fetch) when Convex/service-token are absent — single-instance path", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(isRpcLogSinkConfigured()).toBe(false);
    enqueueHarnessRpcLog({
      serverId: "srv-a",
      direction: "send",
      loggedAt: "t",
      message: { m: 1 },
    });
    await flushHarnessRpcLogs();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("enqueue + batched flush", () => {
  it("flushes buffered frames to /write tagged with this instance id", async () => {
    configure();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    enqueueHarnessRpcLog({
      serverId: "srv-a",
      projectId: "p1",
      organizationId: "o1",
      direction: "send",
      loggedAt: "t1",
      message: { a: 1 },
    });
    enqueueHarnessRpcLog({
      serverId: "srv-a",
      direction: "receive",
      loggedAt: "t2",
      message: { b: 2 },
    });
    await flushHarnessRpcLogs();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${CONVEX}/harness/rpc-logs/write`);
    expect((init as RequestInit).headers).toMatchObject({
      "x-inspector-service-token": "svc-token",
    });
    const body = lastFetchBody(fetchMock);
    expect(body.entries).toHaveLength(2);
    expect(
      body.entries.every((e: any) => e.instanceId === getInspectorInstanceId())
    ).toBe(true);
    expect(body.entries[0]).toMatchObject({
      serverId: "srv-a",
      projectId: "p1",
    });
  });

  it("replaces an oversized message with a truncation marker (bounded on write)", async () => {
    configure();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    enqueueHarnessRpcLog({
      serverId: "srv-a",
      direction: "send",
      loggedAt: "t",
      message: { big: "x".repeat(20_000) },
    });
    await flushHarnessRpcLogs();

    const body = lastFetchBody(fetchMock);
    expect(body.entries[0].message).toMatchObject({ _truncated: true });
    expect(body.entries[0].message.big).toBeUndefined();
  });

  it("swallows a failing flush — never throws to the caller (observation-only)", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("convex down")));
    enqueueHarnessRpcLog({
      serverId: "srv-a",
      direction: "send",
      loggedAt: "t",
      message: { a: 1 },
    });
    // Must resolve, not reject.
    await expect(flushHarnessRpcLogs()).resolves.toBeUndefined();
  });
});

describe("readCrossInstanceRpcLogs", () => {
  it("excludes this instance and returns the sink's entries", async () => {
    configure();
    const entries = [
      {
        id: "1",
        serverId: "srv-a",
        direction: "send",
        loggedAt: "t",
        message: {},
        createdAt: 5,
      },
    ];
    const cursors = [{ serverId: "srv-a", sinceMs: 5 }];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ entries, cursors }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const got = await readCrossInstanceRpcLogs({
      servers: [{ serverId: "srv-a", sinceMs: 0 }],
    });
    expect(got).toEqual({ entries, cursors });
    const body = lastFetchBody(fetchMock);
    expect(body.excludeInstanceId).toBe(getInspectorInstanceId());
    expect(body).toMatchObject({
      servers: [{ serverId: "srv-a", sinceMs: 0 }],
    });
  });

  it("keeps the caller's cursors when the sink omits them (never rewinds or skips)", async () => {
    configure();
    const servers = [{ serverId: "srv-a", sinceMs: 42 }];
    // Malformed/absent cursors must not silently reset progress to 0.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })
    );
    expect(await readCrossInstanceRpcLogs({ servers })).toEqual({
      entries: [],
      cursors: servers,
    });
  });

  it("returns unchanged cursors on a non-ok response", async () => {
    configure();
    const servers = [{ serverId: "srv-a", sinceMs: 42 }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await readCrossInstanceRpcLogs({ servers })).toEqual({
      entries: [],
      cursors: servers,
    });
  });

  it("returns no entries on a sink error (never blocks the turn)", async () => {
    configure();
    const servers = [{ serverId: "srv-a", sinceMs: 0 }];
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("boom")));
    expect(await readCrossInstanceRpcLogs({ servers })).toEqual({
      entries: [],
      cursors: servers,
    });
  });

  it("no-ops with no servers or when unconfigured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await readCrossInstanceRpcLogs({ servers: [] })).toEqual({
      entries: [],
      cursors: [],
    });
    configure();
    expect(await readCrossInstanceRpcLogs({ servers: [] })).toEqual({
      entries: [],
      cursors: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
