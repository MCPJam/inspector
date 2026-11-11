import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

// B-isolation phase 6 — the harness runs on an EPHEMERAL box when the caller
// hands it one, and on the acting user's personal computer when it does not.
//
// The load-bearing property is the negative one: given a binding, the turn must
// NEVER call `resolveHarnessSandbox` (the personal reserve). `run-harness-turn`
// imports it locally and never re-exports it, so it is mocked at its DEFINING
// module — mocking anything else would intercept nothing and this suite would
// pass regardless of what the turn actually did.

const harnessState = vi.hoisted(() => ({
  started: vi.fn(),
  session: {
    sessionId: "session-1",
    stop: vi.fn(async () => ({})),
    destroy: vi.fn(async () => {}),
  },
}));

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    createSession = vi.fn(async () => { harnessState.started(); return harnessState.session; });
    stream = vi.fn(async () => ({
      fullStream: (async function* () {
        yield { type: "finish", finishReason: "stop" };
      })(),
      text: Promise.resolve("done"),
    }));
    continueStream = this.stream;
  },
  collectHarnessAgentToolApprovalContinuations: vi.fn(() => []),
}));

vi.mock("../registry.js", () => ({
  buildBrokerDummyAuth: vi.fn(() => ({
    anthropic: {
      apiKey: "",
      authToken: "mcpjam-broker-dummy",
      baseUrl: "https://broker.example",
    },
  })),
  getHarnessAdapter: vi.fn(() => ({
    id: "claude-code",
    displayName: "Claude Code",
    defaultPermissionMode: "allow-all",
    supportsSkills: false,
    mcpDelivery: "mcpjam",
    supportsModel: vi.fn(() => true),
    createHarness: vi.fn(() => ({ harnessId: "claude-code" })),
    parseToolName: vi.fn((toolName: string) => ({ toolName })),
  })),
}));

vi.mock("../resolve-sandbox.js", () => ({
  resolveHarnessSandbox: vi.fn(async () => ({
    computerId: "computer-1",
    sandboxId: "sandbox-1",
  })),
}));

vi.mock("../e2b-sandbox-provider.js", () => ({
  createE2BHarnessSandboxProvider: vi.fn(() => ({
    sandboxId: "sandbox-1",
  })),
}));

vi.mock("../runtime-skills.js", () => ({
  fetchRuntimeSkills: vi.fn(async () => ({ ok: true, skills: [] })),
  skillsFingerprint: vi.fn(() => "empty-skills"),
}));

vi.mock("../reconcile-skill-dirs.js", () => ({
  reconcileSkillDirs: vi.fn(async () => {}),
}));

vi.mock("../harness-session-state.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../harness-session-state.js")
  >();
  return {
    ...actual,
    claimHarnessSessionState: vi.fn(async () => ({
      ok: true,
      leaseId: "lease-1",
      stateVersion: 1,
      state: null,
      fingerprintChanged: false,
    })),
    commitHarnessSessionState: vi.fn(async () => true),
    heartbeatHarnessSessionState: vi.fn(async () => "ok"),
    releaseHarnessSessionState: vi.fn(async () => {}),
  };
});

vi.mock("../harness-model-broker.js", () => ({
  reserveHarnessBox: vi.fn(async () => ({ ok: true })),
  renewHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
  releaseHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
  revokeHarnessModelBroker: vi.fn(async () => {}),
  startHarnessModelBroker: vi.fn(async () => ({
    ok: true,
    runId: "broker-run-1",
    expiresAt: Date.now() + 60_000,
    protocol: "anthropic",
    proxyBaseUrl: "https://broker.example",
    delivery: "e2b-network-transform",
  })),
}));

vi.mock("../mcp-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp-config.js")>();
  return {
    ...actual,
    buildHarnessMcpJson: vi.fn(() => ({ mcpServers: {} })),
    harnessServerInputFromConfig: vi.fn(),
    harnessServerKeyToName: vi.fn((key: string) => key),
  };
});

