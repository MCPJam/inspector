/**
 * The emulated engine must say WHICH SIDE of the model handover it died on.
 *
 * `MCPJamEngineErrorEvent.phase` is what stops an Inspector bug being filed as
 * a provider outage: `failedLayerForEngineError` maps `"setup"` → our layer and
 * everything else → `"model"`, and on the hosted eval path `model` becomes a
 * `providerError` that WITHDRAWS the trial's failures. Getting it wrong does
 * not just mislabel a row; it deletes evidence.
 *
 * `runChatEngineLoop` used to set `phase` at none of its three emit sites, so
 * every emulated-path failure resolved to `model` — including anything thrown
 * in preparation, which its outer `try` covers just as broadly as the harness's
 * does (trace-payload `structuredClone`, message scrubbing, tool narrowing,
 * `emitTurnStart`). The comment justifying the default said "every emitter that
 * omits a phase today is a real stream failure"; this engine's emitters were
 * the counter-example.
 *
 * ── why this file exists at all ──────────────────────────────────────────────
 *
 * `provider-error-attribution.test.ts` unit-tests the decision, and
 * `provider-error-plumbing.test.ts` covers the runner hops — but the latter
 * `vi.mock`s `driveHostedEvalTurn`, so its boundary sits ABOVE the code under
 * test here. A test written up there passes with this bug fully present. So
 * these drive the real engine through its public entry point and read the
 * events it actually emits.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeToolCallsFromMessages,
  hasUnresolvedToolCalls,
} from "@/shared/http-tool-calls";
import { handleMCPJamFreeChatModel } from "../mcpjam-stream-handler";
import { failedLayerForEngineError } from "../../services/evals/drive-hosted-eval-turn";

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
    createUIMessageStreamResponse: vi
      .fn()
      .mockReturnValue(
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

describe("the emulated engine reports which side of the handover it died on", () => {
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

  it("calls a failure BEFORE the handover setup, and never contacts the model", async () => {
    // `onStreamWriterReady` is the first statement inside the outer `try`, so
    // throwing here reproduces the whole class — a bug in our own preparation —
    // without reaching into the engine's internals to stage it.
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    const { events } = await runTurn({
      onStreamWriterReady: () => {
        throw new Error("preparation blew up before the model was asked");
      },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe("setup");
    // The claim that matters: our bug is not filed as the provider's.
    expect(failedLayerForEngineError(events[0])).toBe("setup");
  });

  it("calls a transport failure AT the handover stream, not setup", async () => {
    // The flag flips when the request leaves, not when a response arrives, so
    // a provider that refuses the connection outright is still the model's
    // failure rather than ours.
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    const { events } = await runTurn();

    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe("stream");
    expect(failedLayerForEngineError(events[0])).toBe("model");
  });

  it("calls a non-OK backend response stream", async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response("Bad Gateway", { status: 502 }));

    const { events } = await runTurn();

    expect(events).toHaveLength(1);
    // Pin the SITE, not just the answer. `"stream"` is what the outer catch
    // says too, so without this the test passes whether or not the response
    // site was ever reached — which is exactly how it passed before the
    // logger mock above was completed. `httpStatus` is site (1)'s alone.
    expect(events[0]).toMatchObject({ httpStatus: 502, stepIndex: 0 });
    expect(events[0].phase).toBe("stream");
    expect(failedLayerForEngineError(events[0])).toBe("model");
  });

  it("leaves no emitter in this engine without a phase", async () => {
    // A guard against the next site being added phase-less: the default is
    // `model`, so an omission is silent and re-opens exactly this bug.
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const { events } = await runTurn();
    for (const event of events) {
      expect(event.phase).toBeDefined();
    }
  });
});
