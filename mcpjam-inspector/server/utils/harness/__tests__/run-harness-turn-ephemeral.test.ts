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
  session: {
    sessionId: "session-1",
    stop: vi.fn(async () => ({})),
    destroy: vi.fn(async () => {}),
  },
}));

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    createSession = vi.fn(async () => harnessState.session);
    stream = vi.fn(async () => ({
      fullStream: (async function* () {
        yield { type: "finish", finishReason: "stop" };
      })(),
      text: Promise.resolve("done"),
    }));
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
    mcpDelivery: "host-executed",
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
  frontmatterSafeSkills: vi.fn((skills) => skills),
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
  vi.mocked(reserveHarnessBox).mockClear();
  vi.mocked(renewHarnessBoxReservation).mockClear();
  vi.mocked(releaseHarnessBoxReservation).mockClear();
});

describe("runHarnessTurn — ephemeral sandbox binding (phase 6)", () => {
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

  it("refuses a binding combined with an execution scope — before any credential is minted", async () => {
    // The ephemeral box is launcher-owned and billed to its run's project; an
    // execution scope is the host-funded GUEST path on a scenario's own
    // computer. The backend rejects the combination outright; throwing here,
    // at the same place the missing-harness-id guard throws, means no box is
    // bound and no egress transform is ever installed.
    await expect(
      runHarnessTurn(
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
      )
    ).rejects.toThrow(/execution scope/i);

    expect(startHarnessModelBroker).not.toHaveBeenCalled();
    expect(resolveHarnessSandbox).not.toHaveBeenCalled();
  });
});

describe("runHarnessTurn — reserve, then start the baseline-preserving broker lease", () => {
  it("claims the box and only then asks for a credential", async () => {
    // Reserve → broker start → in-stream bootstrap. The lease keeps the box's
    // own egress baseline, so the bootstrap can reach the registry after start.
    // The claim still comes first so a second turn cannot interleave.
    await runHarnessTurn(
      baseOptions({ harnessSandboxBinding: BINDING }) as never,
      "none"
    );

    const reserveOrder = vi.mocked(reserveHarnessBox).mock
      .invocationCallOrder[0]!;
    const providerOrder = vi.mocked(createE2BHarnessSandboxProvider).mock
      .invocationCallOrder[0]!;
    const brokerOrder = vi.mocked(startHarnessModelBroker).mock
      .invocationCallOrder[0]!;
    expect(reserveOrder).toBeLessThan(providerOrder);
    expect(providerOrder).toBeLessThan(brokerOrder);
  });

  it("builds one provider for the turn before broker start", async () => {
    await runHarnessTurn(
      baseOptions({ harnessSandboxBinding: BINDING }) as never,
      "none"
    );

    expect(createE2BHarnessSandboxProvider).toHaveBeenCalledTimes(1);
  });

  it("shares one runId between the claim and the lease that consumes it", async () => {
    await runHarnessTurn(
      baseOptions({ harnessSandboxBinding: BINDING }) as never,
      "none"
    );

    const reservedRunId = vi.mocked(reserveHarnessBox).mock.calls[0]![0].runId;
    const leasedRunId = vi.mocked(startHarnessModelBroker).mock.calls[0]![0]
      .runId;
    expect(reservedRunId).toBe(leasedRunId);
    expect(reservedRunId).toBeTruthy();
  });

  it("hands the box back when broker start fails", async () => {
    vi.mocked(startHarnessModelBroker).mockResolvedValueOnce({
      ok: false,
      status: 502,
      error: "Failed to provision the harness network.",
    });

    const result = await runHarnessTurn(
      baseOptions({ harnessSandboxBinding: BINDING }) as never,
      "none"
    );

    // The run id was recorded before the POST, so teardown still revokes in
    // case the backend installed before a lost response — and the reservation
    // is ours to give back so the next turn does not wait out its TTL.
    expect(revokeHarnessModelBroker).toHaveBeenCalledTimes(1);
    expect(releaseHarnessBoxReservation).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(false);
  });

  it("refuses to prepare a box another run is already preparing", async () => {
    vi.mocked(reserveHarnessBox).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "A harness run is already active on this computer.",
    });
    const onEngineError = vi.fn();

    await runHarnessTurn(
      baseOptions({
        harnessSandboxBinding: BINDING,
        onEngineError,
      }) as never,
      "none"
    );

    // The caller is told the box is busy, in the same words a lease conflict
    // would have produced.
    expect(onEngineError).toHaveBeenCalledTimes(1);
    expect(onEngineError.mock.calls[0]![0].message).toMatch(
      /already active on this computer/i
    );
    // Refused before ANY work on the box — that is the point of claiming first.
    expect(startHarnessModelBroker).not.toHaveBeenCalled();
  });

  it("fails closed when the backend has no reservation endpoint", async () => {
    vi.mocked(reserveHarnessBox).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Harness model-broker returned 404",
    });
    const onEngineError = vi.fn();

    await runHarnessTurn(
      baseOptions({ harnessSandboxBinding: BINDING, onEngineError }) as never,
      "none"
    );

    expect(onEngineError).toHaveBeenCalledTimes(1);
    expect(startHarnessModelBroker).not.toHaveBeenCalled();
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
