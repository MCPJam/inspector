/**
 * What a harness turn shows of its work beyond text and tool cards: Codex's
 * plan (`turn/plan/updated`) as one checklist part replaced in place, a
 * running command's output live (`item/commandExecution/outputDelta`), and a
 * failed built-in call settling its card as failed instead of "running".
 * None of it reaches the transcript.
 *
 * The module mocks are the ones `run-harness-turn-background-drain.test.ts`
 * drives a turn with; the stream is scripted per test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

const harnessState = vi.hoisted(() => ({
  native: false,
  readNativeResult: vi.fn(async () => ({
    content: [{ type: "text", text: "original MCP result" }],
    structuredContent: { value: 7 },
  })),
  // Each entry is a part, or a function run at that point (to fire a Stop).
  script: [] as Array<
    (Record<string, unknown> & { type?: string }) | (() => void | Promise<void>)
  >,
  finalText: "" as string | Error,
  claimedState: null as unknown,
  session: {
    sessionId: "harness-session-0",
    stop: vi.fn(async () => ({})),
    destroy: vi.fn(async () => {}),
    detach: vi.fn(async () => ({ type: "resume-session" })),
  },
}));

vi.mock("@ai-sdk/harness/agent", () => ({
  HarnessAgent: class {
    createSession = vi.fn(async () => harnessState.session);
    stream = vi.fn(async () => {
      const text =
        harnessState.finalText instanceof Error
          ? Promise.reject(harnessState.finalText)
          : Promise.resolve(harnessState.finalText);
      text.catch(() => {});
      return {
        fullStream: (async function* () {
          for (const step of harnessState.script) {
            if (typeof step === "function") await step();
            else yield step;
          }
        })(),
        text,
      };
    });
    continueStream = this.stream;
  },
  collectHarnessAgentToolApprovalContinuations: vi.fn(() => []),
}));

vi.mock("../registry.js", async () => {
  const { parseHarnessToolName } =
    await vi.importActual<typeof import("../mcp-config.js")>(
      "../mcp-config.js",
    );
  return {
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
      mcpDelivery: harnessState.native ? "harness" : "mcpjam",
      supportsModel: vi.fn(() => true),
      createHarness: vi.fn(() => ({ harnessId: "claude-code" })),
      parseToolName: parseHarnessToolName,
    })),
  };
});

vi.mock("../forwarding/native-turn.js", async (original) => ({
  ...(await original<typeof import("../forwarding/native-turn.js")>()),
  hasForwardingOrganization: () => true,
  nativeForwardingSelection: () => ({
    harnessSessionId: "lane",
    hostId: "host",
    servers: [{ serverId: "server-1" }],
  }),
  prepareNativeForwarding: async () => ({
    mcpJson: {
      mcpServers: {
        native_server: { type: "http", url: "https://forward.example/mcp" },
      },
    },
    keyToServerId: { native_server: "server-1" },
    policyDigest: "a".repeat(64),
    logScopeIds: {},
    readToolResult: harnessState.readNativeResult,
    isForwardedTool: () => true,
    stop: async () => {},
  }),
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
      state: harnessState.claimedState,
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
    forwarding: { owners: [], origin: "https://forward.example" },
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

function options(overrides: Record<string, unknown> = {}) {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "plan it in the background" }],
    } as unknown as ModelMessage,
  ];
  return {
    messages,
    modelId: "anthropic/claude-sonnet-4-6",
    provider: "anthropic",
    systemPrompt: "You are Claude Code.",
    authHeader: "Bearer test",
    projectId: "project-1",
    chatSessionId: "chat-1",
    mcpClientManager: { getServerConfig: vi.fn() },
    selectedServers: [],
    requireToolApproval: false,
    sourceType: "direct",
    harness: "claude-code",
    ...overrides,
  };
}

function sseChunks(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

const notification = (method: string, params: Record<string, unknown>) => ({
  type: "raw",
  rawValue: { method, params },
});
const plan = (statuses: string[]) =>
  notification("turn/plan/updated", {
    threadId: "thread-1",
    turnId: "turn-1",
    explanation: "the plan",
    plan: statuses.map((status, i) => ({ step: `step ${i + 1}`, status })),
  });
const outputDelta = (delta: string, itemId = "call_1") =>
  notification("item/commandExecution/outputDelta", {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
    delta,
  });
const toolCall = (toolCallId: string) => ({
  type: "tool-call",
  toolCallId,
  toolName: "bash",
  input: { command: "cat missing.txt" },
});

describe("runHarnessTurn activity", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token-with-enough-length");
    harnessState.script = [];
    harnessState.finalText = "";
    harnessState.native = false;
    harnessState.readNativeResult.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([false, true])(
    "hydrates the native result without changing the model result, error=%s",
    async (isError) => {
      vi.stubEnv("HARNESS_NATIVE_FORWARDING", "true");
      harnessState.native = true;
      const rawResult = {
        content: [{ type: "text", text: "original MCP result" }],
        structuredContent: { value: 7 },
        ...(isError ? { isError: true } : {}),
      };
      harnessState.readNativeResult.mockResolvedValueOnce(rawResult);
      harnessState.script = [
        {
          type: "tool-call",
          toolCallId: "native-call",
          toolName: "mcp__native_server__read",
          input: {},
        },
        {
          type: isError ? "tool-error" : "tool-result",
          toolCallId: "native-call",
          toolName: "mcp__native_server__read",
          ...(isError
            ? { error: "Claude projection" }
            : { output: "Claude projection" }),
        },
        { type: "text-delta", delta: "Done." },
        { type: "finish", finishReason: "stop" },
      ];
      harnessState.finalText = "Done.";
      const onToolResult = vi.fn();
      const result = await runHarnessTurn(
        options({
          hostId: "host",
          selectedServers: ["server-1"],
          respectToolVisibility: false,
          mcpClientManager: {
            getServerConfig: () => ({ url: "https://mcp.example/mcp", clientCapabilities: {} }),
            getInitializationInfo: () => ({ transport: "streamable-http", protocolVersion: "2025-11-25", clientCapabilities: {} }),
          },
          harnessMcpProxy: { plane: "web-authorized", mode: "relay" },
          onToolResult,
        }) as Parameters<typeof runHarnessTurn>[0],
        "ui",
      );
      const chunks = sseChunks(await result.response!.text());
      expect(harnessState.readNativeResult).toHaveBeenCalledWith(
        "server-1",
        "native-call",
      );
      expect(chunks).toContainEqual(
        expect.objectContaining({
          type: "tool-output-available",
          toolCallId: "native-call",
          output: rawResult,
        }),
      );
      expect(onToolResult).toHaveBeenCalledWith(
        expect.objectContaining({
          serverId: "server-1",
          toolCallId: "native-call",
          output: "Claude projection",
          isError,
          rawResult,
        }),
      );
      expect(JSON.stringify(result.messageHistory)).toContain(
        "Claude projection",
      );
      expect(JSON.stringify(result.messageHistory)).not.toContain(
        "original MCP result",
      );
    },
  );

  it("streams Codex's plan as one checklist part, updated in place", async () => {
    harnessState.script = [
      plan(["inProgress", "pending"]),
      { type: "text-delta", delta: "Working." },
      plan(["completed", "inProgress"]),
      { type: "finish", finishReason: "stop" },
    ];
    harnessState.finalText = "Working.";

    const result = await runHarnessTurn(options() as any, "ui");
    const chunks = sseChunks(await result.response!.text());
    const plans = chunks.filter((chunk) => chunk.type === "data-harness-plan");
    expect(plans).toHaveLength(2);
    // Same id: the client replaces the part rather than adding a second one.
    expect(new Set(plans.map((chunk) => chunk.id))).toEqual(
      new Set(["harness-plan-turn-1"]),
    );
    expect(plans.every((chunk) => chunk.transient === undefined)).toBe(true);
    expect(plans[1]!.data).toEqual({
      explanation: "the plan",
      steps: [
        { step: "step 1", status: "completed" },
        { step: "step 2", status: "inProgress" },
      ],
    });
    // The plan never splits the answer or enters the transcript.
    expect(chunks.filter((chunk) => chunk.type === "text-start")).toHaveLength(
      1,
    );
    expect(JSON.stringify(result.messageHistory)).not.toContain("step 1");
  });

  it("streams a running command's output live, bounded per command", async () => {
    harnessState.script = [
      outputDelta("one\n"),
      // Each delta is cut to 4 KiB; 17 of them pass the 64 KiB per command.
      ...Array.from({ length: 17 }, () => outputDelta("x".repeat(8 * 1024))),
      outputDelta("never sent"),
      outputDelta("other\n", "call_2"),
      { type: "finish", finishReason: "stop" },
    ];

    const result = await runHarnessTurn(options() as any, "ui");
    const chunks = sseChunks(await result.response!.text());
    const outputs = chunks.filter(
      (chunk) => chunk.type === "data-harness-tool-output",
    );
    expect(outputs.every((chunk) => chunk.transient === true)).toBe(true);
    const sent = (id: string) =>
      outputs
        .map((chunk) => chunk.data as { toolCallId: string; delta: string })
        .filter((data) => data.toolCallId === id)
        .map((data) => data.delta)
        .join("");
    expect(sent("call_1").startsWith("one\n")).toBe(true);
    expect(sent("call_1").length).toBeLessThanOrEqual(64 * 1024);
    expect(sent("call_1")).not.toContain("never sent");
    expect(sent("call_2")).toBe("other\n");
  });

  it("a failed built-in call settles its card as failed, with its output", async () => {
    const onToolResult = vi.fn();
    harnessState.script = [
      toolCall("call_1"),
      {
        type: "tool-error",
        toolCallId: "call_1",
        toolName: "bash",
        error: {
          status: "failed",
          exitCode: 1,
          output: "cat: missing.txt: No such file or directory\n",
        },
      },
      // A failure for a call the UI never saw adds nothing.
      {
        type: "tool-error",
        toolCallId: "unseen",
        toolName: "bash",
        error: "x",
      },
      { type: "text-delta", delta: "It is missing." },
      { type: "finish", finishReason: "stop" },
    ];
    harnessState.finalText = "It is missing.";

    const result = await runHarnessTurn(options({ onToolResult }) as any, "ui");
    const chunks = sseChunks(await result.response!.text());
    const errors = chunks.filter((chunk) => chunk.type === "tool-output-error");
    expect(errors).toEqual([
      expect.objectContaining({
        type: "tool-output-error",
        toolCallId: "call_1",
        errorText: "Exit code 1\ncat: missing.txt: No such file or directory",
        providerExecuted: true,
      }),
    ]);
    expect(onToolResult).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: "call_1",
        isError: true,
        output: "Exit code 1\ncat: missing.txt: No such file or directory",
      }),
    );
    expect(JSON.stringify(result.messageHistory)).toContain("cat: missing.txt");
    expect(onToolResult).toHaveBeenCalledTimes(1);
  });

  it("persists a resumed tool failure once when the call came from history", async () => {
    const onToolResult = vi.fn();
    const failure = {
      type: "tool-error",
      toolCallId: "prior-call",
      error: "sandbox failed",
    };
    harnessState.script = [
      failure,
      failure,
      { type: "text-delta", delta: "Failed." },
    ];
    harnessState.finalText = "Failed.";
    const result = await runHarnessTurn(
      options({
        onToolResult,
        messages: [
          { role: "user", content: "Run it" },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: "prior-call",
                toolName: "Bash",
                input: { command: "pwd" },
              },
            ],
          },
        ],
      }) as any,
      "ui",
    );
    const chunks = sseChunks(await result.response!.text());
    expect(
      chunks.filter((chunk) => chunk.type === "tool-output-error"),
    ).toHaveLength(1);
    expect(onToolResult).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        toolCallId: "prior-call",
        toolName: "Bash",
        isError: true,
        output: "sandbox failed",
      }),
    );
    expect(JSON.stringify(result.messageHistory)).toContain("sandbox failed");
  });
});
