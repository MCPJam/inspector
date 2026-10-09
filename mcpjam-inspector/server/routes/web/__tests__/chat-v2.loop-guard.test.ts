import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The loop guard on `POST /api/web/chat-v2` (the Playground).
 *
 * Same runaway as Ask MCPJam's: a browser-fulfilled tool step that reached the
 * turn's step ceiling was resumed automatically, the engine could take no
 * further step, and the empty-but-successful answer left the browser's last
 * step looking settled — so it posted again, indefinitely. The route refuses
 * that continuation before it connects the caller's MCP servers.
 */

const {
  convexQueryMock,
  persistChatSessionToConvexMock,
  listCloudRuntimeSkillsMock,
  fetchHostRuntimeConfigMock,
  managerConstructions,
} = vi.hoisted(() => ({
  convexQueryMock: vi.fn(),
  persistChatSessionToConvexMock: vi.fn(),
  listCloudRuntimeSkillsMock: vi.fn(),
  fetchHostRuntimeConfigMock: vi.fn(),
  managerConstructions: { count: 0 },
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn(function () {
    return { setAuth: vi.fn(), query: convexQueryMock };
  }),
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    isMCPAuthError: vi.fn().mockReturnValue(false),
    MCPClientManager: vi.fn(function () {
      managerConstructions.count += 1;
      return {
        disconnectAllServers: vi.fn(),
        hasServer: () => false,
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        readResource: vi.fn().mockResolvedValue({ contents: [] }),
        getAllToolsMetadata: vi.fn().mockReturnValue({}),
        getToolsForAiSdk: vi.fn(async () => ({})),
      };
    }),
  };
});

vi.mock("../../../utils/chat-ingestion.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/chat-ingestion.js")
  >("../../../utils/chat-ingestion.js");
  return {
    ...actual,
    persistChatSessionToConvex: persistChatSessionToConvexMock,
    pickEnrichmentHeaders: vi.fn(() => ({})),
  };
});

vi.mock("../../../utils/computers/cloud-skill-tools.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/computers/cloud-skill-tools.js")
  >("../../../utils/computers/cloud-skill-tools.js");
  return {
    ...actual,
    listCloudRuntimeSkills: (...args: unknown[]) =>
      listCloudRuntimeSkillsMock(...args),
  };
});

vi.mock("../../../utils/host-runtime-config.js", () => ({
  fetchHostRuntimeConfig: fetchHostRuntimeConfigMock,
}));

vi.mock("../../../utils/harness/run-harness-turn", () => ({
  runHarnessTurn: vi.fn(),
}));

vi.mock("../apps.js", () => ({ default: new Hono() }));

import {
  DEFAULT_TURN_MAX_STEPS,
  STEP_LIMIT_REFUSAL_MESSAGE,
} from "../../../../shared/turn-step-budget.js";
import { createWebTestApp, postJson } from "./helpers/test-app.js";

const CONVEX_URL = "https://example.convex.site";
const PROJECT_ID = "project-1";
const MODEL = {
  id: "anthropic/claude-haiku-4.5",
  provider: "anthropic",
  name: "Claude Haiku 4.5",
};

let streamRequests = 0;

function sse(events: Array<Record<string, unknown>>): Response {
  const payload = `${events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;
  return new Response(payload, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

const REPLY = [
  { type: "text-start", id: "text-1" },
  { type: "text-delta", id: "text-1", delta: "Done." },
  { type: "text-end", id: "text-1" },
  {
    type: "finish",
    finishReason: "stop",
    totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  },
];

const userMessage = (id = "u1") => ({
  id,
  role: "user",
  parts: [{ type: "text", text: "Use the app to plan my trip" }],
});

/** Steps whose app tool the browser fulfilled — each one resumable. */
function assistantWithAppSteps(steps: number) {
  return {
    id: "a1",
    role: "assistant",
    parts: Array.from({ length: steps }).flatMap((_, index) => [
      { type: "step-start" },
      {
        type: "tool-app__trip__add_stop",
        toolCallId: `call-${index}`,
        state: "output-available",
        input: {},
        output: { content: [{ type: "text", text: "added" }] },
      },
    ]),
  };
}

function turn(messages: unknown[], extra: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT_ID,
    chatSessionId: "chat-loop-guard",
    selectedServerIds: [],
    accessScope: "chat_v2",
    model: MODEL,
    messages,
    ...extra,
  };
}

async function post(body: Record<string, unknown>) {
  const { app, token } = createWebTestApp();
  return postJson(app, "/api/web/chat-v2", body, token);
}

describe("web chat-v2 loop guard", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CONVEX_HTTP_URL", CONVEX_URL);
    vi.stubEnv("CONVEX_URL", "https://example.convex.cloud");
    managerConstructions.count = 0;
    streamRequests = 0;
    convexQueryMock.mockImplementation(async (ref: string) => {
      if (ref === "hostConfigsV2:getProjectDefault") return null;
      if (ref === "projects:getProjectCapabilities") {
        return { projectRole: "admin" };
      }
      throw new Error(`Unexpected Convex query: ${ref}`);
    });
    listCloudRuntimeSkillsMock.mockResolvedValue([]);
    persistChatSessionToConvexMock.mockResolvedValue(undefined);
    global.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url === `${CONVEX_URL}/web/authorize-project`) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === `${CONVEX_URL}/stream`) {
        streamRequests += 1;
        return sse(REPLY);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it("refuses a continuation whose step budget is spent, before connecting anything", async () => {
    const response = await post(
      turn([userMessage(), assistantWithAppSteps(DEFAULT_TURN_MAX_STEPS)]),
    );

    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload).toMatchObject({
      code: "AGENT_STEP_LIMIT",
      message: STEP_LIMIT_REFUSAL_MESSAGE,
      details: { reason: "step_limit", maxSteps: DEFAULT_TURN_MAX_STEPS },
    });
    expect(managerConstructions.count).toBe(0);
    expect(streamRequests).toBe(0);
    expect(persistChatSessionToConvexMock).not.toHaveBeenCalled();
  });

  it("lets a continuation under the ceiling run", async () => {
    const response = await post(
      turn([userMessage(), assistantWithAppSteps(3)]),
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(streamRequests).toBe(1);
  });

  it("gives a new user message a fresh budget", async () => {
    const response = await post(
      turn([
        userMessage("u1"),
        assistantWithAppSteps(DEFAULT_TURN_MAX_STEPS + 5),
        userMessage("u2"),
      ]),
    );
    await response.text();

    expect(response.status).toBe(200);
    expect(streamRequests).toBe(1);
  });

  it("leaves an explicit MRTR continuation to its own validation", async () => {
    // A resume descriptor is the user's answer to a suspended call, not an
    // automatic re-post, so the guard steps aside — here the route's own
    // descriptor check is what answers.
    const response = await post(
      turn([userMessage(), assistantWithAppSteps(DEFAULT_TURN_MAX_STEPS)], {
        mrtrResume: { nonsense: true },
      }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).message).toBe(
      "Malformed mrtrResume descriptor",
    );
  });
});