import { runHarnessTurn } from "../run-harness-turn";
import { startHarnessModelBroker } from "../harness-model-broker.js";
import { revokeHarnessModelBroker } from "../harness-model-broker.js";
import {
  reserveHarnessBox,
  renewHarnessBoxReservation,
  releaseHarnessBoxReservation,
} from "../harness-model-broker.js";
import { resolveHarnessSandbox } from "../resolve-sandbox.js";
import { createE2BHarnessSandboxProvider } from "../e2b-sandbox-provider.js";
import { ScenarioHarnessRepublishRequiredError } from "../../scenario-runtime-config.js";

function baseOptions(overrides: Record<string, unknown> = {}) {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "hi" }],
    } as unknown as ModelMessage,
  ];
  return {
    messages,
    modelId: "anthropic/claude-sonnet-4-6",
    provider: "anthropic",
    systemPrompt: "You are Claude Code.",
    authHeader: "Bearer test",
    projectId: "project-1",
    mcpClientManager: { getServerConfig: vi.fn() },
    selectedServers: [],
    requireToolApproval: false,
    // "eval" keeps this suite focused on the box binding: the "swarm" owner
    // lane additionally fail-closes on incomplete continuity identity, which is
    // a different guarantee with its own coverage.
    sourceType: "eval",
    harness: "claude-code",
    ...overrides,
  };
}

const BINDING = {
  sandboxRowId: "sbxrow_1",
  sandboxId: "e2b_ephemeral_1",
  workdir: "/home/user/work",
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 }))
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(startHarnessModelBroker).mockClear();
  vi.mocked(revokeHarnessModelBroker).mockClear();
  vi.mocked(resolveHarnessSandbox).mockClear();
  vi.mocked(createE2BHarnessSandboxProvider).mockClear();
  harnessState.started.mockClear();
  vi.mocked(reserveHarnessBox).mockClear();
  vi.mocked(renewHarnessBoxReservation).mockClear();
  vi.mocked(releaseHarnessBoxReservation).mockClear();
});

