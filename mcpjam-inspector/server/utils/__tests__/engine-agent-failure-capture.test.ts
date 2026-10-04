/**
 * Ask MCPJam's engine failures reach Sentry, classified — and nothing else's
 * capture changes.
 *
 * Drives `handleMCPJamFreeChatModel` through the REAL classification path
 * (`reportRouteFailure` → `maybeCaptureOriginError`), mocking only the Sentry
 * seam, so a pass means the policy actually travels from the route option to a
 * capture call. The Playground cases (no `failureCapture`) pin that its
 * behaviour is unchanged: a user-owned denial still pages nobody, and its trace
 * events carry no `captured` field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeToolCallsFromMessages,
  hasUnresolvedToolCalls,
} from "@/shared/http-tool-calls";
import { handleMCPJamFreeChatModel } from "../mcpjam-stream-handler";
import { reportRouteFailure } from "../route-error-report";
import type {
  StreamFailureEvent,
  StreamFailureReporter,
} from "../stream-failure-reporter";
import { MCPJAM_AGENT_FAILURE_CAPTURE } from "../agent-failure-capture";
import { captureOriginErrorToSentry } from "../logger";
import { hashGuestSpendIp } from "../guest-spend-ip";

let lastExecution: Promise<void> | null = null;
let writtenChunks: any[] = [];

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    createUIMessageStream: vi.fn(({ execute, onFinish }) => {
      const writer = {
        write: vi.fn((chunk) => {
          writtenChunks.push(chunk);
        }),
      };
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

vi.mock("../guest-spend-ip", async () => {
  const actual =
    await vi.importActual<typeof import("../guest-spend-ip")>(
      "../guest-spend-ip",
    );
  return { ...actual, hashGuestSpendIp: vi.fn(actual.hashGuestSpendIp) };
});

vi.mock("../logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    event: vi.fn(),
    systemEvent: vi.fn(),
  },
  captureOriginErrorToSentry: vi.fn(),
}));

const capture = vi.mocked(captureOriginErrorToSentry);

/** The engine's classification, for real, recording each event. */
function realReporter(): {
  reporter: StreamFailureReporter;
  calls: StreamFailureEvent[];
} {
  const calls: StreamFailureEvent[] = [];
  const reporter: StreamFailureReporter = (e) => {
    calls.push(e);
    return reportRouteFailure(e.message, e.error, {
      source: e.source,
      hop: e.hop,
      ...(e.normalized ? { normalized: e.normalized } : {}),
      ...(e.context ? { context: e.context } : {}),
      ...(e.capture ? { capture: e.capture } : {}),
    });
  };
  return { reporter, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function traceErrors() {
  return writtenChunks
    .filter((c) => c?.type === "data-trace-event" && c.data?.type === "error")
    .map((c) => c.data);
}

function captured(index = 0) {
  const call = capture.mock.calls[index];
  return call?.[1] as {
    tags: Record<string, string>;
    fingerprint?: string[];
    level?: string;
  };
}

async function runTurn(overrides: Record<string, unknown> = {}) {
  await handleMCPJamFreeChatModel({
    messages: [{ role: "user", content: "Hi." }] as any,
    modelId: "openai/gpt-5.6-luna",
    systemPrompt: "You are helpful",
    tools: {},
    mcpClientManager: {
      getAllToolsMetadata: vi.fn().mockReturnValue({}),
      listServers: vi.fn().mockReturnValue([]),
    } as any,
    heartbeatIntervalMs: 0,
    ...overrides,
  } as any);
  await lastExecution;
}

const agent = (reporter: StreamFailureReporter) => ({
  failureReporter: reporter,
  failureCapture: MCPJAM_AGENT_FAILURE_CAPTURE,
});

describe("Ask MCPJam engine failures reach Sentry", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    lastExecution = null;
    writtenChunks = [];
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    vi.mocked(hasUnresolvedToolCalls).mockReturnValue(false);
    vi.mocked(executeToolCallsFromMessages).mockResolvedValue([]);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
  });

  it("captures a throw before the model handover", async () => {
    vi.mocked(hashGuestSpendIp).mockRejectedValueOnce(
      new Error("ip hashing failed"),
    );
    global.fetch = vi.fn();
    const { reporter } = realReporter();

    await runTurn({ ...agent(reporter), clientIp: "203.0.113.9" });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(capture).toHaveBeenCalledTimes(1);
    expect(captured().tags).toMatchObject({
      surface: "mcpjam_agent",
      page_class: "incident",
    });
    expect(traceErrors()).toEqual([
      expect.objectContaining({ captured: true }),
    ]);
  });

  it("captures a 403 refusal as an incident, keyed by its reason", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(403, {
        ok: false,
        code: "agent_billing_rejected",
        reason: "credential_not_allowed",
        error: "Ask MCPJam could not authorize this turn.",
      }),
    );
    const { reporter, calls } = realReporter();

    await runTurn(agent(reporter));

    expect(capture).toHaveBeenCalledTimes(1);
    expect(captured().tags).toMatchObject({
      surface: "mcpjam_agent",
      page_class: "incident",
      agent_failure_code: "agent_billing_rejected",
    });
    expect(captured().level).toBe("error");
    expect(captured().fingerprint).toEqual(
      expect.arrayContaining(["reason:credential_not_allowed"]),
    );
    // `reason` is read off the body the backend actually sends.
    expect(calls[0]!.context).toMatchObject({
      reason: "credential_not_allowed",
    });
    expect(traceErrors()).toEqual([
      expect.objectContaining({ captured: true }),
    ]);
  });

  it("captures a turn-cap 429 as routine, keyed by what gated it", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(429, {
        ok: false,
        code: "agent_turn_limit",
        gatedBy: "user",
        error: "You've reached today's Ask MCPJam limit.",
      }),
    );
    const { reporter } = realReporter();

    await runTurn(agent(reporter));

    expect(captured().tags.page_class).toBe("routine");
    expect(captured().level).toBe("warning");
    expect(captured().fingerprint).toEqual(
      expect.arrayContaining(["gatedBy:user"]),
    );
  });

  it.each([
    ["user", "routine"],
    ["organization", "routine"],
    ["platform", "incident"],
  ])(
    "classifies a lane refusal scoped to %s as %s",
    async (scope, pageClass) => {
      global.fetch = vi.fn().mockResolvedValue(
        jsonResponse(429, {
          ok: false,
          code: "platform_capacity",
          scope,
          error: "Budget used up.",
        }),
      );
      const { reporter } = realReporter();

      await runTurn(agent(reporter));

      expect(captured().tags.page_class).toBe(pageClass);
      expect(captured().fingerprint).toEqual(
        expect.arrayContaining([`scope:${scope}`]),
      );
    },
  );

  it("captures a Convex fetch that throws", async () => {
    global.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const { reporter } = realReporter();

    await runTurn(agent(reporter));

    expect(capture).toHaveBeenCalledTimes(1);
    expect(captured().tags.page_class).toBe("incident");
  });

  it("does not capture an abort", async () => {
    const controller = new AbortController();
    global.fetch = vi.fn().mockImplementation(async () => {
      controller.abort();
      throw Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      });
    });
    const { reporter, calls } = realReporter();

    await runTurn({ ...agent(reporter), abortSignal: controller.signal });

    expect(calls).toHaveLength(0);
    expect(capture).not.toHaveBeenCalled();
  });

  it("leaves the Playground unchanged: a user-owned denial pages nobody", async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse(429, {
        ok: false,
        code: "agent_turn_limit",
        gatedBy: "user",
        error: "limit",
      }),
    );
    const { reporter } = realReporter();

    await runTurn({ failureReporter: reporter });

    expect(capture).not.toHaveBeenCalled();
    // And its trace events are byte-identical: no `captured` field.
    expect(traceErrors()).toHaveLength(1);
    expect(traceErrors()[0]).not.toHaveProperty("captured");
  });
});
