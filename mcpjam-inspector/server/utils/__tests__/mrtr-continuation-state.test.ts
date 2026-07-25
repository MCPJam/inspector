import { describe, expect, it } from "vitest";
import type { MrtrOperationState } from "@mcpjam/sdk";
import {
  MrtrResumeStateDecodeError,
  MrtrResumeStateTooLargeError,
  decodeResumeState,
  encodeResumeState,
  redactContinuationForLog,
} from "../mrtr-continuation-state";

const SECRET = "OPAQUE_REQUEST_STATE_DO_NOT_LOG";

function makeState(overrides: Partial<MrtrOperationState> = {}): MrtrOperationState {
  return {
    opId: "op-1",
    method: "tools/call",
    originalParams: { name: "do_thing", arguments: { a: 1 } },
    round: 2,
    maxRounds: 10,
    requestState: SECRET,
    pendingInputRequests: {
      q1: {
        method: "elicitation/create",
        params: { mode: "form", message: "Name?", requestedSchema: { type: "object" } },
      },
    } as unknown as MrtrOperationState["pendingInputRequests"],
    ...overrides,
  };
}

describe("resumeState codec", () => {
  it("round-trips an MrtrOperationState byte-for-byte on the semantic fields", () => {
    const state = makeState();
    const blob = encodeResumeState(state);
    const decoded = decodeResumeState(blob);
    expect(decoded).toEqual(state);
    // The opaque requestState survives verbatim.
    expect(decoded.requestState).toBe(SECRET);
  });

  it("rejects an oversized state at encode (never truncates)", () => {
    const huge = makeState({
      originalParams: { name: "x", blob: "a".repeat(2000) },
    });
    expect(() => encodeResumeState(huge, 512)).toThrow(
      MrtrResumeStateTooLargeError,
    );
  });

  it("rejects an oversized blob at decode (defense in depth)", () => {
    const blob = encodeResumeState(makeState());
    expect(() => decodeResumeState(blob, 8)).toThrow(
      MrtrResumeStateTooLargeError,
    );
  });

  it("rejects a structurally invalid blob", () => {
    expect(() => decodeResumeState("not json")).toThrow(
      MrtrResumeStateDecodeError,
    );
    expect(() => decodeResumeState(JSON.stringify({ v: 1, state: { opId: 3 } }))).toThrow(
      MrtrResumeStateDecodeError,
    );
    expect(() => decodeResumeState(JSON.stringify({ v: 2, state: {} }))).toThrow(
      MrtrResumeStateDecodeError,
    );
  });
});

describe("redactContinuationForLog", () => {
  it("emits only non-sensitive fields — never requestState or resumeState", () => {
    const redacted = redactContinuationForLog({
      continuationId: "cont-1",
      status: "awaiting_input",
      round: 2,
      serverId: "srv-1",
      operationMethod: "tools/call",
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("resumeState");
    expect(redacted).toEqual({
      continuationId: "cont-1",
      status: "awaiting_input",
      round: 2,
      serverId: "srv-1",
      operationMethod: "tools/call",
    });
  });
});
