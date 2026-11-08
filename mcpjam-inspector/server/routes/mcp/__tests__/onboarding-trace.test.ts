import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { sha256Hex } from "@mcpjam/sdk/contract";

const handlers = vi.hoisted(() => ({ managed: vi.fn() }));
vi.mock("../../web/chat-v2.js", async () => {
  const { Hono } = await import("hono");
  return { default: new Hono(), handleManagedChatTurn: handlers.managed };
});
vi.mock("../../../services/chat-turn/local-request.js", async (original) => ({
  ...(await original<object>()),
  normalizeLocalManagedRequest: async (_context: unknown, body: unknown) => body,
}));

import mcp from "../index.js";
import { requestLogContextMiddleware } from "../../../middleware/request-log-context.js";
import {
  markOnboardingPhase,
  ONBOARDING_TURN_WATCHDOG_MS,
} from "../../../services/plugin-host/onboarding-trace.js";

const FIRST = "11111111-1111-4111-8111-111111111111";
const RETRY = "22222222-2222-4222-8222-222222222222";
const VERSION = "rn7gvrtpgmb9ygrtxfw99b18jh8hjegv";
const attemptHash = (id: string) => sha256Hex(`plugin.onboarding.attempt:${id}`);
const versionHash = sha256Hex(`plugin.onboarding.version:${VERSION}`);
const stream = 'data: {"type":"start-step"}\n\ndata: {"type":"finish"}\n\n';
const logged = vi.fn();

function post(attemptId?: string, signal?: AbortSignal) {
  const app = new Hono();
  app.use("/api/*", requestLogContextMiddleware);
  app.route("/api/mcp", mcp);
  return app.request("/api/mcp/chat-v2", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer local-test-member",
    },
    signal,
    body: JSON.stringify({
      projectId: "project",
      model: { id: "test-model", provider: "openai" },
      messages: [{
        role: "user",
        parts: [{ type: "text", text: "Run onboarding" }],
        ...(attemptId ? { metadata: {
          pluginOnboarding: { pluginVersionId: VERSION, attemptId },
        } } : {}),
      }],
    }),
  });
}

function traceEvents() {
  return logged.mock.calls
    .filter(([name]) => typeof name === "string" && name.startsWith("[event] plugin.onboarding."))
    .map(([, row]) => row);
}

describe("local onboarding trace route", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("DO_NOT_TRACK", "1");
    vi.spyOn(console, "log").mockImplementation(logged);
    logged.mockClear();
    handlers.managed.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("records a held local attempt and its distinct successful retry", async () => {
    let release: ((response: Response) => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    handlers.managed.mockImplementationOnce(async () => {
      markOnboardingPhase("admission");
      markOnboardingPhase("authorization");
      markOnboardingPhase("connection");
      entered?.();
      return new Promise<Response>((resolve) => { release = resolve; });
    });
    const controller = new AbortController();
    const first = post(FIRST, controller.signal);
    await started;
    await vi.advanceTimersByTimeAsync(ONBOARDING_TURN_WATCHDOG_MS);
    expect(traceEvents()).toEqual([expect.objectContaining({
      event: "plugin.onboarding.turn.stalled",
      onboardingAttemptHash: attemptHash(FIRST),
      onboardingVersionHash: versionHash,
      lastPhase: "connection",
      phases: {
        admission: expect.any(Number),
        authorization: expect.any(Number),
        connection: expect.any(Number),
      },
    })]);

    controller.abort();
    if (!release) throw new Error("Local route did not begin");
    release(new Response(null, { status: 499 }));
    expect((await first).status).toBe(499);
    expect(traceEvents().filter((row) => row.event === "plugin.onboarding.turn"))
      .toEqual([expect.objectContaining({
        onboardingAttemptHash: attemptHash(FIRST), onboardingVersionHash: versionHash,
        outcome: "cancelled", statusCode: 499,
      })]);

    handlers.managed.mockImplementationOnce(async () => {
      markOnboardingPhase("admission");
      markOnboardingPhase("tools");
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    });
    const retry = await post(RETRY);
    expect(await retry.text()).toBe(stream);
    expect(traceEvents().filter((row) => row.event === "plugin.onboarding.turn"))
      .toEqual([
        expect.objectContaining({ onboardingAttemptHash: attemptHash(FIRST), outcome: "cancelled" }),
        expect.objectContaining({
          onboardingAttemptHash: attemptHash(RETRY), onboardingVersionHash: versionHash,
          outcome: "success", statusCode: 200,
          phases: expect.objectContaining({
            admission: expect.any(Number), tools: expect.any(Number),
            model: expect.any(Number), terminal: expect.any(Number),
          }),
        }),
      ]);
    for (const id of [FIRST, RETRY, VERSION])
      expect(JSON.stringify(traceEvents())).not.toContain(id);
    expect(handlers.managed).toHaveBeenCalledTimes(2);
  });

  it("passes ordinary local turns through without onboarding events", async () => {
    handlers.managed.mockResolvedValue(new Response(stream, {
      headers: { "content-type": "text/event-stream" },
    }));
    const response = await post();
    expect(await response.text()).toBe(stream);
    await vi.advanceTimersByTimeAsync(ONBOARDING_TURN_WATCHDOG_MS);
    expect(traceEvents()).toEqual([]);
    expect(handlers.managed).toHaveBeenCalledOnce();
  });
});
