import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

const harnessState = vi.hoisted(() => ({
  streamParts: [] as Array<Record<string, unknown> & { type?: string }>,
  finalText: "",
  textError: undefined as unknown,
  streamError: undefined as unknown,
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
        for (const part of harnessState.streamParts) {
          yield part;
        }
        if (harnessState.streamError) throw harnessState.streamError;
      })(),
      text: harnessState.textError
        ? Promise.reject(harnessState.textError)
        : Promise.resolve(harnessState.finalText),
    }));
  },
  // WS3: no trailing tool-approval-response parts in these prompts.
  collectHarnessAgentToolApprovalContinuations: vi.fn(() => []),
}));

vi.mock("../registry.js", () => ({
  // Broker-only credential delivery (COMP-23): the turn builds dummy auth
  // pointed at the broker proxy; there is no per-adapter resolveAuth anymore.
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
  releaseHarnessBoxReservation: vi.fn(async () => ({ ok: true })),
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
import {
  HarnessSandboxResolutionError,
  resolveHarnessSandbox,
} from "../resolve-sandbox.js";
import { startHarnessModelBroker } from "../harness-model-broker.js";
import { classifyEvalInfraError } from "../../../services/evals/infra-error-classification";

/**
 * E1: a harness turn that dies must reach `onEngineError` with STRUCTURED
 * evidence from the producer that knew it — the Claude Code bridge's typed
 * error object, Codex's `codexErrorInfo` notification, or a typed setup step
 * — so the eval classifier never has to read the sentence.
 */
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

type EngineEvent = Record<string, unknown>;

async function runAndCapture(overrides: Record<string, unknown> = {}) {
  const events: EngineEvent[] = [];
  await runHarnessTurn(
    baseOptions({
      onEngineError: (event: EngineEvent) => events.push(event),
      ...overrides,
    }) as any,
    "none",
  );
  return events;
}

describe("runHarnessTurn — structured failure evidence (E1)", () => {
  beforeEach(() => {
    vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "true");
    harnessState.streamParts = [];
    harnessState.finalText = "";
    harnessState.textError = undefined;
    harnessState.streamError = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

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
      message: "API Error: 529 overloaded",
      phase: "stream",
      infraLayer: "model",
      code: "claude_code_server_error",
      httpStatus: 529,
    });
    // ...and the classifier excludes it.
    expect(
      classifyEvalInfraError({
        layer: event!.infraLayer as "model",
        code: event!.code as string,
        httpStatus: event!.httpStatus as number,
      }),
    ).toMatchObject({ class: "provider_unavailable" });
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
      infraLayer: "model",
      code: "codex_responseTooManyFailedAttempts",
      httpStatus: 429,
    });
  });

  const terminalCodexNotification = {
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
  };

  it("Codex: the notification also types a failure the stream iterator raises", async () => {
    harnessState.streamParts = [terminalCodexNotification];
    harnessState.streamError = new Error("stream closed");
    const [event] = await runAndCapture({ harness: "codex" });
    expect(event).toMatchObject({
      infraLayer: "model",
      code: "codex_responseTooManyFailedAttempts",
    });
  });

  it("Codex: the notification never types a LOCAL failure that follows it", async () => {
    // A local check throws inside the loop (an approval on a turn that cannot
    // pause): our failure, not the model's, whatever the runtime said before.
    harnessState.streamParts = [
      terminalCodexNotification,
      { type: "tool-approval-request", approvalId: "approval-1" },
    ];
    const [event] = await runAndCapture({ harness: "codex" });
    expect(event?.message).toMatch(/without a resumable harness session/);
    expect(event).not.toHaveProperty("infraLayer");
    expect(event).not.toHaveProperty("code");
  });

  it("an untyped bridge failure stays unclassified (no prose guessing)", async () => {
    harnessState.streamParts = [{ type: "finish", finishReason: "error" }];
    harnessState.textError = new Error("HTTP 503: provider request failed");
    const [event] = await runAndCapture();
    expect(event).toMatchObject({ phase: "stream" });
    expect(event).not.toHaveProperty("infraLayer");
    expect(event).not.toHaveProperty("httpStatus");
  });

  it("a sandbox that cannot be resolved is a typed SANDBOX setup failure", async () => {
    vi.mocked(resolveHarnessSandbox).mockRejectedValueOnce(
      new HarnessSandboxResolutionError("computer is not ready", 503),
    );
    const [event] = await runAndCapture();
    expect(event).toMatchObject({
      phase: "setup",
      infraLayer: "sandbox",
      code: "harness_sandbox_unavailable",
      httpStatus: 503,
    });
  });

  it("a broker lease that cannot be installed is a typed PLATFORM setup failure, never the model's", async () => {
    vi.mocked(startHarnessModelBroker).mockResolvedValueOnce({
      ok: false,
      status: 502,
      error: "Failed to reach harness model-broker endpoint",
    } as never);
    const [event] = await runAndCapture();
    expect(event).toMatchObject({
      phase: "setup",
      infraLayer: "platform",
      code: "harness_broker_unavailable",
      httpStatus: 502,
    });
  });
});
