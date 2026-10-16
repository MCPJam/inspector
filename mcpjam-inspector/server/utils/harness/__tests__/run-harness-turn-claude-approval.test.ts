import { localApprovalFixture as state } from "./local-approval-agent.fixture.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToModelMessages } from "ai";
import {
  describeParkedLocalSession,
  resetApprovalParkForTests,
} from "../local/approval-park.js";
import {
  endLocalHarnessSession,
  listLocalHarnessSessions,
  resetLocalHarnessRegistryForTests,
} from "../local/session-registry.js";

import {
  localApprovalOptions as options,
} from "./local-approval-runtime.fixture.js";

import { runHarnessTurn } from "../run-harness-turn.js";
import { getHarnessAdapter } from "../registry.js";

async function request(input = options()) {
  const result = await runHarnessTurn(input, "ui");
  if (!result.response) throw new Error("expected an HTTP stream response");
  return result.response.text();
}

async function answer(approved: boolean) {
  const messages = await convertToModelMessages([
    {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "dynamic-tool",
          toolName: "bash",
          toolCallId: "call-1",
          input: { command: "touch example" },
          state: "approval-responded",
          providerExecuted: true,
          approval: { id: "a1", approved },
        },
      ],
    },
  ]);
  return request(options({ messages }));
}

beforeEach(() => {
  vi.clearAllMocks();
  state.saved = null;
  state.alive = false;
  state.resumed = 0;
  state.executions = 0;
  state.currentApproval = 1;
  state.maxApprovals = 1;
  state.harnessId = "claude-code";
  resetApprovalParkForTests();
  resetLocalHarnessRegistryForTests();
  vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "true");
});
afterEach(() => {
  resetApprovalParkForTests();
  resetLocalHarnessRegistryForTests();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("Claude approval through the turn runner's pause and teardown", () => {
  it.each([true, false])(
    "reattaches across requests for approved=%s",
    async (approved) => {
      expect(getHarnessAdapter("claude-code").liveApprovalRuntime).toBe(true);
      const responseBody = await request();
      expect(responseBody).toContain("tool-approval-request");
      const phases = ["connecting-tools", "starting-local", "connecting-runtime"];
      let previous = -1;
      for (const phase of phases) {
        const next = responseBody.indexOf(`"phase":"${phase}"`);
        expect(next).toBeGreaterThan(previous);
        previous = next;
      }
      expect(responseBody.indexOf('"phase":null')).toBeGreaterThan(previous);
      expect(responseBody.indexOf("tool-approval-request")).toBeGreaterThan(previous);
      expect(state.saved).toMatchObject({
        resumeState: { data: { bridge: { token: "claude-generation" } } },
      });
      expect(state.hold).toHaveBeenCalledOnce();
      expect(state.teardown).not.toHaveBeenCalled();
      const continuation = await answer(approved);
      expect(continuation).not.toContain('"type":"error"');
      expect(state.resumed).toBe(1);
      expect(state.executions).toBe(Number(approved));
      expect(state.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ continueFrom: expect.any(Object) }),
      );
      expect(state.teardown).toHaveBeenCalledOnce();
      expect(listLocalHarnessSessions()).toHaveLength(0);
      await answer(approved);
      expect(state.resumed).toBe(1);
    },
  );
  it("survives reload reads then resumes the same pending approval", async () => {
    await request();
    for (let i = 0; i < 2; i++)
      expect(
        describeParkedLocalSession(state.sessionId)?.pendingApprovalIds,
      ).toEqual(["a1"]);
    await answer(true);
    expect(state.executions).toBe(1);
  });
  it("Stop while waiting empties the process registry and refuses a late answer", async () => {
    await request();
    await endLocalHarnessSession(state.sessionId);
    expect(listLocalHarnessSessions()).toHaveLength(0);
    await answer(true);
    expect(state.executions).toBe(0);
    expect(state.resumed).toBe(0);
  });
  it("park expiry stops the process and refuses a late answer", async () => {
    vi.useFakeTimers();
    await request();
    expect(describeParkedLocalSession(state.sessionId)).not.toBeNull();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await answer(true);
    await vi.waitFor(() => expect(listLocalHarnessSessions()).toHaveLength(0));
    await answer(true);
    expect(state.resumed).toBe(0);
  });
});