describe("runHarnessTurn — ephemeral sandbox binding (phase 6)", () => {
  it("streams request-bound startup phases as transient data outside model history", async () => {
    const requestId = "b19b8e67-f9a8-4d1f-9fce-7b6da581c041";
    const result = await runHarnessTurn(
      baseOptions({
        harnessSandboxBinding: BINDING,
        chatSessionId: "startup-chat",
        harnessStartupRequestId: requestId,
      }) as never,
      "ui",
    );
    expect(result.response).toBeDefined();
    const wire = await result.response!.text();
    const events = wire.split("\n")
      .filter(line => line.startsWith("data: {") && line.includes('"data-harness-startup"'))
      .map(line => JSON.parse(line.slice(6)));
    expect(events).toContainEqual({
      type: "data-harness-startup", transient: true,
      data: { phase: "preparing", chatSessionId: "startup-chat", requestId },
    });
    expect(events.every(event => event.transient === true &&
      event.data.requestId === requestId && event.data.chatSessionId === "startup-chat")).toBe(true);
    expect(JSON.stringify(result.messageHistory)).not.toContain("data-harness-startup");
  });

  it("runs on the given box and NEVER reaches the personal-computer reserve", async () => {
    await runHarnessTurn(
      baseOptions({ harnessSandboxBinding: BINDING }) as never,
      "none"
    );

    // THE assertion.
    expect(resolveHarnessSandbox).not.toHaveBeenCalled();

    // The runtime connects to the box we were handed, rooted at ITS workdir
    // (which the control plane resolved for this row) rather than the host
    // config's — same box, one source of truth.
    expect(createE2BHarnessSandboxProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "e2b_ephemeral_1",
        defaultWorkingDirectory: "/home/user/work",
      })
    );

    // The lease binds to the SANDBOX ROW, and no project travels — the backend
    // derives project + billing org from the row's run.
    const brokerArgs = vi.mocked(startHarnessModelBroker).mock.calls[0]![0];
    expect(brokerArgs.box).toEqual({
      kind: "sandbox",
      sandboxRowId: "sbxrow_1",
    });
    // Structural, not conditional: `projectId` is a field of the box union's
    // COMPUTER arm, so the sandbox arm has nowhere to put one.
    expect(brokerArgs.box).not.toHaveProperty("projectId");
  });

  it("keeps the PERSONAL path unchanged when no binding is given", async () => {
    await runHarnessTurn(
      baseOptions({ computerWorkdir: "/home/user/personal" }) as never,
      "none"
    );

    expect(resolveHarnessSandbox).toHaveBeenCalledTimes(1);
    expect(createE2BHarnessSandboxProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sandbox-1",
        defaultWorkingDirectory: "/home/user/personal",
      })
    );
    const brokerArgs = vi.mocked(startHarnessModelBroker).mock.calls[0]![0];
    expect(brokerArgs.box).toEqual({
      kind: "computer",
      computerId: "computer-1",
      projectId: "project-1",
    });
  });

  it("runs a binding WITH an execution scope on the box, and keeps the scope off the lease", async () => {
    // A scenario conversation's harness runs on its disposable box while the
    // scope still resolves its session lane and skills. The two must never meet
    // at the broker — the backend rejects a sandbox lease that carries a scope
    // — and they cannot: the scope rides only the `computer` arm of the box.
    await runHarnessTurn(
      baseOptions({
        harnessSandboxBinding: BINDING,
        executionScope: {
          kind: "swarm",
          swarmId: "cb_1",
          accessVersion: 1,
          projectId: "project-1",
          workspaceId: "ws_1",
        },
      }) as never,
      "none"
    );

    expect(resolveHarnessSandbox).not.toHaveBeenCalled();
    const brokerArgs = vi.mocked(startHarnessModelBroker).mock.calls[0]![0];
    expect(brokerArgs.box).toEqual({
      kind: "sandbox",
      sandboxRowId: BINDING.sandboxRowId,
    });
  });
});

describe("runHarnessTurn — a scenario harness never takes a persistent computer (5c)", () => {
  it("throws a typed 409 before reserving anything when a scenario scope has no box", async () => {
    const thrown = await runHarnessTurn(
      baseOptions({
        executionScope: {
          kind: "swarm",
          swarmId: "cb_1",
          accessVersion: 1,
          projectId: "project-1",
          workspaceId: "ws_1",
        },
      }) as never,
      "none"
    ).catch((error: unknown) => error);
    // A WebRouteError, so the route answers 409 and never a 500 INTERNAL_ERROR.
    expect(thrown).toBeInstanceOf(ScenarioHarnessRepublishRequiredError);
    expect(thrown).toMatchObject({
      status: 409,
      details: { reason: "SCENARIO_HARNESS_REPUBLISH_REQUIRED" },
    });
    expect(resolveHarnessSandbox).not.toHaveBeenCalled();
    expect(startHarnessModelBroker).not.toHaveBeenCalled();
  });
});

