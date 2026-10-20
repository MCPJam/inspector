import { describe, expect, it } from "vitest";
import { convertToModelMessages, type UIMessage } from "ai";
import { collectHarnessAgentToolApprovalContinuations } from "@ai-sdk/harness/agent";
import { withoutSyntheticDenialResults } from "../harness-approval-messages";

describe("UI approval conversion at the harness boundary", () => {
  it.each(["approval-responded", "output-denied"] as const)(
    "only resumes the unsettled denial (%s)",
    async state => {
      const messages: UIMessage[] = [{
        id: "assistant", role: "assistant", parts: [{
          type: "dynamic-tool", toolName: "Bash", toolCallId: "call",
          input: { command: "printf hello" }, state,
          approval: { id: "approval", approved: false },
        }],
      }];
      const converted = await convertToModelMessages(messages);
      const continuations = collectHarnessAgentToolApprovalContinuations({
        messages: withoutSyntheticDenialResults(converted),
      });
      expect(continuations).toEqual(state === "approval-responded" ? [{
        type: "tool-approval-response", approvalId: "approval", approved: false,
        reason: undefined, providerExecuted: undefined,
      }] : []);
      // Preserve the persisted transcript; only the collector sees the projection.
      expect(converted.at(-1)).toMatchObject({
        content: expect.arrayContaining([{ type: "tool-result", toolCallId: "call",
          toolName: "Bash", output: expect.any(Object) }]),
      });
    },
  );
});
