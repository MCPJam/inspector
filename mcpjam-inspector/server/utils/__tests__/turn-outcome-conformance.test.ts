/**
 * ENGINE CONFORMANCE FOR THE TURN OUTCOME RECORD.
 *
 * One table, driven through the REAL emulated engine (`runChatEngineLoop`), one
 * row per way a turn can end. The record is the thing every consumer now reads,
 * so a row here is not "does the state machine work" — that is
 * `stream-turn-driver.test.ts` — but "does THIS engine path actually mark its
 * ending, and mark it correctly".
 *
 * The distinction matters because the original defect was entirely about paths
 * that marked nothing: a turn that ends abnormally used to leave different
 * evidence depending on which branch ran it, and most branches left none. A
 * branch added later that forgets to mark degrades to
 * `failed`/`no_terminal_mark`, which is loud — and this table is where that
 * shows up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessageChunk } from "ai";
import type { TurnOutcomeRecord } from "@/shared/turn-outcome";

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
import {
  pauseKindOf,
  terminationOf,
  turnOutcomeRecordZ,
} from "@/shared/turn-outcome";

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

// A COMPLETE step: text plus a finish part. The text matters — a step that
// streams no content at all is a provider failure to this engine
// (`provider_empty_response`), not a quiet success, and using an empty stream
// as the "happy path" fixture would have tested the wrong thing.
const TEXT_EVENTS = [
  { type: "text-start", id: "t1" },
  { type: "text-delta", id: "t1", delta: "hello" },
  { type: "text-end", id: "t1" },
];
const FINISH_EVENT = {
  type: "finish",
  finishReason: "stop",
  totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
};
const OK_STREAM = [...TEXT_EVENTS, FINISH_EVENT];

const managerStub = {
  getAllToolsMetadata: vi.fn().mockReturnValue({}),
  listServers: vi.fn().mockReturnValue([]),
  getToolsForAiSdk: vi.fn().mockResolvedValue({}),
};

type RunOptions = Partial<Parameters<typeof runChatEngineLoop>[0]>;

async function runTurn(options: RunOptions = {}): Promise<{
  outcome: TurnOutcomeRecord | undefined;
  viaCallback: TurnOutcomeRecord | undefined;
}> {
  let viaCallback: TurnOutcomeRecord | undefined;
  const result = await runChatEngineLoop(
    {
      messages: [{ role: "user", content: "hi" }],
      modelId: "openai/gpt-5-mini",
      systemPrompt: "You are helpful",
      tools: {},
      mcpClientManager: managerStub as never,
      onTurnOutcome: (outcome) => {
        viaCallback = outcome;
      },
      ...options,
    } as never,
    "none",
  );
  return { outcome: result.outcome, viaCallback };
}

function abortedSignal(reason?: unknown): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

describe("emulated engine outcome conformance", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    global.fetch = vi.fn().mockResolvedValue(sseResponse(OK_STREAM));
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
  });

  it("COMPLETED: a clean turn records the provider's finish reason", async () => {
    const { outcome, viaCallback } = await runTurn();
    expect(outcome?.lifecycle).toBe("completed");
    expect(outcome?.finishReason).toBe("stop");
    expect(outcome?.runtime).toEqual({
      engine: "emulated",
      modelAccess: "hosted",
    });
    // `completed` FORBIDS a termination block.
    expect(terminationOf(outcome)).toBeUndefined();
    // The callback and the `"none"`-sink return value are the same record.
    expect(viaCallback).toEqual(outcome);
  });

  it("CANCELLED before the first step: the pre-start bail is marked, not silent", async () => {
    // Silent on the WIRE — no terminal chunk — but never silent in the record.
    // This branch used to `return` with nothing marked at all.
    const { outcome } = await runTurn({
      abortSignal: abortedSignal(),
      cancellationSource: "client_disconnect",
    });
    expect(outcome?.lifecycle).toBe("cancelled");
    expect(terminationOf(outcome)?.cancellationSource).toBe("client_disconnect");
  });

  it("CANCELLED between steps: the silent-cancellation gate is marked", async () => {
    const controller = new AbortController();
    global.fetch = vi.fn().mockImplementation(async () => {
      // Fire the abort as the step's response settles, so the loop exits
      // through the between-steps gate rather than the pre-start bail.
      controller.abort();
      return sseResponse(OK_STREAM);
    });
    const { outcome } = await runTurn({ abortSignal: controller.signal });
    expect(outcome?.lifecycle).toBe("cancelled");
    // No explicit source declared by this caller → the default.
    expect(terminationOf(outcome)?.cancellationSource).toBe("caller");
  });

  it("CANCELLED names WHO, from the signal's typed reason", async () => {
    const { outcome } = await runTurn({
      abortSignal: abortedSignal(
        Object.assign(new Error("harness lease lost"), {
          name: "AbortError",
          turnCancellationSource: "lease_lost",
        }),
      ),
      // The typed reason WINS over the caller's declared default: a lease the
      // runtime lost is not the browser going away.
      cancellationSource: "client_disconnect",
    });
    expect(terminationOf(outcome)?.cancellationSource).toBe("lease_lost");
  });

  it("TIMED OUT: a fired deadline names its clock rather than reading as cancelled", async () => {
    const { outcome } = await runTurn({
      abortSignal: abortedSignal(
        Object.assign(new Error("turn budget expired"), {
          name: "AbortError",
          clock: "turn",
          budgetMs: 360_000,
        }),
      ),
    });
    expect(outcome?.lifecycle).toBe("timed_out");
    expect(terminationOf(outcome)?.timeout?.clock).toBe("turn");
    expect(terminationOf(outcome)?.timeout?.budgetMs).toBe(360_000);
    expect(terminationOf(outcome)?.cancellationSource).toBeUndefined();
  });

  it("FAILED (setup): a failure BEFORE the handover is attributed to us", async () => {
    // `modelInvoked` flips at the HANDOVER, not on a successful response, so a
    // setup failure has to happen in our own preparation. The resume pre-phase
    // is one: it drives a durable continuation before the first model call. A
    // provider that rejects the request outright is `model` instead — the next
    // test covers that, and the two must not be confused, because the eval
    // consumer's default phase is `model` and would file ours as theirs.
    const messages = [
      { role: "user", content: "hi" },
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
    ];
    const { outcome } = await runTurn({
      messages: messages as never,
      scopeStepUpResume: {
        toolCallId: "call-1",
        resolve: vi.fn().mockRejectedValue(new Error("continuation exploded")),
      } as never,
    });
    expect(outcome?.lifecycle).toBe("failed");
    expect(terminationOf(outcome)?.errorSource).toBe("setup");
  });

  it("FAILED (stream): a throw once the model has been asked is theirs", async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));
    const { outcome } = await runTurn();
    expect(outcome?.lifecycle).toBe("failed");
    expect(terminationOf(outcome)?.errorSource).toBe("model");
  });

  it("FAILED (step settled with an error, no throw) — the old silent 'completed'", async () => {
    // A non-OK backend response does NOT throw: `processOneStep` emits an
    // error chunk and returns `{shouldContinue: false, didEmitFinish: false}`,
    // so the outer catch never sees it and the epilogue used to mark the turn
    // completed. This is the row that fails if that regresses.
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "upstream exploded" }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { outcome } = await runTurn();
    expect(outcome?.lifecycle).toBe("failed");
    expect(terminationOf(outcome)?.errorSource).toBe("model");
    // A late `markCompleted` from the epilogue lost the race and is kept only
    // as diagnosis.
    expect(terminationOf(outcome)?.superseded?.map((s) => s.mark)).toEqual([
      "completed",
    ]);
  });

  it("PAUSED: a resume the history cannot satisfy pauses instead of completing", async () => {
    const resolve = vi.fn();
    const { outcome } = await runTurn({
      // A toolCallId that is not an unresolved call in this history: the engine
      // refuses to drive the continuation and pauses for the client to
      // reconcile. It must NOT read as a completion.
      scopeStepUpResume: { toolCallId: "not-in-history", resolve } as never,
    });
    expect(outcome?.lifecycle).toBe("paused");
    expect(pauseKindOf(outcome)).toBe("scope_step_up");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("PAUSED BY THE LOOP: an approval pause is not a completion", async () => {
    // THE HOLE THIS CLOSES, and the reason it survived: every other pause test
    // here drives the PRE-PHASE, which sets its own flag before the loop runs.
    // The loop's own pauses — approval, client-fulfilled, and a suspend signal
    // — all return the same `shouldContinue: false` the epilogue read as "the
    // turn is over", so the most ordinary pause in the product was being
    // recorded as `completed`. A resumable turn filed as a finished one is the
    // exact claim this contract exists to stop anything making.
    const messages = [
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
    ];
    const { outcome } = await runTurn({
      messages: messages as never,
      tools: {
        charge_card: {
          description: "charge_card",
          inputSchema: { type: "object" } as never,
          needsApproval: true,
          execute: async () => ({ ok: true }),
        },
      } as never,
      requireToolApproval: true,
    } as never);
    expect(outcome?.lifecycle).toBe("paused");
    expect(pauseKindOf(outcome)).toBe("tool_approval");
  });

  it("PAUSED turns leave their dangling call OPEN — it is the resume handle", async () => {
    const messages = [
      { role: "user", content: "hi" },
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
    ];
    const { outcome } = await runTurn({
      messages: messages as never,
      scopeStepUpResume: {
        toolCallId: "call-1",
        resolve: vi.fn().mockResolvedValue({ kind: "suspended" }),
      } as never,
    });
    expect(outcome?.lifecycle).toBe("paused");
    expect(terminationOf(outcome)?.unresolvedToolCalls).toBeUndefined();
  });

  it("UNRESOLVED CALLS on a cancelled turn are listed with their states", async () => {
    // Never dispatched by this engine — nothing ran — so `never_started` is the
    // honest state and the closure text can safely reassure.
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "charge_card",
            input: {},
          },
          {
            type: "tool-call",
            toolCallId: "call-2",
            toolName: "list_cards",
            input: {},
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-2",
            toolName: "list_cards",
            output: { type: "json", value: [] },
          },
        ],
      },
    ];
    const { outcome } = await runTurn({
      messages: messages as never,
      abortSignal: abortedSignal(),
    });
    expect(outcome?.lifecycle).toBe("cancelled");
    // Only the call WITHOUT a result, and in history order.
    expect(terminationOf(outcome)?.unresolvedToolCalls).toEqual([
      { toolCallId: "call-1", toolName: "charge_card", state: "never_started" },
    ]);
  });

  it("every record this engine produces satisfies the contract", async () => {
    const rows: Array<[string, RunOptions]> = [
      ["completed", {}],
      ["cancelled", { abortSignal: abortedSignal() }],
      [
        "timed_out",
        {
          abortSignal: abortedSignal(
            Object.assign(new Error("x"), {
              name: "AbortError",
              clock: "iteration",
              budgetMs: 1,
            }),
          ),
        },
      ],
      [
        "paused",
        {
          scopeStepUpResume: {
            toolCallId: "nope",
            resolve: vi.fn(),
          } as never,
        },
      ],
    ];
    for (const [label, options] of rows) {
      const { outcome } = await runTurn(options);
      const parsed = turnOutcomeRecordZ.safeParse(outcome);
      expect({ label, ok: parsed.success }).toEqual({ label, ok: true });
      expect({ label, lifecycle: outcome?.lifecycle }).toEqual({
        label,
        lifecycle: label,
      });
    }
  });

  it("a throwing onTurnOutcome consumer does not take the turn down with it", async () => {
    const result = await runChatEngineLoop(
      {
        messages: [{ role: "user", content: "hi" }],
        modelId: "openai/gpt-5-mini",
        systemPrompt: "You are helpful",
        tools: {},
        mcpClientManager: managerStub as never,
        onTurnOutcome: () => {
          throw new Error("consumer exploded");
        },
      } as never,
      "none",
    );
    expect(result.messageHistory.length).toBeGreaterThan(0);
  });

  it("the UI sink reports the outcome through the callback, not the return value", async () => {
    // `createUIMessageStream` runs `execute` lazily, so the ui sink's return
    // value is produced BEFORE the turn has run. This is the whole reason
    // `onTurnOutcome` is a callback rather than a field.
    let viaCallback: TurnOutcomeRecord | undefined;
    const result = await runChatEngineLoop(
      {
        messages: [{ role: "user", content: "hi" }],
        modelId: "openai/gpt-5-mini",
        systemPrompt: "You are helpful",
        tools: {},
        mcpClientManager: managerStub as never,
        onTurnOutcome: (outcome) => {
          viaCallback = outcome;
        },
      } as never,
      "ui",
    );
    expect(result.outcome).toBeUndefined();
    expect(result.response).toBeInstanceOf(Response);
    // Drain the body so `execute` runs.
    const reader = result.response!.body?.getReader();
    if (reader) {
      const chunks: UIMessageChunk[] = [];
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done } = await reader.read();
        if (done) break;
        chunks.push({} as UIMessageChunk);
      }
    }
    expect(viaCallback?.lifecycle).toBe("completed");
  });
});
