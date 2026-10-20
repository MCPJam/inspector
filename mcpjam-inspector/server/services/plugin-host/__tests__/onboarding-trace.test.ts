import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const events = vi.hoisted(() => ({
  logged: [] as Array<{ event: string; payload: Record<string, unknown> }>,
}));
vi.mock("../../../utils/request-logger.js", () => ({
  getRequestLogger: () => ({
    event: (event: string, payload: Record<string, unknown>) =>
      events.logged.push({ event, payload }),
  }),
}));

import {
  ONBOARDING_TURN_WATCHDOG_MS,
  OnboardingTurnTrace,
  markOnboardingPhase,
  observeOnboardingStream,
  onboardingTurnTraceMiddleware,
} from "../onboarding-trace";

const FIRST = "11111111-1111-4111-8111-111111111111";
const RETRY = "22222222-2222-4222-8222-222222222222";
const intent = (attemptId = FIRST) => ({ pluginVersionId: "ver", attemptId });

function recorder() {
  const log = { turn: vi.fn(), stalled: vi.fn() };
  return log;
}

const sse = (...chunks: unknown[]) =>
  chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");

async function pipe(
  trace: OnboardingTurnTrace,
  parts: Array<string | Uint8Array>,
) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts)
        controller.enqueue(
          typeof part === "string" ? encoder.encode(part) : part,
        );
      controller.close();
    },
  });
  return new Response(body.pipeThrough(observeOnboardingStream(trace))).text();
}

describe("an onboarding turn's trace", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps the first time each phase was reached and logs the result once", () => {
    const log = recorder();
    const trace = new OnboardingTurnTrace(intent(), log);
    trace.mark("admission");
    vi.advanceTimersByTime(5);
    trace.mark("admission");
    trace.mark("tools");
    trace.finish("success", 200);
    trace.finish("error", 500, "late");

    expect(log.turn).toHaveBeenCalledTimes(1);
    const [turn] = log.turn.mock.calls[0];
    expect(turn).toMatchObject({
      attemptId: FIRST,
      pluginVersionId: "ver",
      outcome: "success",
      statusCode: 200,
      unavailableServers: 0,
    });
    expect(turn.phases.admission).toBe(0);
    expect(Object.keys(turn.phases)).toEqual([
      "admission",
      "tools",
      "terminal",
    ]);
    // A finished turn's watchdog is gone, so it never fires.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(ONBOARDING_TURN_WATCHDOG_MS * 2);
    expect(log.stalled).not.toHaveBeenCalled();
  });

  it("records where a turn with a hanging tools/list stopped, and a retry never replaces it", () => {
    const log = recorder();
    const stalled = new OnboardingTurnTrace(intent(FIRST), log);
    stalled.mark("admission");
    stalled.mark("authorization");
    stalled.mark("connection");
    // tools/list never answers.
    vi.advanceTimersByTime(ONBOARDING_TURN_WATCHDOG_MS);
    expect(log.stalled).toHaveBeenCalledTimes(1);
    expect(log.stalled.mock.calls[0][0]).toMatchObject({
      attemptId: FIRST,
      lastPhase: "connection",
      elapsedMs: ONBOARDING_TURN_WATCHDOG_MS,
    });
    expect(log.stalled.mock.calls[0][0].phases).not.toHaveProperty("tools");

    const retry = new OnboardingTurnTrace(intent(RETRY), log);
    for (const phase of [
      "admission",
      "authorization",
      "connection",
      "tools",
      "model",
      "first_output",
    ] as const)
      retry.mark(phase);
    retry.finish("success", 200);

    expect(log.turn).toHaveBeenCalledTimes(1);
    expect(log.turn.mock.calls[0][0]).toMatchObject({
      attemptId: RETRY,
      outcome: "success",
    });
    // The first try is still on record as stalled, under its own id.
    expect(log.stalled.mock.calls.map(([entry]) => entry.attemptId)).toEqual([
      FIRST,
    ]);
    // When the first try finally gives up, that is its own result.
    stalled.finish("cancelled", 499);
    expect(log.turn.mock.calls[1][0]).toMatchObject({
      attemptId: FIRST,
      outcome: "cancelled",
    });
  });
});

