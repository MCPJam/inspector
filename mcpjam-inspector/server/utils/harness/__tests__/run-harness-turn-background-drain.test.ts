/**
 * The server side of the Claude Code background drain
 * (`claude-code-background-drain.ts`): the bridge's `raw` drain parts become
 * transient `data-harness-background-task` chunks, a background agent's
 * follow-up is its own text part, and a Stop that lands while the bridge is
 * only WAITING ends the wait and keeps the delivered answer.
 *
 * The module mocks are the ones `run-harness-turn-hosted-resume.test.ts`
 * drives a turn with; the stream is scripted per test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";

const harnessState = vi.hoisted(() => ({
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
import { getHarnessAdapter } from "../registry.js";

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

const task = (status: string) => ({
  type: "raw",
  rawValue: {
    mcpjam: "background-task",
    taskId: "agent-1",
    toolUseId: "toolu_1",
    status,
    description: "plan 1",
    subagentType: "general-purpose",
    taskType: "local_agent",
  },
});
const notice = (reason: string) => ({
  type: "raw",
  rawValue: { mcpjam: "drain-notice", reason },
});

/** The bridge's shape for one background agent, answer then follow-up. */
const drainedTurn = [
  { type: "text-delta", delta: "I started the plan." },
  task("running"),
  notice("draining"),
  task("completed"),
  { type: "text-delta", delta: "Here is the plan." },
  { type: "finish", finishReason: "stop" },
];

function sseChunks(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

function assistantTexts(messageHistory: ModelMessage[]): string[] {
  return messageHistory
    .filter((message) => message.role === "assistant")
    .flatMap((message) =>
      (message.content as Array<{ type: string; text?: string }>)
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? ""),
    );
}