describe("runHarnessTurn — broker lease owns preparation", () => {
  it("starts the broker before bootstrapping without a separate reservation", async () => {
    await runHarnessTurn(baseOptions({ harnessSandboxBinding: BINDING }) as never, "none");
    expect(reserveHarnessBox).not.toHaveBeenCalled();
    expect(releaseHarnessBoxReservation).not.toHaveBeenCalled();
    expect(createE2BHarnessSandboxProvider).toHaveBeenCalledTimes(1);
    expect(vi.mocked(startHarnessModelBroker).mock.invocationCallOrder[0])
      .toBeLessThan(harnessState.started.mock.invocationCallOrder[0]!);
  });
  it("revokes the attempted lease when its start response is lost", async () => {
    vi.mocked(startHarnessModelBroker).mockResolvedValueOnce({
      ok: false, status: 502, error: "Failed to provision the harness network.",
    });
    const result = await runHarnessTurn(baseOptions({ harnessSandboxBinding: BINDING }) as never, "none");
    const runId = vi.mocked(startHarnessModelBroker).mock.calls[0]![0].runId;
    expect(runId).toBeTruthy();
    expect(revokeHarnessModelBroker).toHaveBeenCalledWith(expect.objectContaining({ runId }));
    expect(releaseHarnessBoxReservation).not.toHaveBeenCalled();
    expect(harnessState.started).not.toHaveBeenCalled();
    expect(result.aborted).toBe(false);
  });
  it.each([409, 404])("does not start the runtime when broker admission returns %s", async (status) => {
    vi.mocked(startHarnessModelBroker).mockResolvedValueOnce({
      ok: false, status, error: "The computer cannot admit this turn.",
    });
    const onEngineError = vi.fn();
    await runHarnessTurn(baseOptions({ harnessSandboxBinding: BINDING, onEngineError }) as never, "none");
    expect(onEngineError).toHaveBeenCalledTimes(1);
    expect(harnessState.started).not.toHaveBeenCalled();
    expect(reserveHarnessBox).not.toHaveBeenCalled();
    expect(releaseHarnessBoxReservation).not.toHaveBeenCalled();
  });
});

describe("runHarnessTurn — teardown is bounded", () => {
  it("returns even when the broker revoke never responds", async () => {
    // A stalled `/web/harness/model-broker/revoke` used to park this await
    // forever: the call site passed no signal, so `fetch` had no deadline. The
    // turn then never returns, which on the swarm surface means
    // `runSyntheticHostSession` never returns to the runner's per-attempt
    // `finally` — the disposable box is never released (paid until GC) and the
    // transcript and terminal attempt are never persisted. One slow dependency
    // silently eats a worker slot and loses the run's data.
    //
    // `.catch(() => {})` on that call does NOT cover it: it swallows
    // rejections, and a hang never rejects.
    //
    // The mock hangs FOREVER when given no signal and resolves when given one,
    // so without the fix this test fails by timing out rather than by
    // assertion — which is the honest reproduction of the bug.
    vi.mocked(revokeHarnessModelBroker).mockImplementation((async (args: {
      signal?: AbortSignal;
    }) => {
      if (!args.signal) return new Promise(() => {});
      return { ok: true };
    }) as never);

    await runHarnessTurn(
      baseOptions({ harnessSandboxBinding: BINDING }) as never,
      "none"
    );

    // It was called, and it was called WITH a deadline.
    const call = vi.mocked(revokeHarnessModelBroker).mock.calls[0]![0] as {
      signal?: AbortSignal;
    };
    expect(call.signal).toBeInstanceOf(AbortSignal);
  });

  it("bounds the session-state release on the terminal path too", async () => {
    // Same class, same path: the lane release runs in the turn's `finally` and
    // would hold it open just as effectively.
    const { releaseHarnessSessionState } = await import(
      "../harness-session-state.js"
    );
    await runHarnessTurn(
      baseOptions({
        harnessSandboxBinding: BINDING,
        // Continuity identity so the lane is claimed and a release is wired.
        chatSessionId: "cs-1",
        sourceType: "direct",
      }) as never,
      "none"
    );
    const releaseCalls = vi.mocked(releaseHarnessSessionState).mock.calls;
    // Only asserted when the turn actually took the release branch; when it
    // did, the call must carry a deadline.
    for (const [args] of releaseCalls) {
      expect((args as { signal?: AbortSignal }).signal).toBeInstanceOf(
        AbortSignal
      );
    }
  });
});

