import { describe, expect, it } from "vitest";
import { localDiskResumeState, sessionResumeStateFrom } from "../resume-state.js";

describe("sessionResumeStateFrom", () => {
  it("resumes the session an unfinished approval turn belongs to, without the turn", () => {
    expect(
      sessionResumeStateFrom({
        type: "continue-turn",
        harnessId: "claude-code",
        specificationVersion: "harness-v1",
        data: { sessionId: "s-1" },
        pendingToolApprovals: [{ approvalId: "approval-1" }],
        turnSettings: { permissionMode: "allow-edits" },
      }),
    ).toEqual({
      type: "resume-session",
      harnessId: "claude-code",
      specificationVersion: "harness-v1",
      data: { sessionId: "s-1" },
    });
  });

  it("leaves a session state, and anything that is not a state, as it is", () => {
    const session = { type: "resume-session", harnessId: "codex", data: { thread: "t" } };
    expect(sessionResumeStateFrom(session)).toBe(session);
    expect(sessionResumeStateFrom(undefined)).toBeUndefined();
  });

  it("composes with the local disk resume, which then drops the dead bridge", () => {
    expect(
      localDiskResumeState(
        sessionResumeStateFrom({
          type: "continue-turn",
          harnessId: "claude-code",
          specificationVersion: "harness-v1",
          data: { sessionId: "s-1", bridge: { sandboxId: "local-session" } },
        }),
      ),
    ).toEqual({
      type: "resume-session",
      harnessId: "claude-code",
      specificationVersion: "harness-v1",
      data: { sessionId: "s-1" },
    });
  });
});
