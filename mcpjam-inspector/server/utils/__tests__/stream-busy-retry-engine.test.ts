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

// `captureOriginErrorToSentry` matters as much as `logger` here: the non-OK
// response site reaches it through `error-origin-capture`, and a mock missing
// it throws a vitest module error INSIDE that site. That throw escapes to the
// outer catch, which emits `"stream"` of its own accord — so the 502 case
// below passed while never once running the code it names. Same shape as the
// vacuous tests this suite exists to stop.
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
  httpStatus?: number;
  stepIndex?: number;
};

async function runTurn(overrides: Record<string, unknown> = {}): Promise<{
  events: EngineErrorEvent[];
}> {
  const events: EngineErrorEvent[] = [];
  await handleMCPJamFreeChatModel({
    messages: [{ role: "user", content: "Hi." }] as any,
    modelId: "openai/gpt-oss-120b",
    systemPrompt: "You are helpful",
    tools: {},
    mcpClientManager: {
      getAllToolsMetadata: vi.fn().mockReturnValue({}),
      listServers: vi.fn().mockReturnValue([]),
    } as any,
    heartbeatIntervalMs: 0,
    onEngineError: (event: EngineErrorEvent) => events.push(event),
    ...overrides,
  } as any);
  await lastExecution;
  return { events };
}

const busy = () =>
  new Response(
    JSON.stringify({
      code: "spending_reservation_busy",
      error: "busy",
      statusCode: 503,
      isRetryable: true,
      retryAfter: 10,
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );

describe("eval turns resend a step the spending lane refused as busy", () => {
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

  it("sends the step again and reports only the answer after the busy ones", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(busy())
      .mockResolvedValueOnce(busy())
      .mockResolvedValue(new Response("Bad Gateway", { status: 502 }));
    global.fetch = fetchSpy;

    const { events } = await runTurn({ retrySpendingBusy: true });

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    // The same step each time: never a later step, never a replayed turn.
    const bodies = fetchSpy.mock.calls.map(([, init]) =>
      JSON.parse(init.body as string),
    );
    expect(new Set(bodies.map((b) => `${b.turnId}:${b.stepIndex}`)).size).toBe(
      1,
    );
    expect(events).toEqual([expect.objectContaining({ httpStatus: 502 })]);
  });

  it("surfaces the busy refusal at once when the caller did not opt in", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(busy());
    global.fetch = fetchSpy;

    const { events } = await runTurn();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(events).toEqual([expect.objectContaining({ httpStatus: 503 })]);
  });

  it("stops waiting when the turn deadline fires", async () => {
    const controller = new AbortController();
    const fetchSpy = vi.fn().mockImplementation(async () => {
      controller.abort(new Error("turn deadline"));
      return busy();
    });
    global.fetch = fetchSpy;

    await runTurn({
      retrySpendingBusy: true,
      abortSignal: controller.signal,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
