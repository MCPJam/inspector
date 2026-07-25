import { beforeEach, describe, expect, it } from "vitest";
import { useMrtrElicitationStore } from "../mrtr-elicitation-store";

/**
 * The browser queue reducer: dedupes SSE redelivery, shows one round at a time,
 * REPLACES a prior round of the same op (never accumulates), and clears on
 * complete/cancel.
 */

const inputRequest = (opId: string, round: number, requests: unknown[]) => ({
  type: "mrtr_input_request",
  opId,
  roundKey: `${opId}:${round}`,
  round,
  serverId: "srv",
  requests,
  timestamp: new Date().toISOString(),
});

const formReq = (key: string, message = "m") => ({
  key,
  mode: "form",
  message,
  requestedSchema: { type: "object", properties: {} },
});

beforeEach(() => {
  useMrtrElicitationStore.getState().__reset();
});

describe("mrtr-elicitation-store reducer", () => {
  it("adds a round and exposes it as the single active round", () => {
    const s = useMrtrElicitationStore.getState();
    s.__ingest(inputRequest("op1", 1, [formReq("q")]));
    const rounds = useMrtrElicitationStore.getState().rounds;
    expect(rounds).toHaveLength(1);
    expect(rounds[0].opId).toBe("op1");
    expect(rounds[0].requests[0].key).toBe("q");
  });

  it("dedupes SSE redelivery by roundKey", () => {
    const s = useMrtrElicitationStore.getState();
    s.__ingest(inputRequest("op1", 1, [formReq("q")]));
    s.__ingest(inputRequest("op1", 1, [formReq("q")]));
    expect(useMrtrElicitationStore.getState().rounds).toHaveLength(1);
  });

  it("REPLACES a prior round of the same op with the next round", () => {
    const s = useMrtrElicitationStore.getState();
    s.__ingest(inputRequest("op1", 1, [formReq("a")]));
    s.__ingest(inputRequest("op1", 2, [formReq("b")]));
    const rounds = useMrtrElicitationStore.getState().rounds;
    expect(rounds).toHaveLength(1);
    expect(rounds[0].round).toBe(2);
    expect(rounds[0].requests[0].key).toBe("b");
  });

  it("queues distinct ops and shows them one at a time", () => {
    const s = useMrtrElicitationStore.getState();
    s.__ingest(inputRequest("opA", 1, [formReq("a")]));
    s.__ingest(inputRequest("opB", 1, [formReq("b")]));
    const rounds = useMrtrElicitationStore.getState().rounds;
    expect(rounds).toHaveLength(2);
    // Active round is the head; the second waits its turn.
    expect(rounds[0].opId).toBe("opA");
  });

  it("clears the op on complete and on cancel", () => {
    const s = useMrtrElicitationStore.getState();
    s.__ingest(inputRequest("op1", 1, [formReq("q")]));
    s.__ingest({ type: "mrtr_input_complete", opId: "op1" });
    expect(useMrtrElicitationStore.getState().rounds).toHaveLength(0);

    s.__ingest(inputRequest("op2", 1, [formReq("q")]));
    s.__ingest({ type: "mrtr_input_cancelled", opId: "op2" });
    expect(useMrtrElicitationStore.getState().rounds).toHaveLength(0);
  });

  it("ignores malformed / keep-alive frames", () => {
    const s = useMrtrElicitationStore.getState();
    s.__ingest({ type: "unknown" });
    s.__ingest(null);
    s.__ingest("keep-alive");
    expect(useMrtrElicitationStore.getState().rounds).toHaveLength(0);
  });
});
