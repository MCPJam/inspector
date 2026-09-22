/**
 * A model step that produces NOTHING is a failure, and the engine must say so.
 *
 * The bug this file pins: the emulated engine's terminal branch stamped every
 * step `status: "ok"` and wrote the finish chunk, even when `processStream`
 * came back with zero content parts. A provider that answered 200 with an
 * empty body therefore read as a clean turn to the trace, to the step-finish
 * telemetry, and to chat (a blank assistant bubble) — while the hosted eval
 * runner, the only consumer that noticed at all, inferred the failure from
 * `newMessages.length === 0` and reported "Backend step returned no content
 * (stream error or empty response)" with no cause attached.
 *
 * A normalized finish reason is evidence, not a provider diagnostic. In
 * particular, `error` alone cannot identify a malformed function call or
 * attribute the failure to a particular model tier or schema size.
 *
 * These drive the real engine through its public entry point, because the
 * mis-stamping lived in the branch itself; a test mocking one layer up passes
 * with the bug fully present.
 *
 * ONE CASE IS NOT A FAILURE, and the second describe block pins it: a model
 * that already settled a tool call THIS TURN and then closes with a clean
 * `stop` has chosen to let the tool's output be the answer, which is ordinary
 * for an MCP App host whose widget already rendered. The rule the whole file
 * defends is therefore "an empty step that never ACTED is a failure" — the
 * carve-out is scoped by finish reason, by prompt, and by whether the tool
 * actually came back, so none of the cases above lose their error.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeToolCallsFromMessages,
  hasUnresolvedToolCalls,
} from "@/shared/http-tool-calls";
import { describeError } from "@mcpjam/sdk";
import { handleMCPJamFreeChatModel } from "../mcpjam-stream-handler";
import {
  createEmptyTurnWatcher,
  describeEmptyStepFailure,
  EMPTY_STEP_SENTINEL,
} from "../empty-step-failure";
import type { EvalTraceSpan } from "@/shared/eval-trace";

let lastExecution: Promise<void> | null = null;

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    createUIMessageStream: vi.fn(({ execute, onFinish }) => {
      const writer = { write: vi.fn() };
      lastExecution = Promise.resolve(execute({ writer })).then(async () => {
        await onFinish?.();
      });
      return { getReader: vi.fn() };
    }),
    createUIMessageStreamResponse: vi.fn().mockReturnValue(
      new Response("{}", {
        headers: { "Content-Type": "text/event-stream" },
      }),
    ),
  };
});

vi.mock("@/shared/http-tool-calls", () => ({
  hasUnresolvedToolCalls: vi.fn(),
  executeToolCallsFromMessages: vi.fn(),
}));

vi.mock("../mcpjam-tool-helpers", () => ({
  serializeToolsForConvex: vi.fn(() => []),
}));

// `captureOriginErrorToSentry` is reached from the empty-step branch's
// `failureReporter` call; a mock without it throws INSIDE the branch and the
// throw escapes to the agentic loop's catch, which emits an engine error of
// its own. Every assertion below would then pass against the wrong site.
vi.mock("../logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    event: vi.fn(),
    systemEvent: vi.fn(),
  },
  captureOriginErrorToSentry: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

type EngineErrorEvent = {
  phase?: "setup" | "stream";
  message?: string;
  code?: string;
  stepIndex?: number;
};

const sseOf = (events: unknown[]) =>
  new Response(
    `${events
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("")}data: [DONE]\n\n`,
    { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );

async function runTurn(
  chunks: unknown[],
  messages: unknown[] = [{ role: "user", content: "Hi." }],
): Promise<{
  events: EngineErrorEvent[];
  spans: EvalTraceSpan[];
  settledWithError: boolean[];
}> {
  const events: EngineErrorEvent[] = [];
  const settledWithError: boolean[] = [];
  let spans: EvalTraceSpan[] = [];
  global.fetch = vi.fn().mockResolvedValue(sseOf(chunks));
  await handleMCPJamFreeChatModel({
    messages: messages as any,
    modelId: "google/gemini-2.5-flash-lite",
    systemPrompt: "You are helpful",
    tools: {},
    mcpClientManager: {
      getAllToolsMetadata: vi.fn().mockReturnValue({}),
      listServers: vi.fn().mockReturnValue([]),
    } as any,
    heartbeatIntervalMs: 0,
    onEngineError: (event: EngineErrorEvent) => events.push(event),
    onStepFinish: (event: any) => {
      settledWithError.push(event.settledWithError);
      spans = event.turnSpans ?? [];
    },
  } as any);
  await lastExecution;
  return { events, spans, settledWithError };
}

const finishChunk = (finishReason: string) => ({
  type: "finish",
  finishReason,
  totalUsage: { inputTokens: 7, outputTokens: 0, totalTokens: 7 },
});

describe("an empty model step fails instead of passing as an ok step", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    lastExecution = null;
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    vi.mocked(hasUnresolvedToolCalls).mockReturnValue(false);
    vi.mocked(executeToolCallsFromMessages).mockResolvedValue([]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
  });

  it("emits an engine error naming the finish reason, instead of finishing clean", async () => {
    const { events, settledWithError } = await runTurn([finishChunk("error")]);

    expect(events).toHaveLength(1);
    expect(events[0].message).toContain("finishReason: error");
    expect(events[0].message).toContain("underlying cause was not recorded");
    expect(events[0].message).not.toMatch(/MALFORMED_FUNCTION_CALL|cheaper|schemas/);
    expect(events[0].code).toBe("provider_empty_response");
    // The stream responded in full; only its content was missing. `setup`
    // here would file our own preparation bug as the provider's.
    expect(events[0].phase).toBe("stream");
    expect(events[0].stepIndex).toBe(0);
    expect(settledWithError).toEqual([true]);
  });

  it("marks the step span `error` and keeps the finish reason on it", async () => {
    const { spans } = await runTurn([finishChunk("error")]);

    const step = spans.find((span) => span.category === "step");
    // `status: "ok"` here is the whole bug: it let a dead turn look healthy to
    // the trace, the telemetry and the runner at once.
    expect(step?.status).toBe("error");
    expect(spans.some((span) => span.status === "ok")).toBe(false);
    // The failure shape is `step` + an `error` child, matching this engine's
    // other two failure sites — no `llm` span, unlike the success path.
    expect(spans.some((span) => span.category === "error")).toBe(true);
    // And the diagnostic survives onto the span the timeline renders:
    // `trace-timeline.tsx` shows `finishReason` for ANY category, so "Finish:
    // error" is readable in the UI without reopening the raw trace.
    expect(step?.finishReason).toBe("error");
  });

  it("keeps the sentinel prefix so the SDK still classifies the family", async () => {
    // Detail is APPENDED, never substituted: `describe.ts` matches this family
    // by text, and the eval runner's own fallback emits the same sentence. A
    // message that explains itself must stay classifiable.
    const { events } = await runTurn([finishChunk("error")]);

    expect(events[0].message?.startsWith(EMPTY_STEP_SENTINEL)).toBe(true);
    expect(describeError(events[0].message!).slug).toBe(
      "provider/empty_response",
    );
  });

  it("names a rejected tool input over the finish reason, because it is actionable", async () => {
    // The OTHER road to an empty step: the model DID emit a tool call and the
    // SDK rejected its input, so `tool-input-error` arrives carrying no
    // content part. Indistinguishable from silence before this.
    const { events } = await runTurn([
      {
        type: "tool-input-error",
        toolCallId: "call_1",
        toolName: "get_capabilities",
        input: {},
        errorText: "Invalid arguments: expected string, received number",
      },
      finishChunk("tool-calls"),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].message).toContain("expected string, received number");
    expect(events[0].message?.startsWith(EMPTY_STEP_SENTINEL)).toBe(true);
  });

  it("names the tool a `length` finish cut off mid-call, instead of claiming there was no tool call", async () => {
    // Measured on staging: `gpt-5-nano` began a drawing call and hit the
    // output-token limit before its input was complete. The call never
    // becomes `tool-input-available`, so it adds no content part.
    const { events } = await runTurn([
      {
        type: "tool-input-start",
        toolCallId: "call_1",
        toolName: "create_view",
      },
      {
        type: "tool-input-delta",
        toolCallId: "call_1",
        inputTextDelta: '{"elements":[',
      },
      {
        type: "finish",
        finishReason: "length",
        messageMetadata: {
          inputTokens: 900,
          outputTokens: 8192,
          totalTokens: 9092,
        },
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].message?.startsWith(EMPTY_STEP_SENTINEL)).toBe(true);
    expect(events[0].message).toContain("started a call to `create_view`");
    expect(events[0].message).toContain(
      "ran out of output tokens (8192 output tokens)",
    );
    expect(events[0].message).not.toContain("no tool call");
  });

  it("quotes the output tokens a `length` finish spent with nothing visible", async () => {
    const { events } = await runTurn([
      {
        type: "finish",
        finishReason: "length",
        messageMetadata: {
          inputTokens: 900,
          outputTokens: 8192,
          totalTokens: 9092,
        },
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0].message).toContain("no tool call (finishReason: length)");
    expect(events[0].message).toContain(
      "output-token limit (8192 output tokens)",
    );
    expect(events[0].message).toContain(
      "reasoning the provider does not stream back",
    );
  });

  it("leaves a step that produced text alone", async () => {
    // The guard is `contentParts.length === 0`, not the finish reason: a turn
    // that said something is a success however the provider labelled it.
    const { events, spans, settledWithError } = await runTurn([
      { type: "text-start", id: "t1" },
      { type: "text-delta", id: "t1", delta: "Here you go." },
      { type: "text-end", id: "t1" },
      finishChunk("stop"),
    ]);

    expect(events).toHaveLength(0);
    expect(settledWithError).toEqual([false]);
    expect(spans.find((span) => span.category === "step")?.status).toBe("ok");
  });
});

/**
 * ...but a model that already ACTED this turn is allowed to stop talking.
 *
 * Measured on staging: `gpt-5.6-luna` on the ChatGPT host profile called
 * `create_view`, the widget rendered (0 console errors), and the next step
 * closed with `stop` and nothing in it — 22 of 215 trials, while haiku,
 * sonnet, grok, glm and terra did it on none of ~600. The tool output IS the
 * answer for an MCP App host, so failing the trial hid a scorecard whose tool
 * stages had all passed behind a red box blaming a "provider hiccup".
 *
 * The seeded history is also the RESUMED-turn shape: `promptMessageStartIndex`
 * sits just after the last user message, so these steps start at a non-zero
 * `stepIndex`. That is exactly why the carve-out reads the messages rather
 * than `stepIndex > 0` (non-zero on a resume before anything ran this process)
 * or `traceTurn.turnSpans` (empty on a resume).
 */
