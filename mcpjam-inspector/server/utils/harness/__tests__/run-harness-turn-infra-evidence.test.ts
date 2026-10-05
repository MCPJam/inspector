import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

/**
 * A harness turn that dies must reach `onEngineError` with STRUCTURED evidence
 * from the producer that knew it — the Claude Code bridge's typed error
 * object, Codex's `codexErrorInfo` notification, or a typed setup step — so
 * the eval classifier never has to read the sentence.
 */

const harnessState = vi.hoisted(() => ({
  streamParts: [] as Array<Record<string, unknown> & { type?: string }>,
  finalText: "",
  textError: undefined as unknown,
  createSessionError: undefined as unknown,
  session: {
    sessionId: "session-1",
    stop: vi.fn(async () => ({})),
    destroy: vi.fn(async () => {}),
  },
}));

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    createSession = vi.fn(async () => {
      if (harnessState.createSessionError) {
        throw harnessState.createSessionError;
      }
      return harnessState.session;
    });
    stream = vi.fn(async () => ({
      fullStream: (async function* () {
        for (const part of harnessState.streamParts) {
          yield part;
        }
      })(),
      text: harnessState.textError
        ? Promise.reject(harnessState.textError)
        : Promise.resolve(harnessState.finalText),
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

vi.mock("../resolve-sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../resolve-sandbox.js")>();
  return {
    ...actual,
    resolveHarnessSandbox: vi.fn(async () => ({
      computerId: "computer-1",
      sandboxId: "sandbox-1",
    })),
  };
});

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
  const actual =
    await importOriginal<typeof import("../harness-session-state.js")>();
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
import { HarnessInfraSetupError } from "../harness-provider-error";
import {
  HarnessSandboxResolutionError,
  resolveHarnessSandbox,
} from "../resolve-sandbox.js";
import {
  reserveHarnessBox,
  startHarnessModelBroker,
} from "../harness-model-broker.js";
import type { MCPJamEngineErrorEvent } from "../../mcpjam-stream-handler";
import { classifyEvalInfraError } from "../../../services/evals/infra-error-classification";

function baseOptions(overrides: Record<string, unknown> = {}) {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "do the thing" }],
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

async function runAndCapture(overrides: Record<string, unknown> = {}) {
  const events: MCPJamEngineErrorEvent[] = [];
  await runHarnessTurn(
    baseOptions({
      onEngineError: (event: MCPJamEngineErrorEvent) => events.push(event),
      ...overrides,
    }) as never,
    "none",
  );
  return events;
}

