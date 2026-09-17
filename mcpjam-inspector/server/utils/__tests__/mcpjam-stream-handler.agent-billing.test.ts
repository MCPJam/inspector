/**
 * The wire half of Ask MCPJam's platform billing.
 *
 * The claim (`billingFeature`) is worthless on its own: Convex refuses it
 * without `x-inspector-service-token`, which proves the request came from our
 * own deployed server rather than from a browser holding a user bearer. The
 * bug this file exists to prevent is subtle — the token was only ever attached
 * by `guestIpForwardHeaders`, which attaches it ALONGSIDE an IP hash, so a
 * turn with no resolvable client IP would have sent a bare claim and been
 * refused at every step with nothing saying why.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleMCPJamFreeChatModel } from "../mcpjam-stream-handler";
import {
  describeBackendStreamFailure,
  describeStreamErrorChunkFailure,
  isUserOwnedDenialCode,
} from "../mcpjam-stream-handler";

const buildSsePayload = (events: unknown[]) =>
  `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;

const createSseResponse = (events: unknown[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(buildSsePayload(events)));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );

let lastExecution: Promise<void> | null = null;

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    createUIMessageStream: vi.fn(({ execute, onFinish }: any) => {
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
  hasUnresolvedToolCalls: vi.fn().mockReturnValue(false),
  executeToolCallsFromMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock("../chat-helpers", async () => {
  const actual =
    await vi.importActual<typeof import("../chat-helpers")>("../chat-helpers");
  return {
    ...actual,
    scrubMcpAppsToolResultsForBackend: vi.fn((messages) => messages),
    scrubChatGPTAppsToolResultsForBackend: vi.fn((messages) => messages),
  };
});

vi.mock("../mcpjam-tool-helpers", () => ({
  serializeToolsForConvex: vi.fn(() => []),
}));

async function runTurn(extraBodyFields?: Record<string, unknown>) {
  await handleMCPJamFreeChatModel({
    messages: [{ role: "user", content: "hi" }] as never,
    modelId: "anthropic/claude-haiku-4.5",
    systemPrompt: "You are helpful",
    tools: {},
    mcpClientManager: { getAllToolsMetadata: vi.fn(() => ({})) } as never,
    ...(extraBodyFields ? { extraBodyFields } : {}),
  } as never);
  await lastExecution;
  const call = (global.fetch as unknown as { mock: { calls: any[][] } }).mock
    .calls[0];
  return {
    headers: (call?.[1]?.headers ?? {}) as Record<string, string>,
    body: JSON.parse((call?.[1]?.body as string) ?? "{}"),
  };
}

describe("Ask MCPJam billing claim on the wire", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    lastExecution = null;
    process.env.CONVEX_HTTP_URL = "https://test-convex.example.com";
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "inspector-secret");
    global.fetch = vi.fn().mockResolvedValue(
      createSseResponse([
        {
          type: "finish",
          finishReason: "stop",
          totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ]),
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.CONVEX_HTTP_URL;
    vi.unstubAllEnvs();
  });

  it("sends the claim with the service token, with no client IP in play", async () => {
    const { headers, body } = await runTurn({ billingFeature: "mcpjam_agent" });
    expect(body.billingFeature).toBe("mcpjam_agent");
    expect(headers["x-inspector-service-token"]).toBe("inspector-secret");
  });

  it("sends the turn and step ids the backend keys the lane and caps on", async () => {
    const { body } = await runTurn({ billingFeature: "mcpjam_agent" });
    expect(typeof body.turnId).toBe("string");
    expect(body.turnId.length).toBeGreaterThan(0);
    expect(body.stepIndex).toBe(0);
  });

  it("sends neither for an ordinary turn", async () => {
    const { headers, body } = await runTurn();
    expect(body.billingFeature).toBeUndefined();
    expect(headers["x-inspector-service-token"]).toBeUndefined();
  });

  it("fails the turn loudly when the deployment has no service token", async () => {
    // Sending a claim that cannot be honoured would 403 every step and read to
    // the user as the agent being broken for no reason. A misconfigured
    // deployment should say so.
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    await runTurn({ billingFeature: "mcpjam_agent" });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("Ask MCPJam refusal codes are refusals, not outages", () => {
  const CODES = [
    "platform_capacity",
    "agent_turn_limit",
    "agent_billing_rejected",
  ];

  it("classifies all three as user-owned denials, so none pages", () => {
    for (const code of CODES) expect(isUserOwnedDenialCode(code)).toBe(true);
  });

  it("describes them with the platform-budget slug, not a provider wall", () => {
    // By status alone the 429s read as somebody else's quota and the 403 as
    // "the provider rejected the key". Neither is what happened.
    for (const [code, status] of [
      ["platform_capacity", 429],
      ["agent_turn_limit", 429],
      ["agent_billing_rejected", 403],
    ] as const) {
      expect(describeBackendStreamFailure(status, "{}", code).slug).toBe(
        "provider/mcpjam_platform_budget",
      );
      expect(describeStreamErrorChunkFailure(status, "{}", code).slug).toBe(
        "provider/mcpjam_platform_budget",
      );
    }
  });

  it("still calls the 503 ours", () => {
    // `platform_generation_unavailable` IS the lane guard failing closed.
    expect(isUserOwnedDenialCode("platform_generation_unavailable")).toBe(
      false,
    );
    expect(
      describeBackendStreamFailure(503, "{}", "platform_generation_unavailable")
        .origin,
    ).toBe("mcpjam");
  });
});
