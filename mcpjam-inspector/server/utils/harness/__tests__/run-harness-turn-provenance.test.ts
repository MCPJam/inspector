/**
 * A harness turn signs what it streams (MJ-009), as the emulated engine's
 * turns do, so its replies verify when the conversation continues on
 * another engine. The module mocks are the ones
 * `run-harness-turn-empty-output.test.ts` drives a turn with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";
import { runHarnessTurn } from "../run-harness-turn";
import {
  historyProvenanceContextFor,
  verifyAssistantText,
  verifyClientHistory,
} from "../../history-provenance";

function baseOptions() {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "create a file called notes.txt" }],
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
    sourceType: "direct",
    harness: "claude-code",
  };
}

async function streamedChunks(response: Response): Promise<any[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

async function browserMessageFrom(chunks: any[]): Promise<UIMessage> {
  const stream = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream })) last = message;
  if (!last) throw new Error("no message");
  return JSON.parse(JSON.stringify(last));
}

describe("runHarnessTurn history provenance (MJ-009)", () => {
  beforeEach(() => {
    vi.stubEnv("MCPJAM_HARNESS_BROKER_DELIVERY", "true");
    harnessState.streamParts = [
      { type: "text-delta", delta: "Created " },
      { type: "text-delta", delta: "notes.txt." },
      { type: "finish", finishReason: "stop" },
    ];
    harnessState.finalText = "Created notes.txt.";
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("signs the text it streams in hosted mode", async () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token-with-enough-length");

    const result = await runHarnessTurn(baseOptions() as any, "ui");
    const chunks = await streamedChunks(result.response!);

    const ctx = historyProvenanceContextFor("project-1")!;
    const end = chunks.find((chunk) => chunk.type === "text-end");
    expect(
      verifyAssistantText(
        ctx,
        "Created notes.txt.",
        end.providerMetadata.mcpjam.textSig,
      ),
    ).toBe(true);
    const message = await browserMessageFrom(chunks);
    expect(verifyClientHistory([message], ctx).unverifiedTextParts).toBe(0);
  });

  it("signs nothing in local mode", async () => {
    const result = await runHarnessTurn(baseOptions() as any, "ui");
    const chunks = await streamedChunks(result.response!);
    const text = chunks.filter((chunk) =>
      String(chunk.type).startsWith("text"),
    );
    expect(text.length).toBeGreaterThan(0);
    for (const chunk of text) {
      expect(chunk.providerMetadata?.mcpjam?.textSig).toBeUndefined();
    }
  });
});