describe("runHarnessTurn — an approval answered after the scenario box was recycled", () => {
  async function answerApproval(paused: { computerId: string }) {
    const { claimHarnessSessionState } = await import(
      "../harness-session-state.js"
    );
    const { collectHarnessAgentToolApprovalContinuations } = await import(
      "@ai-sdk/harness/agent"
    );
    vi.mocked(collectHarnessAgentToolApprovalContinuations).mockReturnValueOnce(
      [{ approvalId: "approval-1", approved: true }] as never
    );
    vi.mocked(claimHarnessSessionState).mockResolvedValueOnce({
      ok: true,
      leaseId: "lease-1",
      stateVersion: 2,
      state: {
        harnessSessionId: "hs-1",
        resumeState: { data: { bridge: { sandboxId: BINDING.sandboxId } } },
        computerId: paused.computerId,
        awaitingApproval: true,
      },
      fingerprintChanged: false,
    } as never);
    const onEngineError = vi.fn();
    await runHarnessTurn(
      baseOptions({
        harnessSandboxBinding: BINDING,
        sourceType: "scenario",
        scenarioId: "cbx_1",
        chatSessionId: "cs-1",
        onEngineError,
      }) as never,
      "none"
    );
    return onEngineError;
  }

  it("says the conversation's computer was recycled, and to send the message again", async () => {
    // The turn paused on a box that idled out; this turn was given a new one.
    const onEngineError = await answerApproval({ computerId: "sbxrow_old" });
    expect(onEngineError).toHaveBeenCalledTimes(1);
    expect(onEngineError.mock.calls[0]![0].message).toBe(
      "This conversation's computer was recycled while waiting for your approval. Send your message again."
    );
  });

  it("resumes the paused turn when the box is the same one", async () => {
    const onEngineError = await answerApproval({
      computerId: BINDING.sandboxRowId,
    });
    expect(onEngineError).not.toHaveBeenCalled();
  });
});

describe("runHarnessTurn — a participant's broker refusal is participant-safe", () => {
  const SCOPE = {
    kind: "swarm",
    swarmId: "cb_1",
    accessVersion: 1,
    projectId: "project-1",
    workspaceId: "ws_1",
  };

  async function refusalMessage(
    refusal: { status: number; error: string; code?: string },
    overrides: Record<string, unknown>,
  ): Promise<string> {
    vi.mocked(startHarnessModelBroker).mockResolvedValueOnce({
      ok: false,
      ...refusal,
    });
    const onEngineError = vi.fn();
    await runHarnessTurn(
      baseOptions({
        harnessSandboxBinding: BINDING,
        executionScope: SCOPE,
        onEngineError,
        ...overrides,
      }) as never,
      "none",
    );
    expect(onEngineError).toHaveBeenCalledTimes(1);
    return onEngineError.mock.calls[0]![0].message;
  }

  it.each([
    [
      {
        status: 429,
        error: "Spending limit reached; add credits or retry later.",
      },
      "This study has reached its limit for now. Try again later.",
    ],
    [
      {
        status: 429,
        code: "spend_budget_reached",
        error:
          "This organization's spend budget is reached. An owner or admin can raise it in Organization → Budget.",
      },
      "This study has reached its limit for now. Try again later.",
    ],
    [
      {
        status: 429,
        error: "This share link has reached its concurrent harness run limit.",
      },
      "This study has reached its limit for now. Try again later.",
    ],
    [
      {
        status: 403,
        code: "free_tier_model_restricted",
        error:
          "This model is not included in the free daily allowance. Add credits or use your own API key (BYOK) to use it.",
      },
      "This study isn't set up correctly yet. Let the study owner know.",
    ],
  ])("maps %j for a participant", async (refusal, expected) => {
    expect(await refusalMessage(refusal, { scenarioParticipant: true })).toBe(
      expected,
    );
  });

  it("a member keeps the detailed copy", async () => {
    expect(
      await refusalMessage(
        {
          status: 429,
          error: "Spending limit reached; add credits or retry later.",
        },
        {},
      ),
    ).toBe("Spending limit reached; add credits or retry later.");
  });
});
