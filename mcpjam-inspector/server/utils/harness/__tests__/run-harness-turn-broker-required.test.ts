import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

// COMP-23 regression: broker delivery is the ONLY credential path. With the
// kill switch off (MCPJAM_HARNESS_BROKER_DELIVERY=false) a harness turn must
// fail closed with an honest error — and under NO configuration may the turn
// reach for the retired raw-key endpoint (/web/harness/model-credential).

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
    supportsSelectedMcpServers: false,
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
  claudeCodeSafeSkills: vi.fn((skills) => skills),
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
  revokeHarnessModelBroker: vi.fn(async () => {}),
  startHarnessModelBroker: vi.fn(async () => ({
    ok: true,
    proxyBaseUrl: "https://broker.example",
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
    sourceType: "eval",
    harness: "claude-code",
    ...overrides,
  };
}

/** Global fetch spy — the deleted raw-key endpoint must never be contacted. */
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(startHarnessModelBroker).mockClear();
});

function modelCredentialCalls() {
  return fetchSpy.mock.calls.filter((call) =>
    String(call[0]).includes("model-credential")
  );
}

describe("runHarnessTurn broker-required (COMP-23)", () => {
  it("fails closed with an honest error when broker delivery is killed — no broker start, no raw-key fetch", async () => {
    vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "false");
    const onEngineError = vi.fn();
    const result = await runHarnessTurn(
      baseOptions({ onEngineError }) as never,
      "none"
    );

    expect(onEngineError).toHaveBeenCalledTimes(1);
    const err = onEngineError.mock.calls[0]![0] as { message: string };
    expect(err.message).toMatch(/broker credential delivery/i);
    expect(err.message).toMatch(/MCPJAM_HARNESS_BROKER_DELIVERY/);
    // Fail-closed means NO credential of any kind was pursued:
    expect(startHarnessModelBroker).not.toHaveBeenCalled();
    expect(modelCredentialCalls()).toHaveLength(0);
    expect(result.aborted).toBe(false);
  });

  it("a successful broker turn never contacts the retired /web/harness/model-credential endpoint", async () => {
    vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "true");
    const onEngineError = vi.fn();
    await runHarnessTurn(baseOptions({ onEngineError }) as never, "none");

    expect(onEngineError).not.toHaveBeenCalled();
    expect(startHarnessModelBroker).toHaveBeenCalledTimes(1);
    expect(modelCredentialCalls()).toHaveLength(0);
  });

  it("broker delivery defaults ON when the env var is unset", async () => {
    vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "");
    delete process.env.MCPJAM_HARNESS_BROKER_DELIVERY;
    const onEngineError = vi.fn();
    await runHarnessTurn(baseOptions({ onEngineError }) as never, "none");

    expect(onEngineError).not.toHaveBeenCalled();
    expect(startHarnessModelBroker).toHaveBeenCalledTimes(1);
  });
});
