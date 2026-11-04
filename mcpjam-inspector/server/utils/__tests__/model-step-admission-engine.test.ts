import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeToolCallsFromMessages,
  hasUnresolvedToolCalls,
} from "@/shared/http-tool-calls";
import { handleMCPJamFreeChatModel } from "../mcpjam-stream-handler";

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

// Without `captureOriginErrorToSentry` the non-OK response site throws a
// module error, which the outer catch reports as a stream failure, and the
// final-status assertions below pass without running the code they name.
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

type EngineErrorEvent = { httpStatus?: number };

async function runTurn(overrides: Record<string, unknown>) {
  const events: EngineErrorEvent[] = [];
  await handleMCPJamFreeChatModel({
    messages: [{ role: "user", content: "Hi." }] as never,
    modelId: "openai/gpt-oss-120b",
    systemPrompt: "You are helpful",
    tools: {},
    mcpClientManager: {
      getAllToolsMetadata: vi.fn().mockReturnValue({}),
      listServers: vi.fn().mockReturnValue([]),
    } as never,
    heartbeatIntervalMs: 0,
    onEngineError: (event: EngineErrorEvent) => events.push(event),
    ...overrides,
  } as never);
  // The admission waits are real backoff sleeps (5-60s with jitter).
  await vi.runAllTimersAsync();
  await lastExecution;
  return events;
}

const busy = () =>
  new Response(
    JSON.stringify({
      code: "spending_reservation_busy",
      isRetryable: true,
      retryAfter: 2_000,
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );

describe("engine resend of a model step refused as busy", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    lastExecution = null;
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    vi.mocked(hasUnresolvedToolCalls).mockReturnValue(false);
    vi.mocked(executeToolCallsFromMessages).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
  });

  it("resends the same eval step and reports only the answer after the busy ones", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(busy())
      .mockResolvedValue(new Response("Bad Gateway", { status: 502 }));
    global.fetch = fetchSpy;

    const events = await runTurn({ sourceType: "eval" });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // The same step each time: never a later step, never a replayed turn.
    const steps = fetchSpy.mock.calls.map(([, init]) => {
      const body = JSON.parse(init.body as string);
      return `${body.turnId}:${body.stepIndex}`;
    });
    expect(new Set(steps).size).toBe(1);
    expect(events).toEqual([expect.objectContaining({ httpStatus: 502 })]);
  });

  it("surfaces the busy refusal at once on an interactive chat step", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(busy());
    global.fetch = fetchSpy;

    const events = await runTurn({ sourceType: "chat" });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(events).toEqual([expect.objectContaining({ httpStatus: 503 })]);
  });

  it("stops waiting when the turn is aborted", async () => {
    const controller = new AbortController();
    const fetchSpy = vi.fn().mockImplementation(async () => {
      controller.abort(new Error("turn deadline"));
      return busy();
    });
    global.fetch = fetchSpy;

    await runTurn({ sourceType: "eval", abortSignal: controller.signal });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
