import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

const harnessState = vi.hoisted(() => ({
  streamParts: [] as Array<Record<string, unknown> & { type?: string }>,
  finalText: "",
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
      })(),
      text: Promise.resolve(harnessState.finalText),
    }));
  },
  // WS3: no trailing tool-approval-response parts in these prompts.
  collectHarnessAgentToolApprovalContinuations: vi.fn(() => []),
}));

vi.mock("../registry.js", () => ({
  buildBrokerDummyAuth: vi.fn(),
  getHarnessAdapter: vi.fn(() => ({
    id: "claude-code",
    displayName: "Claude Code",
    defaultPermissionMode: "allow-all",
    supportsSkills: false,
    supportsSelectedMcpServers: false,
    supportsModel: vi.fn(() => true),
    resolveAuth: vi.fn(async () => ({ gateway: { apiKey: "key" } })),
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

import {
  HARNESS_EMPTY_VISIBLE_OUTPUT_TEXT,
  runHarnessTurn,
} from "../run-harness-turn";

function baseOptions(overrides: Record<string, unknown> = {}) {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "create a file called empty.txt" }],
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

describe("runHarnessTurn empty output projection", () => {
  beforeEach(() => {
    harnessState.streamParts = [];
    harnessState.finalText = "";
    harnessState.session.stop.mockClear();
    harnessState.session.destroy.mockClear();
  });

  it("persists a visible assistant fallback when the harness finishes with no renderable parts", async () => {
    harnessState.streamParts = [
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
      },
    ];

    const result = await runHarnessTurn(baseOptions() as any, "none");

    expect(result.messageHistory.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: HARNESS_EMPTY_VISIBLE_OUTPUT_TEXT }],
    });
  });

  it("uses authoritative final text instead of the empty-output fallback", async () => {
    harnessState.streamParts = [{ type: "finish", finishReason: "stop" }];
    harnessState.finalText = "Created empty.txt";

    const result = await runHarnessTurn(baseOptions() as any, "none");

    expect(result.messageHistory.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Created empty.txt" }],
    });
  });

  it("treats a whitespace-only final text as non-visible and still falls back", async () => {
    harnessState.streamParts = [{ type: "finish", finishReason: "stop" }];
    harnessState.finalText = "   \n  ";

    const result = await runHarnessTurn(baseOptions() as any, "none");

    expect(result.messageHistory.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: HARNESS_EMPTY_VISIBLE_OUTPUT_TEXT }],
    });
  });

  it("treats a whitespace-only streamed text-delta as non-visible and still falls back", async () => {
    harnessState.streamParts = [
      { type: "text-delta", delta: " \n " },
      { type: "finish", finishReason: "stop" },
    ];
    harnessState.finalText = "";

    const result = await runHarnessTurn(baseOptions() as any, "none");

    const lastMessage = result.messageHistory.at(-1) as {
      role: string;
      content: Array<{ type: string; text: string }>;
    };
    expect(lastMessage.role).toBe("assistant");
    // The empty-output fallback appends onto the same open text part (it's
    // what the harness actually said, plus the fallback notice) rather than
    // being dropped for having "already produced text" — whitespace alone
    // must not satisfy the "visible part" check.
    expect(lastMessage.content[0]).toMatchObject({
      type: "text",
      text: " \n " + HARNESS_EMPTY_VISIBLE_OUTPUT_TEXT,
    });
  });
});