describe("runHarnessTurn background drain", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token-with-enough-length");
    harnessState.script = [];
    harnessState.finalText = "";
    harnessState.session.stop.mockClear();
    harnessState.session.destroy.mockClear();
    harnessState.session.detach.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("hands the harness the turn's permission mode, which decides background tasks", async () => {
    harnessState.script = [
      { type: "text-delta", delta: "hi" },
      { type: "finish", finishReason: "stop" },
    ];
    harnessState.finalText = "hi";

    const result = await runHarnessTurn(options() as any, "none");
    await result.response?.text();

    const createHarnessCalls = vi
      .mocked(getHarnessAdapter)
      .mock.results.flatMap(
        (adapter) =>
          (adapter.value as { createHarness: ReturnType<typeof vi.fn> })
            .createHarness.mock.calls,
      );
    expect(createHarnessCalls.at(-1)![0]).toMatchObject({
      permissionMode: "allow-all",
    });
  });

  it("streams drain parts as transient background-task chunks", async () => {
    harnessState.script = drainedTurn;
    harnessState.finalText = "I started the plan.Here is the plan.";

    const result = await runHarnessTurn(options() as any, "ui");
    const chunks = sseChunks(await result.response!.text());
    const background = chunks.filter(
      (chunk) => chunk.type === "data-harness-background-task",
    );
    expect(background.map((chunk) => chunk.data)).toEqual([
      {
        kind: "task",
        taskId: "agent-1",
        toolUseId: "toolu_1",
        status: "running",
        description: "plan 1",
        subagentType: "general-purpose",
        taskType: "local_agent",
      },
      { kind: "notice", reason: "draining" },
      expect.objectContaining({ kind: "task", status: "completed" }),
    ]);
    expect(background.every((chunk) => chunk.transient === true)).toBe(true);
  });

  it("streams a subagent's steps as transient chunks, never text or transcript", async () => {
    const step = (rawValue: Record<string, unknown>) => ({
      type: "raw",
      rawValue: {
        mcpjam: "subagent-step",
        rootToolUseId: "toolu_agent",
        parentToolUseId: "toolu_agent",
        toolUseId: "toolu_read",
        ...rawValue,
      },
    });
    harnessState.script = [
      { type: "text-delta", delta: "Planning " },
      step({
        kind: "tool-call",
        toolName: "Read",
        input: { file_path: "/work/README.md" },
      }),
      step({ kind: "tool-result", isError: false }),
      { type: "text-delta", delta: "done." },
      { type: "finish", finishReason: "stop" },
    ];
    harnessState.finalText = "Planning done.";

    const result = await runHarnessTurn(options() as any, "ui");
    const chunks = sseChunks(await result.response!.text());
    const steps = chunks.filter(
      (chunk) => chunk.type === "data-harness-subagent-step",
    );
    expect(steps.map((chunk) => chunk.data)).toEqual([
      {
        kind: "tool-call",
        rootToolUseId: "toolu_agent",
        parentToolUseId: "toolu_agent",
        toolUseId: "toolu_read",
        toolName: "Read",
        input: { file_path: "/work/README.md" },
      },
      {
        kind: "tool-result",
        rootToolUseId: "toolu_agent",
        parentToolUseId: "toolu_agent",
        toolUseId: "toolu_read",
        isError: false,
      },
    ]);
    expect(steps.every((chunk) => chunk.transient === true)).toBe(true);
    // A step does not split the answer, and is no tool call of the turn's.
    expect(chunks.filter((chunk) => chunk.type === "text-start")).toHaveLength(
      1,
    );
    expect(chunks.some((chunk) => String(chunk.type).startsWith("tool-"))).toBe(
      false,
    );
    expect(assistantTexts(result.messageHistory)).toEqual(["Planning done."]);
    expect(
      result.messageHistory.some(
        (message) =>
          Array.isArray(message.content) &&
          (message.content as Array<{ type: string }>).some((part) =>
            part.type.startsWith("tool-"),
          ),
      ),
    ).toBe(false);
  });

  it("splits a background agent's follow-up into its own text part, in the UI and the transcript", async () => {
    harnessState.script = drainedTurn;
    harnessState.finalText = "I started the plan.Here is the plan.";

    const result = await runHarnessTurn(options() as any, "ui");
    const chunks = sseChunks(await result.response!.text());
    const textStarts = chunks.filter((chunk) => chunk.type === "text-start");
    expect(textStarts).toHaveLength(2);
    expect(textStarts[0]!.id).not.toBe(textStarts[1]!.id);
    expect(assistantTexts(result.messageHistory)).toEqual([
      "I started the plan.",
      "Here is the plan.",
    ]);
  });

  it("leaves an ordinary turn's text in one part", async () => {
    harnessState.script = [
      { type: "text-delta", delta: "One " },
      { type: "text-delta", delta: "answer." },
      { type: "finish", finishReason: "stop" },
    ];
    harnessState.finalText = "One answer.";

    const result = await runHarnessTurn(options() as any, "ui");
    const chunks = sseChunks(await result.response!.text());
    expect(chunks.filter((chunk) => chunk.type === "text-start")).toHaveLength(
      1,
    );
    expect(
      chunks.some((chunk) => chunk.type === "data-harness-background-task"),
    ).toBe(false);
    expect(assistantTexts(result.messageHistory)).toEqual(["One answer."]);
  });

  it("a Stop while the bridge only waits keeps the answer and commits the turn", async () => {
    const stop = new AbortController();
    harnessState.script = [
      { type: "text-delta", delta: "I started the plan." },
      task("running"),
      notice("draining"),
      () => stop.abort(),
      // The agent settles a Stop as an abort and closes the stream.
      { type: "abort" },
    ];
    harnessState.finalText = new Error("aborted");

    const result = await runHarnessTurn(
      options({ abortSignal: stop.signal }) as any,
      "none",
    );

    expect(result.aborted).toBe(false);
    expect(result.turnTrace).toBeDefined();
    expect(result.backgroundDrainEnded).toBe(true);
    expect(assistantTexts(result.messageHistory)).toEqual([
      "I started the plan.",
    ]);
    // Detached and committed like any finished turn, not torn down.
    expect(harnessState.session.detach).toHaveBeenCalledTimes(1);
    expect(harnessState.session.destroy).not.toHaveBeenCalled();
  });

  it("a Stop the stream THROWS while the bridge waits keeps the answer too", async () => {
    const stop = new AbortController();
    harnessState.script = [
      { type: "text-delta", delta: "I started the plan." },
      task("running"),
      notice("draining"),
      () => {
        stop.abort();
        throw Object.assign(new Error("socket closed"), { name: "AbortError" });
      },
    ];
    harnessState.finalText = new Error("aborted");

    const result = await runHarnessTurn(
      options({ abortSignal: stop.signal }) as any,
      "none",
    );

    expect(result.aborted).toBe(false);
    expect(result.backgroundDrainEnded).toBe(true);
    expect(assistantTexts(result.messageHistory)).toEqual([
      "I started the plan.",
    ]);
    expect(harnessState.session.detach).toHaveBeenCalledTimes(1);
  });

  it("a drain ended by a Stop keeps the usage of the steps that ran", async () => {
    const stop = new AbortController();
    harnessState.script = [
      { type: "text-delta", delta: "I started the plan." },
      {
        type: "finish-step",
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      },
      task("running"),
      notice("draining"),
      task("completed"),
      notice("follow-up"),
      { type: "text-delta", delta: "Here is the plan." },
      {
        type: "finish-step",
        usage: { inputTokens: 20, outputTokens: 6, totalTokens: 26 },
      },
      notice("draining"),
      () => stop.abort(),
      { type: "abort" },
    ];
    harnessState.finalText = new Error("aborted");

    const result = await runHarnessTurn(
      options({ abortSignal: stop.signal }) as any,
      "none",
    );

    expect(result.backgroundDrainEnded).toBe(true);
    expect(result.turnTrace?.usage).toEqual(
      expect.objectContaining({
        inputTokens: 30,
        outputTokens: 10,
        totalTokens: 40,
      }),
    );
  });

  it("a Stop while a background agent's follow-up streams is an abort", async () => {
    const stop = new AbortController();
    harnessState.script = [
      { type: "text-delta", delta: "I started the plan." },
      task("running"),
      notice("draining"),
      task("completed"),
      notice("follow-up"),
      { type: "text-delta", delta: "Here is" },
      () => stop.abort(),
      { type: "abort" },
    ];
    harnessState.finalText = new Error("aborted");

    const result = await runHarnessTurn(
      options({ abortSignal: stop.signal }) as any,
      "none",
    );

    expect(result.aborted).toBe(true);
    expect(result.backgroundDrainEnded).toBeUndefined();
    expect(harnessState.session.detach).not.toHaveBeenCalled();
  });

  it("a Stop with a tool call in flight is an abort", async () => {
    const stop = new AbortController();
    harnessState.script = [
      { type: "text-delta", delta: "I started the plan." },
      notice("draining"),
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "Bash",
        input: { command: "ls" },
      },
      () => stop.abort(),
      { type: "abort" },
    ];
    harnessState.finalText = new Error("aborted");

    const result = await runHarnessTurn(
      options({ abortSignal: stop.signal }) as any,
      "none",
    );

    expect(result.aborted).toBe(true);
    expect(result.backgroundDrainEnded).toBeUndefined();
  });

  it("a FAILED tool call is no longer in flight: a Stop while waiting keeps the answer", async () => {
    // A non-zero Bash exit, a missing file or a failed Edit ends with
    // `tool-error`, never `tool-result`.
    const stop = new AbortController();
    harnessState.script = [
      {
        type: "tool-call",
        toolCallId: "call_1",
        toolName: "Bash",
        input: { command: "false" },
      },
      { type: "tool-error", toolCallId: "call_1", error: "exit 1" },
      { type: "text-delta", delta: "I started the plan." },
      task("running"),
      notice("draining"),
      () => stop.abort(),
      { type: "abort" },
    ];
    harnessState.finalText = new Error("aborted");

    const result = await runHarnessTurn(
      options({ abortSignal: stop.signal }) as any,
      "none",
    );

    expect(result.aborted).toBe(false);
    expect(result.backgroundDrainEnded).toBe(true);
    expect(harnessState.session.detach).toHaveBeenCalledTimes(1);
  });

  it("a waiting phase re-announced after a follow-up ends on a Stop again", async () => {
    const stop = new AbortController();
    harnessState.script = [
      { type: "text-delta", delta: "I started the plan." },
      notice("follow-up"),
      { type: "text-delta", delta: "Here is the plan." },
      notice("draining"),
      () => stop.abort(),
      { type: "abort" },
    ];
    harnessState.finalText = new Error("aborted");

    const result = await runHarnessTurn(
      options({ abortSignal: stop.signal }) as any,
      "none",
    );

    expect(result.aborted).toBe(false);
    expect(result.backgroundDrainEnded).toBe(true);
  });

  it("a Stop before the drain is still an abort", async () => {
    const stop = new AbortController();
    harnessState.script = [
      { type: "text-delta", delta: "Working on it" },
      () => stop.abort(),
      { type: "abort" },
    ];
    harnessState.finalText = new Error("aborted");

    const result = await runHarnessTurn(
      options({ abortSignal: stop.signal }) as any,
      "none",
    );

    expect(result.aborted).toBe(true);
    expect(result.turnTrace).toBeUndefined();
    expect(result.backgroundDrainEnded).toBeUndefined();
    expect(harnessState.session.detach).not.toHaveBeenCalled();
    expect(harnessState.session.destroy).toHaveBeenCalled();
  });

  it("keeps the stream alive while it waits", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    harnessState.script = [
      { type: "text-delta", delta: "I started the plan." },
      notice("draining"),
      () => released,
      { type: "finish", finishReason: "stop" },
    ];
    harnessState.finalText = "I started the plan.";

    const result = await runHarnessTurn(options() as any, "ui");
    const body = result.response!.text();
    await vi.advanceTimersByTimeAsync(41_000);
    release();
    const keepalives = sseChunks(await body).filter(
      (chunk) =>
        chunk.type === "data-harness-background-task" &&
        (chunk.data as { kind?: string }).kind === "keepalive",
    );
    expect(keepalives).toHaveLength(2);
  });

  it("no keepalive while a follow-up streams; it resumes when the turn waits again", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let releaseFollowUp!: () => void;
    const followUp = new Promise<void>(
      (resolve) => (releaseFollowUp = resolve),
    );
    let releaseWait!: () => void;
    const waitAgain = new Promise<void>((resolve) => (releaseWait = resolve));
    harnessState.script = [
      { type: "text-delta", delta: "I started the plan." },
      notice("draining"),
      notice("follow-up"),
      () => followUp,
      notice("draining"),
      () => waitAgain,
      { type: "finish", finishReason: "stop" },
    ];
    harnessState.finalText = "I started the plan.";

    const result = await runHarnessTurn(options() as any, "ui");
    const body = result.response!.text();
    await vi.advanceTimersByTimeAsync(41_000);
    releaseFollowUp();
    await vi.advanceTimersByTimeAsync(21_000);
    releaseWait();
    const keepalives = sseChunks(await body).filter(
      (chunk) =>
        chunk.type === "data-harness-background-task" &&
        (chunk.data as { kind?: string }).kind === "keepalive",
    );
    // None during the 41 s follow-up, one in the 21 s wait after it.
    expect(keepalives).toHaveLength(1);
  });
});
