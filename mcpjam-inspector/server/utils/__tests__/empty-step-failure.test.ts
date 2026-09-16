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
 * The cause was on the wire the whole time. `@ai-sdk/google` maps Google's
 * `MALFORMED_FUNCTION_CALL` to `finishReason: "error"` with no parts and NO
 * throw, and `SAFETY` / `RECITATION` to `"content-filter"` the same way — so
 * the finish chunk distinguishes "the provider rejected its own tool call"
 * from "a safety filter fired" from "the provider just returned nothing",
 * which are three different problems with three different remedies.
 *
 * These drive the real engine through its public entry point, because the
 * mis-stamping lived in the branch itself; a test mocking one layer up passes
 * with the bug fully present.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeToolCallsFromMessages,
  hasUnresolvedToolCalls,
} from "@/shared/http-tool-calls";
import { describeError } from "@mcpjam/sdk";
import {
  describeEmptyStepFailure,
  EMPTY_STEP_SENTINEL,
  handleMCPJamFreeChatModel,
} from "../mcpjam-stream-handler";
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

async function runTurn(chunks: unknown[]): Promise<{
  events: EngineErrorEvent[];
  spans: EvalTraceSpan[];
  settledWithError: boolean[];
}> {
  const events: EngineErrorEvent[] = [];
  const settledWithError: boolean[] = [];
  let spans: EvalTraceSpan[] = [];
  global.fetch = vi.fn().mockResolvedValue(sseOf(chunks));
  await handleMCPJamFreeChatModel({
    messages: [{ role: "user", content: "Hi." }] as any,
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
    expect(events[0].message).toContain("MALFORMED_FUNCTION_CALL");
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

describe("describeEmptyStepFailure", () => {
  it("separates the provider finish reasons that arrive empty", () => {
    expect(
      describeEmptyStepFailure({ finishReason: "content-filter" }),
    ).toContain("safety filter");
    expect(describeEmptyStepFailure({ finishReason: "length" })).toContain(
      "output-token ceiling",
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
