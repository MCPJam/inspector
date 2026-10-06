import { describe, expect, it } from "vitest";
import { diskResumeState, sessionResumeStateFrom } from "../resume-state.js";

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

  it("composes with the disk resume, which then drops the dead bridge", () => {
    expect(
      diskResumeState(
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

describe("diskResumeState", () => {
  it("drops a hosted session's bridge, so the turn respawns rather than reattaching", () => {
    // Every bridge on a computer binds the same port; a reattach to it can
    // reach another session's bridge and stall two minutes before respawning.
    expect(
      diskResumeState({
        type: "resume-session",
        harnessId: "claude-code",
        specificationVersion: "harness-v1",
        data: {
          claudeSessionId: "c-1",
          bridge: {
            port: 39271,
            token: "t",
            lastSeenEventId: 9,
            sandboxId: "sbx_1",
          },
        },
      }),
    ).toEqual({
      type: "resume-session",
      harnessId: "claude-code",
      specificationVersion: "harness-v1",
      data: { claudeSessionId: "c-1" },
    });
  });

  it("does the same for Codex, whose thread resumes from its rollout", () => {
    expect(
      diskResumeState({
        type: "resume-session",
        harnessId: "codex",
        data: { threadId: "t-1", bridge: { port: 39271, token: "t" } },
      }),
    ).toEqual({
      type: "resume-session",
      harnessId: "codex",
      data: { threadId: "t-1" },
    });
  });

  it("keeps an approval continuation's bridge: the paused turn lives in it", () => {
    const paused = {
      type: "continue-turn",
      harnessId: "claude-code",
      data: { bridge: { port: 39271, token: "t" } },
    };
    expect(diskResumeState(paused)).toBe(paused);
  });

  it("leaves a harness it cannot resume from disk alone", () => {
    const cursor = {
      type: "resume-session",
      harnessId: "cursor",
      data: { bridge: { port: 39271, token: "t" } },
    };
    expect(diskResumeState(cursor)).toBe(cursor);
  });
});