describe("a quiet finish after settled tool work ends the turn normally", () => {
  const originalFetch = global.fetch;

  /** user → assistant tool-call → tool result. `output` shape per
   *  `buildMcpToolResultMessage`: a real reply is `content`, never `error-`. */
  const historyWithToolResult = (
    output: Record<string, unknown> = { type: "content", value: [] },
  ) => [
    { role: "user", content: "Draw three boxes." },
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "create_view",
          input: {},
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_1",
          toolName: "create_view",
          output,
        },
      ],
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    lastExecution = null;
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    vi.mocked(hasUnresolvedToolCalls).mockReturnValue(false);
    vi.mocked(executeToolCallsFromMessages).mockResolvedValue([]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
  });

  it("passes a `stop` with no content when a tool already settled", async () => {
    const { events, spans, settledWithError } = await runTurn(
      [finishChunk("stop")],
      historyWithToolResult(),
    );

    expect(events).toHaveLength(0);
    expect(settledWithError).toEqual([false]);
    expect(spans.find((span) => span.category === "step")?.status).toBe("ok");
    expect(spans.some((span) => span.category === "error")).toBe(false);
  });

  it("still fails `error`, so the carve-out keys on the finish reason and not on having run a tool", async () => {
    const { events, settledWithError } = await runTurn(
      [finishChunk("error")],
      historyWithToolResult(),
    );

    expect(events).toHaveLength(1);
    expect(events[0].code).toBe("provider_empty_response");
    expect(settledWithError).toEqual([true]);
  });

  it("still fails `tool-calls`, which is the provider contradicting itself rather than choosing silence", async () => {
    const { events, settledWithError } = await runTurn(
      [finishChunk("tool-calls")],
      historyWithToolResult(),
    );

    expect(events).toHaveLength(1);
    expect(settledWithError).toEqual([true]);
  });

  it("still fails when the only tool ERRORED — trying to act and being refused is not acting", async () => {
    // Same shape an auto-denied tool produces, so "every tool was denied, then
    // the model said nothing" keeps its error instead of reading as a finish.
    const { events, settledWithError } = await runTurn(
      [finishChunk("stop")],
      historyWithToolResult({ type: "error-text", value: "boom" }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].code).toBe("provider_empty_response");
    expect(settledWithError).toEqual([true]);
  });

  it("still fails a `stop` in a turn that never called a tool", async () => {
    // The floor of the guard, and the case most at risk of over-reach: no
    // widget, no tool result, nothing standing in for an answer.
    const { events, settledWithError } = await runTurn([finishChunk("stop")]);

    expect(events).toHaveLength(1);
    expect(events[0].message).toContain("finishReason: stop");
    expect(settledWithError).toEqual([true]);
  });
});

