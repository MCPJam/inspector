import { afterEach, describe, expect, it } from "vitest";
import { convertToModelMessages, type UIMessage } from "ai";
import { collectHarnessAgentToolApprovalContinuations } from "@ai-sdk/harness/agent";
import { pendingApprovalContinuations } from "../pending-approval-continuations.js";
import {
  claimParkedLocalSession,
  parkLocalSession,
  resetApprovalParkForTests,
} from "../local/approval-park.js";

function toolPart(
  id: string,
  approved: boolean,
  completed: boolean,
): UIMessage["parts"][number] {
  const base = {
    type: "dynamic-tool" as const,
    toolName: "exec_command",
    toolCallId: `call-${id}`,
    input: { cmd: "pwd" },
    providerExecuted: true,
    approval: { id, approved },
  };
  return completed
    ? {
        ...base,
        state: "output-available",
        output: approved ? "/workspace" : "Denied",
      }
    : { ...base, state: "approval-responded" };
}

async function history(first: boolean, second?: boolean) {
  const parts = [toolPart("a1", first, second !== undefined)];
  if (second !== undefined) parts.push(toolPart("a2", second, false));
  return convertToModelMessages([
    { id: "assistant-1", role: "assistant", parts },
  ]);
}

function park(id: string) {
  return parkLocalSession({
    sessionId: "s1",
    generation: "g1",
    userId: "u1",
    projectId: "p1",
    pendingApprovalIds: [id],
    resources: {},
    isAlive: () => true,
    holdModelTraffic: () => {},
    end: async () => {},
  });
}

function claim(ids: string[]) {
  return claimParkedLocalSession({
    sessionId: "s1",
    generation: "g1",
    userId: "u1",
    projectId: "p1",
    approvalIds: ids,
  });
}

afterEach(() => resetApprovalParkForTests());

describe("approval history converted by the AI SDK", () => {
  it("does not treat a reused call id in a new runtime as an old completed call", async () => {
    const messages = await convertToModelMessages([
      { id: "user-1", role: "user", parts: [{ type: "text", text: "First model" }] },
      { id: "assistant-1", role: "assistant", parts: [
        { ...toolPart("old-approval", true, true), toolCallId: "mcpjam-host-1" },
      ] },
      { id: "user-2", role: "user", parts: [{ type: "text", text: "New model" }] },
      { id: "assistant-2", role: "assistant", parts: [
        { ...toolPart("new-approval", true, false), toolCallId: "mcpjam-host-1" },
      ] },
    ]);
    expect(pendingApprovalContinuations(messages).map((part) => part.approvalId)).toEqual(["new-approval"]);
  });

  it.each([
    [true, true],
    [true, false],
    [false, true],
  ])(
    "delivers sequential decisions %s then %s exactly once",
    async (first, second) => {
      park("a1");
      const initial = pendingApprovalContinuations(await history(first));
      expect(initial.map((part) => part.approvalId)).toEqual(["a1"]);
      expect(claim(initial.map((part) => part.approvalId))).toMatchObject({
        ok: true,
      });

      park("a2");
      const messages = await history(first, second);
      // The real conversion repeats the completed provider-executed approval.
      expect(
        collectHarnessAgentToolApprovalContinuations({
          messages,
        }),
      ).toHaveLength(second ? 2 : 1);
      const next = pendingApprovalContinuations(messages);
      expect(next.map((part) => [part.approvalId, part.approved])).toEqual([
        ["a2", second],
      ]);
      expect(claim(next.map((part) => part.approvalId))).toMatchObject({
        ok: true,
      });
      expect(claim(next.map((part) => part.approvalId))).toMatchObject({
        ok: false,
        reason: "duplicate-approval",
      });
    },
  );

  it("also excludes completed host-executed calls in earlier messages", async () => {
    const messages = await convertToModelMessages([
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            ...toolPart("a1", true, true),
            providerExecuted: false,
          },
        ],
      },
      {
        id: "assistant-2",
        role: "assistant",
        parts: [toolPart("a2", true, false)],
      },
    ]);
    expect(
      pendingApprovalContinuations(messages).map((part) => part.approvalId),
    ).toEqual(["a2"]);
  });
});
