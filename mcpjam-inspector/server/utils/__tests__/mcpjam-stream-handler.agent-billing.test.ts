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

const createSseResponse = (
  events: unknown[],
  opts: { confirmPlatformPaid?: string | null } = {},
) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(buildSsePayload(events)));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        // A real Convex that honours the claim stamps this. `null` models a
        // deployment that predates `billingFeature` and silently ignored it.
        ...(opts.confirmPlatformPaid === null
          ? {}
          : {
              "x-mcpjam-platform-paid":
                opts.confirmPlatformPaid ?? "mcpjam_agent",
            }),
      },
    },
  );

let lastExecution: Promise<void> | null = null;
let writtenParts: unknown[] = [];

/** Everything the handler wrote this turn, flattened for substring matching. */
const writtenText = () => JSON.stringify(writtenParts);

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    createUIMessageStream: vi.fn(({ execute, onFinish }: any) => {
      const writer = {
        write: vi.fn((part: unknown) => {
          writtenParts.push(part);
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
    writtenParts = [];
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

  it("refuses a turn the backend did not confirm as platform-paid", async () => {
    // The failure this guards: a backend that predates `billingFeature`
    // ignores it as an unknown body field, bills the customer's org, and
    // answers a perfectly ordinary 200. Sending the claim is not the same as
    // having it honoured, and a silent charge for a feature the product calls
    // free is the one outcome this whole feature exists to prevent.
    global.fetch = vi.fn().mockResolvedValue(
      createSseResponse(
        [
          {
            type: "finish",
            finishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
        { confirmPlatformPaid: null },
      ),
    );
    await runTurn({ billingFeature: "mcpjam_agent" });
    expect(writtenText()).toContain("agent_billing_rejected");
  });

  it("refuses when the backend confirms a DIFFERENT feature", async () => {
    // Not merely "a header is present". A confirmation for some other
    // platform-paid feature is not a confirmation for this turn.
    global.fetch = vi.fn().mockResolvedValue(
      createSseResponse(
        [
          {
            type: "finish",
            finishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
        { confirmPlatformPaid: "mcpjam_insights" },
      ),
    );
    await runTurn({ billingFeature: "mcpjam_agent" });
    expect(writtenText()).toContain("agent_billing_rejected");
  });

  it("proceeds when the backend confirms the claim", async () => {
    // The other half: the guard must not refuse the turns it exists to allow.
    await runTurn({ billingFeature: "mcpjam_agent" });
    expect(writtenText()).not.toContain("agent_billing_rejected");
  });

  it("sends a claimed turn to the PLATFORM route, never the ordinary one", async () => {
    // The route IS the claim. A claimed turn on `/stream` is either served (and
    // billed to the customer, on a backend that ignores the flag) or refused —
    // neither is what this feature wants, so the Inspector must not send one.
    await runTurn({ billingFeature: "mcpjam_agent" });
    const url = String(
      (global.fetch as unknown as { mock: { calls: any[][] } }).mock
        .calls[0]?.[0],
    );
    expect(url).toContain("/stream/platform");
  });

  it("sends an unclaimed turn to the ordinary route", async () => {
    await runTurn();
    const url = String(
      (global.fetch as unknown as { mock: { calls: any[][] } }).mock
        .calls[0]?.[0],
    );
    expect(url).toContain("/stream");
    expect(url).not.toContain("/platform");
  });

  it("refuses before any model work when the backend has no platform route", async () => {
    // The legacy-backend case. A 404 is the ROUTER refusing, so no admission
    // ran, no provider was called and nobody was charged — the only case where
    // that can be promised, and the reason the guarantee moved off the response
    // header onto the route.
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response("Not Found", { status: 404 }));

    await runTurn({ billingFeature: "mcpjam_agent" });

    const text = writtenText();
    expect(text).toContain("agent_billing_rejected");
    // The copy may promise no charge HERE, and only here.
    expect(text).toContain("nothing was charged");
    // Exactly one attempt, to the platform route: never a retry on `/stream`.
    const calls = (global.fetch as unknown as { mock: { calls: any[][] } }).mock
      .calls;
    expect(calls).toHaveLength(1);
    expect(String(calls[0]?.[0])).toContain("/stream/platform");
  });

  it("does not claim nothing was charged when the route exists but did not confirm", async () => {
    // The distinction that matters. A backend that DOES serve the platform
    // route and answers without confirming has already admitted and billed the
    // step, so the refusal stands but the copy must not promise otherwise.
    global.fetch = vi.fn().mockResolvedValue(
      createSseResponse(
        [
          {
            type: "finish",
            finishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
        { confirmPlatformPaid: null },
      ),
    );

    await runTurn({ billingFeature: "mcpjam_agent" });

    const text = writtenText();
    expect(text).toContain("agent_billing_rejected");
    expect(text).not.toContain("nothing was charged");
  });

  it("leaves an unclaimed turn alone, confirmation or not", async () => {
    // Today's Playground sends no claim, so it is billed to the customer on
    // purpose and must never be gated on a header it never asked for.
    global.fetch = vi.fn().mockResolvedValue(
      createSseResponse(
        [
          {
            type: "finish",
            finishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ],
        { confirmPlatformPaid: null },
      ),
    );
    await runTurn();
    expect(writtenText()).not.toContain("agent_billing_rejected");
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
