/**
 * Auto-resume predicate shared by every client-driven agent surface — tested
 * against the REAL `ai` package (no mocks), so a version bump that changes the
 * SDK completion predicates surfaces here.
 *
 * The regression pinned is BUG-4: `lastAssistantMessageIsCompleteWithToolCalls`
 * skips `providerExecuted` parts, so a step that pairs an auto-fulfilled WebMCP
 * `ui_*` tool with a still-`approval-requested` provider-executed bash call
 * reads as "complete" and would auto-resume the turn — answering the approval
 * for the user. `shouldAutoResumeTurn` must veto that while the pill is pending.
 */
import { describe, expect, it } from "vitest";
import type { UIMessage } from "@ai-sdk/react";
import { lastAssistantMessageIsCompleteWithToolCalls } from "ai";
import {
  lastStepHasPendingApproval,
  shouldAutoResumeTurn,
} from "../chat-auto-resume";

/** Minimal assistant message; only role/parts are read by the predicates. */
function assistant(parts: unknown[]): { messages: UIMessage[] } {
  return {
    messages: [{ id: "m1", role: "assistant", parts }] as unknown as UIMessage[],
  };
}

const fulfilledUiTool = {
  type: "tool-ui_snapshot_app",
  toolCallId: "tc-ui",
  state: "output-available",
  output: { ok: true },
};
const pendingBash = {
  type: "tool-bash",
  toolCallId: "tc-bash",
  state: "approval-requested",
  providerExecuted: true,
  input: { command: "uname -a" },
  approval: { id: "appr-bash" },
};

describe("shouldAutoResumeTurn (real ai package)", () => {
  it("does NOT resume while a provider-executed bash approval is pending (BUG-4)", () => {
    const options = assistant([
      { type: "step-start" },
      fulfilledUiTool,
      pendingBash,
    ]);

    // The exact trap: the SDK's own tool-calls predicate reports the step
    // complete because it filters out the provider-executed bash — so without
    // the guard the turn would resume and vanish the Approve/Deny buttons.
    expect(lastAssistantMessageIsCompleteWithToolCalls(options)).toBe(true);
    expect(lastStepHasPendingApproval(options)).toBe(true);
    expect(shouldAutoResumeTurn(options)).toBe(false);
  });

  it("resumes once the bash approval is answered", () => {
    const options = assistant([
      { type: "step-start" },
      fulfilledUiTool,
      {
        ...pendingBash,
        state: "approval-responded",
        approval: { id: "appr-bash", approved: true },
      },
    ]);

    expect(lastStepHasPendingApproval(options)).toBe(false);
    expect(shouldAutoResumeTurn(options)).toBe(true);
  });

  it("does NOT resume for a lone pending bash approval", () => {
    const options = assistant([{ type: "step-start" }, pendingBash]);
    expect(lastStepHasPendingApproval(options)).toBe(true);
    expect(shouldAutoResumeTurn(options)).toBe(false);
  });

  it("resumes when a step's tool calls are all settled and none await approval", () => {
    const options = assistant([{ type: "step-start" }, fulfilledUiTool]);
    expect(lastStepHasPendingApproval(options)).toBe(false);
    expect(shouldAutoResumeTurn(options)).toBe(true);
  });

  it("does not resume a plain text turn with no tool calls", () => {
    const options = assistant([
      { type: "step-start" },
      { type: "text", text: "Done." },
    ]);
    expect(shouldAutoResumeTurn(options)).toBe(false);
  });

  it("only weighs the current step: a pending approval before the last step-start is ignored", () => {
    // An approval-requested part stranded in an earlier step must not park the
    // turn forever — the guard mirrors the SDK's last-step scoping.
    const options = assistant([
      { type: "step-start" },
      pendingBash,
      { type: "step-start" },
      fulfilledUiTool,
    ]);
    expect(lastStepHasPendingApproval(options)).toBe(false);
    expect(shouldAutoResumeTurn(options)).toBe(true);
  });

  it("is inert when the last message is not an assistant turn", () => {
    const empty = { messages: [] as UIMessage[] };
    const user = {
      messages: [
        { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      ] as unknown as UIMessage[],
    };
    expect(lastStepHasPendingApproval(empty)).toBe(false);
    expect(shouldAutoResumeTurn(empty)).toBe(false);
    expect(lastStepHasPendingApproval(user)).toBe(false);
    expect(shouldAutoResumeTurn(user)).toBe(false);
  });
});