describe("reading the turn's stream", () => {
  it("passes every byte through and reads model, first output and success", async () => {
    const log = recorder();
    const trace = new OnboardingTurnTrace(intent(), log);
    const stream = sse(
      { type: "start" },
      { type: "start-step" },
      {
        type: "data-plugin-server-unavailable",
        transient: true,
        data: { servers: [{ serverId: "a", reason: "needs_auth" }] },
      },
      { type: "text-delta", id: "t", delta: "Héllo ✓" },
      { type: "finish" },
    );
    // Split mid-event, and inside a multi-byte character, as a network read
    // would.
    const bytes = new TextEncoder().encode(stream);
    const split = bytes.indexOf(0x9c);
    const text = await pipe(trace, [
      bytes.slice(0, 17),
      bytes.slice(17, split),
      bytes.slice(split),
      "data: [DONE]\n\n",
    ]);

    expect(text).toBe(`${stream}data: [DONE]\n\n`);
    const [turn] = log.turn.mock.calls[0];
    expect(turn).toMatchObject({ outcome: "success", unavailableServers: 1 });
    expect(Object.keys(turn.phases)).toEqual([
      "model",
      "first_output",
      "terminal",
    ]);
  });

  it("calls an error chunk an error, and a stream that just ends one too", async () => {
    const failed = recorder();
    await pipe(new OnboardingTurnTrace(intent(), failed), [
      sse({ type: "start-step" }, { type: "error", errorText: "secret" }),
    ]);
    expect(failed.turn.mock.calls[0][0]).toMatchObject({
      outcome: "error",
      code: "stream_error",
    });
    // The error's text never reaches the log.
    expect(JSON.stringify(failed.turn.mock.calls)).not.toContain("secret");

    const ended = recorder();
    await pipe(new OnboardingTurnTrace(intent(), ended), [
      sse({ type: "start-step" }),
    ]);
    expect(ended.turn.mock.calls[0][0]).toMatchObject({
      outcome: "error",
      code: "ended_without_finish",
    });
  });

  it("calls a turn the reader stopped reading cancelled", async () => {
    const log = recorder();
    const trace = new OnboardingTurnTrace(intent(), log);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse({ type: "start" })));
      },
    }).pipeThrough(observeOnboardingStream(trace));
    await body.cancel("closed");
    expect(log.turn.mock.calls[0][0]).toMatchObject({
      outcome: "cancelled",
      statusCode: 499,
    });
  });
});

describe("the chat route's onboarding trace", () => {
  beforeEach(() => {
    events.logged = [];
  });

  function app(respond: () => Response) {
    const web = new Hono();
    web.use("/chat-v2", onboardingTurnTraceMiddleware);
    web.post("/chat-v2", async (c) => {
      // The handler reads the same body after the middleware did.
      await c.req.json();
      markOnboardingPhase("admission");
      return respond();
    });
    return web;
  }
  const post = (web: Hono, metadata: unknown) =>
    web.request("/chat-v2", {
      method: "POST",
      body: JSON.stringify({
        messages: [
          { role: "user", metadata: { pluginOnboarding: intent() } },
          { role: "assistant" },
          { role: "user", metadata },
        ],
      }),
    });

  it("traces a turn whose last user message starts an onboarding try", async () => {
    const web = app(
      () => new Response(sse({ type: "start-step" }, { type: "finish" })),
    );
    const response = await post(web, { pluginOnboarding: intent(RETRY) });
    expect(await response.text()).toContain('"finish"');
    expect(events.logged).toEqual([
      {
        event: "plugin.onboarding.turn",
        payload: expect.objectContaining({
          attemptId: RETRY,
          outcome: "success",
          phases: expect.objectContaining({ admission: expect.any(Number) }),
        }),
      },
    ]);
  });

  it("hears the turn's tool listing through the code it runs", async () => {
    const { createTurnToolLister } =
      await import("../../../utils/plugin-server-isolation");
    const web = new Hono();
    web.use("/chat-v2", onboardingTurnTraceMiddleware);
    web.post("/chat-v2", async () => {
      const lister = createTurnToolLister({
        manager: {
          getToolsForAiSdkByServer: async () => ({}),
          getToolsForAiSdk: async () => ({}),
          listServers: () => [],
        },
        serverIds: [],
        isolatedServers: [],
        keysOf: (id) => [id],
        toolOptions: {},
        within: (listing) => listing,
      });
      await lister.byServer();
      return new Response(sse({ type: "finish" }));
    });
    await (await post(web, { pluginOnboarding: intent() })).text();
    expect(Object.keys(events.logged[0].payload.phases as object)).toEqual([
      "authorization",
      "connection",
      "tools",
      "terminal",
    ]);
  });

  it("logs a refused turn with its status", async () => {
    const web = app(() => new Response("{}", { status: 403 }));
    await post(web, { pluginOnboarding: intent() });
    expect(events.logged[0].payload).toMatchObject({
      outcome: "error",
      statusCode: 403,
      code: "http_403",
    });
  });

  it("leaves every other turn alone, including one with an unreadable attempt", async () => {
    for (const metadata of [
      undefined,
      { senderUserId: "u" },
      { pluginOnboarding: { pluginVersionId: "ver", attemptId: "not-a-uuid" } },
    ]) {
      const web = app(() => new Response(sse({ type: "finish" })));
      const response = await post(web, metadata);
      expect(response.status).toBe(200);
    }
    expect(events.logged).toEqual([]);
  });
});
