import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInMemoryTurnWindowStore,
  TurnWindowConflictError,
} from "../turn-windows.js";
import {
  createInMemoryToolCallLedger,
  hashPayload,
  type ToolCallLedger,
} from "../tool-call-ledger.js";

const allow = async () => ({ allow: true as const });

describe("turn windows", () => {
  it("allows one turn per connector and closes only the turn it names", () => {
    const store = createInMemoryTurnWindowStore();
    const first = store.open({ connectorId: "c1", runId: "r1", approve: allow });
    expect(() =>
      store.open({ connectorId: "c1", runId: "r2", approve: allow }),
    ).toThrow(TurnWindowConflictError);
    store.close("some-other-turn");
    expect(store.active("c1")?.turnId).toBe(first.turnId);
    store.close(first.turnId);
    expect(store.active("c1")).toBeUndefined();
    expect(
      store.open({ connectorId: "c1", runId: "r2", approve: allow }).runId,
    ).toBe("r2");
  });
});

describe("tool call ledger", () => {
  it("hashes equal arguments equally regardless of key order", () => {
    expect(hashPayload({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      createHash("sha256").update('{"a":[2,{"c":4,"d":3}],"b":1}').digest("hex"),
    );
    expect(hashPayload({ b: 1, a: 2 })).toBe(hashPayload({ a: 2, b: 1 }));
  });

  it("hashes a call without arguments as null instead of throwing", () => {
    expect(() => hashPayload(undefined)).not.toThrow();
    expect(hashPayload(undefined)).toBe(hashPayload(null));
  });

  it("keeps the first outcome and finds calls for reconciliation", () => {
    const ledger = createInMemoryToolCallLedger();
    const entry = ledger.forwarded({
      connectorId: "c1",
      turnId: "t1",
      jsonrpcId: 7,
      toolName: "echo",
      toolUseId: "toolu_1",
      argsHash: hashPayload({ message: "hi" }),
    });
    ledger.settle(entry.id, { state: "result", upstreamStatus: 200 });
    ledger.settle(entry.id, { state: "lost" });
    const [found] = ledger.find({ connectorId: "c1", toolUseId: "toolu_1" });
    expect(found?.state).toBe("result");
    expect(ledger.forTurn("t1")).toHaveLength(1);
    expect(ledger.find({ connectorId: "c2" })).toHaveLength(0);
  });
});

describe("tool call ledger time bounds", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("compares since as a time, whatever its precision or offset", () => {
    vi.useFakeTimers();
    const ledger = createInMemoryToolCallLedger();
    const send = (toolUseId: string) =>
      ledger.forwarded({
        connectorId: "c1",
        turnId: "t1",
        jsonrpcId: toolUseId,
        toolName: "echo",
        toolUseId,
        argsHash: hashPayload({}),
      });
    vi.setSystemTime(new Date("2026-11-20T11:59:59.900Z"));
    send("before");
    vi.setSystemTime(new Date("2026-11-20T12:00:00.500Z"));
    send("after");
    const ids = (since: string) =>
      ledger.find({ connectorId: "c1", since }).map((e) => e.toolUseId);
    expect(ids("2026-11-20T12:00:00Z")).toEqual(["after"]);
    expect(ids("2026-11-20T14:00:00+02:00")).toEqual(["after"]);
    expect(ids("not a time")).toEqual(["before", "after"]);
  });
});

describe("tool call ledger retention", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const forward = (
    ledger: ToolCallLedger,
    connectorId: string,
    turnId: string,
    toolUseId: string,
  ) =>
    ledger.forwarded({
      connectorId,
      turnId,
      jsonrpcId: toolUseId,
      toolName: "echo",
      toolUseId,
      argsHash: hashPayload({ toolUseId }),
    });
  const ids = (entries: Array<{ toolUseId?: string }>) =>
    entries.map((entry) => entry.toolUseId);

  it("reads a turn's and a connector's calls in the order they were sent", () => {
    const ledger = createInMemoryToolCallLedger();
    const a = forward(ledger, "c1", "t1", "a");
    forward(ledger, "c1", "t2", "b");
    forward(ledger, "c2", "t1", "c");
    // Settling doesn't move a call: reads keep the order the calls went out.
    ledger.settle(a.id, { state: "result", upstreamStatus: 200 });
    expect(ids(ledger.forTurn("t1"))).toEqual(["a", "c"]);
    expect(ids(ledger.find({ connectorId: "c1" }))).toEqual(["a", "b"]);
    expect(ids(ledger.find({ connectorId: "c1", toolUseId: "b" }))).toEqual([
      "b",
    ]);
    expect(ledger.forTurn("t3")).toEqual([]);
  });

  it("drops answered calls after the retention window, never one still waiting", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const ledger = createInMemoryToolCallLedger({ retentionMs: 60_000 });
    const answered = forward(ledger, "c1", "t1", "answered");
    const failed = forward(ledger, "c1", "t1", "failed");
    forward(ledger, "c1", "t1", "waiting");
    ledger.settle(answered.id, { state: "result", upstreamStatus: 200 });
    vi.setSystemTime(new Date("2026-01-01T00:00:30Z"));
    ledger.settle(failed.id, { state: "error", upstreamStatus: 500 });

    vi.setSystemTime(new Date("2026-01-01T00:01:01Z"));
    forward(ledger, "c1", "t2", "next");
    // Only the call answered more than a minute ago is gone.
    expect(ids(ledger.forTurn("t1"))).toEqual(["failed", "waiting"]);
    expect(ids(ledger.find({ connectorId: "c1" }))).toEqual([
      "failed",
      "waiting",
      "next",
    ]);

    vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
    forward(ledger, "c2", "t3", "later");
    // A call forwarded with no answer may have run, so it stays for reconcile.
    expect(ids(ledger.forTurn("t1"))).toEqual(["waiting"]);
    expect(ids(ledger.find({ connectorId: "c1" }))).toEqual([
      "waiting",
      "next",
    ]);
  });

  it("keeps an answered call for a day by default", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const ledger = createInMemoryToolCallLedger();
    const call = forward(ledger, "c1", "t1", "a");
    ledger.settle(call.id, { state: "result", upstreamStatus: 200 });
    vi.setSystemTime(new Date("2026-01-01T23:00:00Z"));
    forward(ledger, "c1", "t2", "b");
    expect(ids(ledger.forTurn("t1"))).toEqual(["a"]);
    vi.setSystemTime(new Date("2026-01-02T00:00:01Z"));
    forward(ledger, "c1", "t2", "c");
    expect(ledger.forTurn("t1")).toEqual([]);
  });
});