describe("describeEmptyStepFailure", () => {
  it("separates the provider finish reasons that arrive empty", () => {
    expect(
      describeEmptyStepFailure({ finishReason: "content-filter" }),
    ).toContain("safety filter");
    expect(describeEmptyStepFailure({ finishReason: "length" })).toContain(
      "output-token limit",
    );
    expect(describeEmptyStepFailure({ finishReason: "stop" })).toContain(
      "clean finish and still returned nothing",
    );
  });

  it("says so plainly when the provider reported no finish reason at all", () => {
    const message = describeEmptyStepFailure({});
    expect(message).toContain("finishReason: none reported");
    expect(message.startsWith(EMPTY_STEP_SENTINEL)).toBe(true);
  });

  it("every message this can produce still classifies as provider/empty_response", () => {
    for (const finishReason of [
      "error",
      "content-filter",
      "length",
      "stop",
      "tool-calls",
      "unknown",
      undefined,
    ]) {
      expect(
        describeError(describeEmptyStepFailure({ finishReason })).slug,
      ).toBe("provider/empty_response");
    }
    expect(
      describeError(
        describeEmptyStepFailure({ toolInputErrors: ["bad input"] }),
      ).slug,
    ).toBe("provider/empty_response");
  });
});

describe("createEmptyTurnWatcher (direct BYOK turns)", () => {
  const finish = (finishReason: string) =>
    ({ type: "finish", finishReason }) as any;

  const watch = (
    chunks: unknown[],
    finishReason: string,
    settledToolBeforeStream = false,
  ) => {
    const watcher = createEmptyTurnWatcher({ settledToolBeforeStream });
    for (const chunk of chunks) watcher.observe(chunk as any);
    return watcher.failureFor(finish(finishReason));
  };

  it("fails an empty last step with the same sentence as the hosted engine", () => {
    const message = watch(
      [
        { type: "start" },
        { type: "start-step" },
        { type: "finish-step" },
        { type: "message-metadata", messageMetadata: { outputTokens: 4096 } },
      ],
      "length",
    );

    expect(message).toBe(
      describeEmptyStepFailure({ finishReason: "length", outputTokens: 4096 }),
    );
    expect(describeError(message!).slug).toBe("provider/empty_response");
  });

  it("names a call the stream cut off", () => {
    const message = watch(
      [
        { type: "start-step" },
        { type: "tool-input-start", toolCallId: "c1", toolName: "create_view" },
        { type: "tool-input-delta", toolCallId: "c1", inputTextDelta: "{" },
        { type: "finish-step" },
      ],
      "length",
    );

    expect(message).toContain("started a call to `create_view`");
  });

  it("judges only the LAST step, so earlier text does not hide an empty ending", () => {
    const message = watch(
      [
        { type: "start-step" },
        { type: "text-delta", id: "t", delta: "Let me check." },
        {
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: "x",
          input: {},
        },
        { type: "tool-output-error", toolCallId: "c1", errorText: "boom" },
        { type: "finish-step" },
        { type: "start-step" },
        { type: "finish-step" },
      ],
      "stop",
    );

    expect(message).toContain("finishReason: stop");
  });

  it("passes a quiet `stop` after a tool came back, in this stream or before it", () => {
    expect(
      watch(
        [
          { type: "start-step" },
          {
            type: "tool-input-available",
            toolCallId: "c1",
            toolName: "x",
            input: {},
          },
          { type: "tool-output-available", toolCallId: "c1", output: {} },
          { type: "finish-step" },
          { type: "start-step" },
          { type: "finish-step" },
        ],
        "stop",
      ),
    ).toBeUndefined();
    expect(
      watch([{ type: "start-step" }, { type: "finish-step" }], "stop", true),
    ).toBeUndefined();
    // ...but never a `length`: running out is not choosing to stop.
    expect(
      watch([{ type: "start-step" }, { type: "finish-step" }], "length", true),
    ).toContain("finishReason: length");
  });

  it("stays quiet for a step with content, a stream that already errored, or one with no step", () => {
    expect(
      watch(
        [{ type: "start-step" }, { type: "text-delta", id: "t", delta: "Hi" }],
        "stop",
      ),
    ).toBeUndefined();
    expect(
      watch(
        [
          { type: "start-step" },
          { type: "reasoning-delta", id: "r", delta: "hm" },
        ],
        "length",
      ),
    ).toBeUndefined();
    expect(
      watch(
        [{ type: "start-step" }, { type: "error", errorText: "x" }],
        "error",
      ),
    ).toBeUndefined();
    expect(watch([{ type: "start" }], "stop")).toBeUndefined();
    // A chunk type this does not model counts as content, never as silence.
    expect(
      watch(
        [{ type: "start-step" }, { type: "data-custom", data: {} }],
        "stop",
      ),
    ).toBeUndefined();
  });
});
