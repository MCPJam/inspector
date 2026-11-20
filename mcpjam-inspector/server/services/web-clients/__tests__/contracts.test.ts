import { describe, expect, it } from "vitest";
import {
  createInMemoryTurnWindowStore,
  TurnWindowConflictError,
} from "../turn-windows.js";
import {
  canonicalJson,
  createInMemoryToolCallLedger,
  hashPayload,
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
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      '{"a":[2,{"c":4,"d":3}],"b":1}',
    );
    expect(hashPayload({ b: 1, a: 2 })).toBe(hashPayload({ a: 2, b: 1 }));
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