beforeEach(() => {
  vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "true");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 200 })),
  );
  harnessState.streamParts = [];
  harnessState.finalText = "";
  harnessState.textError = undefined;
  harnessState.createSessionError = undefined;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("runHarnessTurn — structured failure evidence", () => {
  it("Claude Code: the bridge's typed provider error reaches onEngineError as fields", async () => {
    harnessState.streamParts = [{ type: "finish", finishReason: "error" }];
    harnessState.textError = {
      name: "HarnessProviderError",
      message: "API Error: 529 overloaded",
      source: "model",
      code: "claude_code_server_error",
      httpStatus: 529,
    };
    const [event] = await runAndCapture();
    expect(event).toMatchObject({
      // The sentence, not "[object Object]".
      message: "API Error: 529 overloaded",
      phase: "stream",
      infra: {
        source: "harness_runtime",
        code: "claude_code_server_error",
        httpStatus: 529,
        // The broker lease: MCPJam's own model proxy.
        endpoint: "platform",
      },
    });
    expect(classifyEvalInfraError(event!.infra)).toMatchObject({
      class: "provider_unavailable",
      layer: "model",
    });
  });

  it("Codex: a terminal codexErrorInfo notification types an otherwise-bare failure", async () => {
    harnessState.streamParts = [
      {
        type: "raw",
        rawValue: {
          method: "error",
          params: {
            error: {
              message: "exceeded retry limit",
              codexErrorInfo: {
                responseTooManyFailedAttempts: { httpStatusCode: 429 },
              },
            },
            willRetry: false,
          },
        },
      },
    ];
    // The bridge's own error stays the bare sentence it always was.
    harnessState.textError = "exceeded retry limit";
    const [event] = await runAndCapture({ harness: "codex" });
    expect(event).toMatchObject({
      message: "exceeded retry limit",
      infra: {
        source: "harness_runtime",
        code: "codex_responseTooManyFailedAttempts",
        httpStatus: 429,
      },
    });
    expect(classifyEvalInfraError(event!.infra)).toMatchObject({
      class: "rate_limited",
    });
  });

  it("an untyped bridge failure stays unclassified (no prose guessing)", async () => {
    harnessState.streamParts = [{ type: "finish", finishReason: "error" }];
    harnessState.textError = new Error("HTTP 503: provider request failed");
    const [event] = await runAndCapture();
    expect(event).toMatchObject({ phase: "stream" });
    expect(event).not.toHaveProperty("infra");
  });

  it("a sandbox that cannot be resolved is a typed SANDBOX setup failure", async () => {
    vi.mocked(resolveHarnessSandbox).mockRejectedValueOnce(
      new HarnessSandboxResolutionError("computer is not ready", 503),
    );
    const [event] = await runAndCapture();
    expect(event).toMatchObject({
      phase: "setup",
      infra: {
        source: "sandbox_setup",
        code: "harness_sandbox_unavailable",
        httpStatus: 503,
      },
    });
    expect(classifyEvalInfraError(event!.infra)).toMatchObject({
      class: "sandbox",
      layer: "sandbox",
    });
  });

  it("a box that cannot be reserved is a typed SANDBOX setup failure", async () => {
    vi.mocked(reserveHarnessBox).mockResolvedValueOnce({
      ok: false,
      status: 409,
      error: "box is busy",
    });
    const [event] = await runAndCapture();
    expect(event).toMatchObject({
      phase: "setup",
      message: "box is busy",
      infra: {
        source: "sandbox_setup",
        code: "harness_box_reservation_failed",
        httpStatus: 409,
      },
    });
  });

  it("a broker lease that cannot be installed is a PLATFORM failure, never the model's", async () => {
    vi.mocked(startHarnessModelBroker).mockResolvedValueOnce({
      ok: false,
      status: 502,
      error: "Failed to reach harness model-broker endpoint",
    });
    const [event] = await runAndCapture();
    expect(event).toMatchObject({
      phase: "setup",
      infra: {
        source: "platform_setup",
        code: "harness_broker_unavailable",
        httpStatus: 502,
      },
    });
    expect(classifyEvalInfraError(event!.infra)).toMatchObject({
      class: "sandbox",
      layer: "platform",
    });
  });

  it("the broker's own code rides along, so a billing refusal is an account limit", async () => {
    vi.mocked(startHarnessModelBroker).mockResolvedValueOnce({
      ok: false,
      status: 429,
      error: "Spend budget reached",
      code: "spend_budget_reached",
    });
    const [event] = await runAndCapture();
    expect(event?.infra).toEqual({
      source: "platform_setup",
      code: "spend_budget_reached",
      httpStatus: 429,
    });
    expect(classifyEvalInfraError(event!.infra)).toMatchObject({
      class: "account_limit",
    });
  });
  it("a broker that says the box is gone (404 sandbox_not_found) is a SANDBOX failure", async () => {
    vi.mocked(startHarnessModelBroker).mockResolvedValueOnce({
      ok: false,
      status: 404,
      error: "Sandbox not found",
      code: "sandbox_not_found",
    });
    const [event] = await runAndCapture();
    expect(event?.infra).toEqual({
      source: "platform_setup",
      code: "sandbox_not_found",
      httpStatus: 404,
    });
    expect(classifyEvalInfraError(event!.infra)).toMatchObject({
      class: "sandbox",
      layer: "sandbox",
      retryable: false,
    });
  });

  it("a box the vendor no longer has, seen at connect, reaches onEngineError typed", async () => {
    // What `e2b-sandbox-provider.ts` throws for the SDK's SandboxNotFoundError.
    harnessState.createSessionError = new HarnessInfraSetupError(
      "Sandbox sandbox-1 not found",
      { source: "sandbox_setup", code: "sandbox_not_found" },
    );
    const [event] = await runAndCapture();
    expect(event).toMatchObject({
      phase: "setup",
      message: "Sandbox sandbox-1 not found",
      infra: { source: "sandbox_setup", code: "sandbox_not_found" },
    });
    expect(classifyEvalInfraError(event!.infra)).toMatchObject({
      class: "sandbox",
      layer: "sandbox",
    });
  });
});
