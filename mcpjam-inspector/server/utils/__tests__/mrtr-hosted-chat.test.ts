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
    // The resolved endpoint is half of the binding digest, so suspend and
    // resume both need a config to hash; a server swap fails the claim closed.
    getServerConfig: vi
      .fn()
      .mockReturnValue({ url: "https://srv.example.com/mcp" }),
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

/**
 * SEP-2243 parity for the HOSTED resume leg.
 *
 * A resume leg goes through `requestWithSchema` (the only path that can carry
 * `requestState` / `inputResponses`), which bypasses upstream `callTool` and
 * therefore its private `Mcp-Param-*` mirroring. The local path fixed this by
 * building the headers itself; hosted did not, so every hosted retry against a
 * conforming 2026-07-28 server came back -32020. These drive the REAL `drive`
 * (no injected seam) and assert at the exact boundary that was broken: what
 * `requestWithSchema` was handed.
 */
describe("resolveMrtrChatResume — Mcp-Param-* on a resume leg", () => {
  // The pending request must DECLARE the key the submission answers, or the
  // driver rejects the round before any leg reaches the wire.
  const pendingInputRequests = {
    q1: {
      method: "elicitation/create",
      params: {
        message: "name?",
        requestedSchema: { type: "object", properties: {} },
      },
    },
  };
  const toolCallState = {
    method: "tools/call",
    originalParams: {
      name: "execute-sql",
      arguments: { region: "us-east", query: "select 1" },
    },
    requestState: "opaque-state",
    pendingInputRequests,
  };

  /**
   * A `resume` that actually runs the module's own `driveLeg`, so the header
   * construction under test executes instead of being stubbed out.
   */
  function resumeThatDrives() {
    return async (deps: any): Promise<ResumeMrtrOutcome> => {
      const leg = await deps.driveLeg(toolCallState, submission.responses);
      return { outcome: "completed", result: leg.result } as ResumeMrtrOutcome;
    };
  }

  function managerWithClient(
    paramHeaders: Record<string, string>,
    requestWithSchema = vi
      .fn()
      .mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
  ) {
    return {
      manager: makeManager({
        getManagedClient: vi.fn().mockReturnValue({ requestWithSchema }),
        mrtrToolParamHeaders: vi.fn().mockResolvedValue(paramHeaders),
      }),
      requestWithSchema,
    };
  }

  it("passes the built headers through to requestWithSchema", async () => {
    const { manager, requestWithSchema } = managerWithClient({
      "Mcp-Param-Region": "us-east",
    });

    await resolveMrtrChatResume(baseDeps(resumeThatDrives(), manager));

    // Built from THIS leg's arguments, via the manager's seam — the same
    // resolution the local MRTR path runs, not a second copy.
    expect(manager.mrtrToolParamHeaders).toHaveBeenCalledWith(
      "srv-1",
      "execute-sql",
      { region: "us-east", query: "select 1" },
    );
    const options = requestWithSchema.mock.calls[0]?.[2];
    expect(options?.headers).toEqual({ "Mcp-Param-Region": "us-east" });
  });

  it("sends NO headers option when the tool declares nothing", async () => {
    // An ordinary tool must produce byte-identical wire to before this change.
    const { manager, requestWithSchema } = managerWithClient({});

    await resolveMrtrChatResume(baseDeps(resumeThatDrives(), manager));

    const options = requestWithSchema.mock.calls[0]?.[2];
    expect(options?.headers).toBeUndefined();
  });

  it("honors the host's omit knob — the seam returning {} means no headers", async () => {
    // `mrtrToolParamHeaders` returns {} when the connection is configured with
    // `mirrorToolParamHeaders: false`, so a hosted session deliberately
    // simulating a non-conforming client stays non-conforming here too.
    const { manager, requestWithSchema } = managerWithClient({});

    await resolveMrtrChatResume(baseDeps(resumeThatDrives(), manager));

    expect(manager.mrtrToolParamHeaders).toHaveBeenCalled();
    expect(requestWithSchema.mock.calls[0]?.[2]?.headers).toBeUndefined();
  });

  it("does not resolve param headers for a non-tools/call verb", async () => {
    // `resources/read` and `prompts/get` mirror no arguments — asking for them
    // would be a pointless round trip on every resume of those verbs.
    const { manager } = managerWithClient({});
    const resume = async (deps: any): Promise<ResumeMrtrOutcome> => {
      const leg = await deps.driveLeg(
        {
          method: "resources/read",
          originalParams: { uri: "test://x" },
          pendingInputRequests,
        },
        submission.responses,
      );
      return { outcome: "completed", result: leg.result } as ResumeMrtrOutcome;
    };

    await resolveMrtrChatResume(baseDeps(resume, manager));

    expect(manager.mrtrToolParamHeaders).not.toHaveBeenCalled();
  });
});
