/**
 * TERMINAL TURN RECORDING — what gets written when a turn does not finish.
 *
 * The old rule was `runSucceeded && !aborted`: a turn that did not reach a
 * clean end was dropped whole, on the reasoning that a partial turn is not a
 * conversation. The cost was that tool calls which had already run — and been
 * billed — left no durable trace at all, so nobody could answer what a stopped
 * session actually did.
 *
 * These tests pin the new rule and its two hard edges: the switch, and the
 * closure that has to happen before anything is written.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import { isInterruptedToolResult } from "@/shared/turn-outcome-closure";

vi.mock("../harness/run-harness-turn", () => ({
  runHarnessTurn: vi.fn(),
}));

vi.mock("../mcpjam-tool-helpers", () => ({
  serializeToolsForConvex: vi.fn(() => []),
}));

vi.mock("../logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    systemEvent: vi.fn(),
    event: vi.fn(),
  },
  captureOriginErrorToSentry: vi.fn(),
}));

// eslint-disable-next-line import/first
import { runChatEngineLoop } from "../mcpjam-stream-handler";

const encoder = new TextEncoder();
const sseResponse = (events: unknown[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `${events
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join("")}data: [DONE]\n\n`,
          ),
        );
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );

const OK_STREAM = [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "ok" },
  { type: "text-end", id: "t1" },
  { type: "finish", finishReason: "stop" },
];

const managerStub = {
  getAllToolsMetadata: vi.fn().mockReturnValue({}),
  listServers: vi.fn().mockReturnValue([]),
  getToolsForAiSdk: vi.fn().mockResolvedValue({}),
};

type Persisted = {
  history: ModelMessage[];
  trace: Record<string, unknown>;
};

async function runTurn(options: Record<string, unknown> = {}) {
  const persisted: Persisted[] = [];
  await runChatEngineLoop(
    {
      messages: [{ role: "user", content: "hi" }],
      modelId: "openai/gpt-5-mini",
      systemPrompt: "You are helpful",
      tools: {},
      mcpClientManager: managerStub as never,
      onConversationComplete: (history: ModelMessage[], trace: unknown) => {
        persisted.push({ history, trace: trace as Record<string, unknown> });
      },
      ...options,
    } as never,
    "none",
  );
  return persisted;
}

function abortedSignal(reason?: unknown): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

const historyWithOpenCall = (): ModelMessage[] =>
  [
    { role: "user", content: "charge it" },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "charge_card",
          input: {},
        },
      ],
    },
  ] as unknown as ModelMessage[];

describe("terminal turn recording", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    global.fetch = vi.fn().mockResolvedValue(sseResponse(OK_STREAM));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("OFF by default: a stopped turn still records nothing", async () => {
    // The switch stays off until the control plane can store the record. A
    // transcript landing there with no way to tell it apart from a complete
    // one is the exact reading the backend half exists to prevent.
    const persisted = await runTurn({ abortSignal: abortedSignal() });
    expect(persisted).toEqual([]);
  });

  it("a completed turn is recorded with the switch off, as it always was", async () => {
    const persisted = await runTurn();
    expect(persisted).toHaveLength(1);
    expect(persisted[0].trace.outcomeAtTurn).toMatchObject({
      lifecycle: "completed",
    });
  });
});

describe("terminal turn recording, switched ON", () => {
  const originalFetch = global.fetch;
  let engine: typeof runChatEngineLoop;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.stubEnv("MCPJAM_TERMINAL_TURN_RECORDING", "true");
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    global.fetch = vi.fn().mockResolvedValue(sseResponse(OK_STREAM));
    // Re-imported per test: the switch is read at module load, like every
    // other kill switch in `server/config.ts`.
    ({ runChatEngineLoop: engine } = await import("../mcpjam-stream-handler"));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function run(options: Record<string, unknown> = {}) {
    const persisted: Persisted[] = [];
    await engine(
      {
        messages: [{ role: "user", content: "hi" }],
        modelId: "openai/gpt-5-mini",
        systemPrompt: "You are helpful",
        tools: {},
        mcpClientManager: managerStub as never,
        onConversationComplete: (history: ModelMessage[], trace: unknown) => {
          persisted.push({ history, trace: trace as Record<string, unknown> });
        },
        ...options,
      } as never,
      "none",
    );
    return persisted;
  }

  it("records a CANCELLED turn, with the record saying who stopped it", async () => {
    const persisted = await run({
      abortSignal: abortedSignal(),
      cancellationSource: "client_disconnect",
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].trace.outcomeAtTurn).toMatchObject({
      lifecycle: "cancelled",
      termination: { cancellationSource: "client_disconnect" },
    });
  });

  it("records a TIMED OUT turn, naming the clock", async () => {
    const persisted = await run({
      abortSignal: abortedSignal(
        Object.assign(new Error("budget expired"), {
          name: "AbortError",
          clock: "turn",
          budgetMs: 360_000,
        }),
      ),
    });
    expect(persisted[0].trace.outcomeAtTurn).toMatchObject({
      lifecycle: "timed_out",
      termination: { timeout: { clock: "turn", budgetMs: 360_000 } },
    });
  });

  it("CLOSES open tool calls BEFORE writing the transcript", async () => {
    // Persisting an open call is what would make the next turn execute it for
    // real, after the Stop. The closure is what makes the write safe at all.
    const persisted = await run({
      messages: historyWithOpenCall() as never,
      // The ingress guard leaves this call alone (a scope step-up names it),
      // so it reaches the persist path still open — which is the state the
      // persist-time closure exists for.
      scopeStepUpResume: {
        toolCallId: "call-1",
        resolve: vi.fn().mockResolvedValue({ kind: "suspended" }),
      },
      abortSignal: abortedSignal(),
    });
    expect(persisted).toHaveLength(1);
    const closures = persisted[0].history
      .filter((m) => m.role === "tool")
      .flatMap((m) => (m as { content: unknown[] }).content)
      .filter(isInterruptedToolResult);
    expect(closures).toHaveLength(1);
  });

  it("the transcript it writes is NOT the engine's live history", async () => {
    // The closure returns a new array; mutating the live reference would leave
    // the engine's own `messageHistory` carrying results it never produced.
    const messages = historyWithOpenCall();
    const persisted = await run({
      messages: messages as never,
      scopeStepUpResume: {
        toolCallId: "call-1",
        resolve: vi.fn().mockResolvedValue({ kind: "suspended" }),
      },
      abortSignal: abortedSignal(),
    });
    expect(persisted[0].history.length).toBeGreaterThan(messages.length);
  });

  it("a PAUSED turn's dangling call is left OPEN — it is the resume handle", async () => {
    const persisted = await run({
      messages: historyWithOpenCall() as never,
      scopeStepUpResume: {
        toolCallId: "call-1",
        resolve: vi.fn().mockResolvedValue({ kind: "suspended" }),
      },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0].trace.outcomeAtTurn).toMatchObject({
      lifecycle: "paused",
    });
    const closures = persisted[0].history
      .filter((m) => m.role === "tool")
      .flatMap((m) => (m as { content: unknown[] }).content)
      .filter(isInterruptedToolResult);
    expect(closures).toEqual([]);
  });

  it("a paused turn's record lists NO unresolved calls", async () => {
    // The builder merges in calls it saw dispatched; a pause must not report
    // its resume handle as a loose end.
    const persisted = await run({
      messages: historyWithOpenCall() as never,
      scopeStepUpResume: {
        toolCallId: "call-1",
        resolve: vi.fn().mockResolvedValue({ kind: "suspended" }),
      },
    });
    const outcome = persisted[0].trace.outcomeAtTurn as {
      termination?: { unresolvedToolCalls?: unknown[] };
    };
    expect(outcome.termination?.unresolvedToolCalls).toBeUndefined();
  });
});
