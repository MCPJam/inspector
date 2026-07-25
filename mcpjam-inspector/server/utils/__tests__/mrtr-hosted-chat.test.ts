import { describe, expect, it, vi } from "vitest";
import {
  resolveMrtrChatResume,
  spliceMrtrToolResult,
  type ResolveMrtrChatResumeDeps,
} from "../mrtr-hosted-chat.js";
import type { ResumeMrtrOutcome } from "../mrtr-hosted-collector.js";
import {
  HOSTED_MRTR_DATA_PART_TYPE,
  type MrtrResumeSubmission,
} from "@/shared/mrtr-continuation";

const submission: MrtrResumeSubmission = {
  continuationId: "cont-1",
  round: 0,
  responses: { q1: { action: "accept", content: { name: "Ada" } } },
};

function makeManager(overrides: Record<string, any> = {}) {
  return {
    listTools: vi.fn().mockResolvedValue({ tools: [] }),
    getManagedClient: vi.fn().mockReturnValue({}),
    getInitializationInfo: vi
      .fn()
      .mockReturnValue({ protocolVersion: "2026-07-28", transport: "http" }),
    assertMrtrToolOutputSchema: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function baseDeps(
  resume: (deps: any) => Promise<ResumeMrtrOutcome>,
  manager = makeManager(),
): ResolveMrtrChatResumeDeps {
  return {
    manager: manager as any,
    bearer: "Bearer test",
    serverId: "srv-1",
    serverName: "Server One",
    toolCallId: "call-9",
    submission,
    authPrincipal: "user-1",
    emit: vi.fn(),
    resume: resume as any,
  };
}

describe("resolveMrtrChatResume", () => {
  it("completes with a spliceable tool-result and runs output-schema validation", async () => {
    const manager = makeManager();
    const result = { content: [{ type: "text", text: "done" }] };
    const deps = baseDeps(
      async () => ({ outcome: "completed", result }) as ResumeMrtrOutcome,
      manager,
    );

    const res = await resolveMrtrChatResume(deps);

    expect(res.kind).toBe("complete");
    // §Trap #9: the reconstructed output-schema assertion ran on the result.
    expect(manager.assertMrtrToolOutputSchema).toHaveBeenCalledWith(
      "srv-1",
      expect.any(String),
      result,
    );
    if (res.kind === "complete") {
      const content = (res.toolResultMessage as any).content[0];
      expect(content.type).toBe("tool-result");
      expect(content.toolCallId).toBe("call-9");
      expect(content.serverId).toBe("srv-1");
    }
  });

  it("classifies a schema-validation failure as a RECOVERABLE tool error, not indeterminate", async () => {
    const manager = makeManager({
      assertMrtrToolOutputSchema: vi
        .fn()
        .mockRejectedValue(
          new TypeError("structured content does not match its output schema"),
        ),
    });
    const deps = baseDeps(
      async () =>
        ({ outcome: "completed", result: { content: [] } }) as ResumeMrtrOutcome,
      manager,
    );

    const res = await resolveMrtrChatResume(deps);

    expect(res.kind).toBe("recover");
    if (res.kind === "recover") {
      const content = (res.toolResultMessage as any).content[0];
      expect(content.output.type).toBe("error-text");
      expect(res.reason).toMatch(/output schema/);
    }
  });

  it("passes a stable binding fingerprint derived from the live manager", async () => {
    const resume = vi
      .fn()
      .mockResolvedValue({ outcome: "completed", result: { content: [] } });
    await resolveMrtrChatResume(baseDeps(resume));
    const arg = resume.mock.calls[0][0];
    expect(typeof arg.bindingFingerprint).toBe("string");
    expect(arg.bindingFingerprint).toHaveLength(64); // sha256 hex
  });

  it("re-suspends on another round without producing a tool-result", async () => {
    const deps = baseDeps(
      async () =>
        ({
          outcome: "input_required",
          round: 2,
          displays: [],
          expiresAt: Date.now() + 1000,
        }) as ResumeMrtrOutcome,
    );
    const res = await resolveMrtrChatResume(deps);
    expect(res).toEqual({ kind: "suspended", round: 2 });
  });

  it("surfaces a side-effecting lease-expiry as indeterminate (no fabricated result)", async () => {
    const deps = baseDeps(
      async () =>
        ({
          outcome: "indeterminate",
          reason: "lease expired mid-wire",
        }) as ResumeMrtrOutcome,
    );
    const res = await resolveMrtrChatResume(deps);
    expect(res.kind).toBe("halted");
    if (res.kind === "halted") expect(res.outcome).toBe("indeterminate");
  });

  it("halts (no model) on cancelled / expired", async () => {
    for (const outcome of ["cancelled", "expired"] as const) {
      const res = await resolveMrtrChatResume(
        baseDeps(async () => ({ outcome, reason: "gone" }) as ResumeMrtrOutcome),
      );
      expect(res.kind).toBe("halted");
    }
  });

  it("gives the model a recoverable error on a failed (non-side-effecting) leg", async () => {
    const res = await resolveMrtrChatResume(
      baseDeps(
        async () =>
          ({ outcome: "failed", reason: "boom" }) as ResumeMrtrOutcome,
      ),
    );
    expect(res.kind).toBe("recover");
  });

  it("halts a terminal-replay completion that carries no result (idempotent)", async () => {
    const res = await resolveMrtrChatResume(
      baseDeps(
        async () =>
          ({ outcome: "completed", result: undefined }) as ResumeMrtrOutcome,
      ),
    );
    expect(res.kind).toBe("halted");
    if (res.kind === "halted") expect(res.reason).toMatch(/already completed/);
  });

  it("wraps continuation events emitted by the leg as transient stream data parts", async () => {
    const emit = vi.fn();
    const deps: ResolveMrtrChatResumeDeps = {
      ...baseDeps(async (resumeDeps: any) => {
        resumeDeps.emit?.({
          kind: "resolved",
          version: 1,
          continuationId: "cont-1",
          outcome: "completed",
        });
        return { outcome: "completed", result: { content: [] } };
      }),
      emit,
    };
    await resolveMrtrChatResume(deps);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: HOSTED_MRTR_DATA_PART_TYPE,
        transient: true,
      }),
    );
  });

  it("halts when the server does not connect for resume", async () => {
    const manager = makeManager({ getManagedClient: vi.fn().mockReturnValue(undefined) });
    const res = await resolveMrtrChatResume(
      baseDeps(async () => ({ outcome: "completed" }) as ResumeMrtrOutcome, manager),
    );
    expect(res.kind).toBe("halted");
  });
});

describe("spliceMrtrToolResult", () => {
  const toolResult = {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: "call-1", output: {} }],
  } as any;

  it("inserts the result right after the assistant message that issued the call", () => {
    const history = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "t" }],
      },
    ] as any[];
    const ok = spliceMrtrToolResult(history, "call-1", toolResult);
    expect(ok).toBe(true);
    expect(history).toHaveLength(3);
    expect((history[2] as any).role).toBe("tool");
  });

  it("returns false when the suspended tool-call is absent", () => {
    const history = [{ role: "user", content: "hi" }] as any[];
    expect(spliceMrtrToolResult(history, "call-1", toolResult)).toBe(false);
    expect(history).toHaveLength(1);
  });

  it("is idempotent — no double insert when a result already exists", () => {
    const history = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "t" }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call-1", output: {} }],
      },
    ] as any[];
    const ok = spliceMrtrToolResult(history, "call-1", toolResult);
    expect(ok).toBe(true);
    expect(history).toHaveLength(2);
  });
});
