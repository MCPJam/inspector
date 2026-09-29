import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * The loop guard on `POST /api/web/mcpjam-agent`.
 *
 * The runaway it stops: a turn reached the agent's step ceiling with a settled
 * tool call in its last step. The engine could take no further step, so each
 * resumed request came back empty but successful, the browser's last step
 * still looked settled, and the browser posted the same history again every
 * few seconds for as long as the tab stayed open — connecting the docs
 * servers and persisting a turn each time. An open tab keeps its old
 * JavaScript, so the refusal has to come from here.
 */

const {
  streamWebChatTurnMock,
  disconnectAllServersMock,
  listToolsMock,
  managerConstructions,
  loggerEventMock,
} = vi.hoisted(() => ({
  streamWebChatTurnMock: vi.fn(),
  disconnectAllServersMock: vi.fn(),
  listToolsMock: vi.fn(async (_serverId?: unknown) => ({ tools: [] })),
  managerConstructions: { count: 0 },
  loggerEventMock: vi.fn(),
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  return {
    ...actual,
    isMCPAuthError: vi.fn().mockReturnValue(false),
    MCPClientManager: vi.fn().mockImplementation(() => {
      managerConstructions.count += 1;
      return {
        disconnectAllServers: disconnectAllServersMock,
        listTools: listToolsMock,
      };
    }),
  };
});

vi.mock("../../../utils/web-chat-turn.js", () => ({
  streamWebChatTurn: streamWebChatTurnMock,
}));

vi.mock("../apps.js", () => ({
  default: new Hono(),
}));

vi.mock("../../../utils/logger.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/logger.js")
  >("../../../utils/logger.js");
  return {
    ...actual,
    logger: { ...actual.logger, event: loggerEventMock },
  };
});

import { AGENT_MAX_STEPS } from "../../../../shared/mcpjam-agent-model.js";
import {
  REPEATED_TOOL_FAILURE_REFUSAL_MESSAGE,
  STEP_LIMIT_REFUSAL_MESSAGE,
} from "../../../../shared/turn-step-budget.js";
import { createWebTestApp, postJson } from "./helpers/test-app.js";

const userMessage = (text: string, id: string) => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});

/** A docs search the server ran — settled, so the browser's predicate reads
 *  the step as complete. */
const settledDocsSearch = (id: string) => ({
  type: "tool-search_mcpjam",
  toolCallId: id,
  state: "output-available",
  input: { query: "evals" },
  output: { content: [{ type: "text", text: "..." }] },
});

function assistantWithSteps(steps: number, id = "a") {
  return {
    id,
    role: "assistant",
    parts: Array.from({ length: steps }).flatMap((_, index) => [
      { type: "step-start" },
      settledDocsSearch(`${id}-call-${index}`),
    ]),
  };
}

/** Ten earlier prompts (prompt index 9 is the one that runs away), each
 *  answered, then the runaway prompt with the step budget spent. */
function incidentHistory(stepsOnLastPrompt: number) {
  const earlier = Array.from({ length: 9 }).flatMap((_, index) => [
    userMessage(`question ${index}`, `u${index}`),
    {
      id: `a${index}`,
      role: "assistant",
      parts: [
        { type: "step-start" },
        { type: "text", text: `answer ${index}` },
      ],
    },
  ]);
  return [
    ...earlier,
    userMessage("walk me through setting up an eval", "u9"),
    assistantWithSteps(stepsOnLastPrompt, "a9"),
  ];
}

function body(messages: unknown[]) {
  return {
    messages,
    model: { id: "anthropic/claude-haiku-4.5", provider: "anthropic" },
    chatSessionId: "agent-session-loop",
    projectId: "project-1",
  };
}

async function post(messages: unknown[]) {
  const { app, token } = createWebTestApp();
  return postJson(app, "/api/web/mcpjam-agent", body(messages), token);
}

describe("web routes — mcpjam-agent loop guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managerConstructions.count = 0;
    streamWebChatTurnMock.mockResolvedValue(
      new Response("ok", { status: 200 }),
    );
    listToolsMock.mockImplementation(async () => ({ tools: [] }));
  });

  it("refuses a continuation whose step budget is spent — no MCP connection, no model turn", async () => {
    const response = await post(incidentHistory(AGENT_MAX_STEPS));

    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.code).toBe("AGENT_STEP_LIMIT");
    expect(payload.message).toBe(STEP_LIMIT_REFUSAL_MESSAGE);
    expect(payload.details).toMatchObject({
      reason: "step_limit",
      steps: AGENT_MAX_STEPS,
      maxSteps: AGENT_MAX_STEPS,
    });
    // Cheap: nothing was connected and no turn ran (so none is persisted).
    expect(managerConstructions.count).toBe(0);
    expect(listToolsMock).not.toHaveBeenCalled();
    expect(streamWebChatTurnMock).not.toHaveBeenCalled();
  });

  it("logs one structured event per refusal, with counts and no content", async () => {
    await post(incidentHistory(AGENT_MAX_STEPS));

    const tripped = loggerEventMock.mock.calls.filter(
      ([name]) => name === "agent.loop_guard.tripped",
    );
    expect(tripped).toHaveLength(1);
    const [, base, payload] = tripped[0]!;
    // The request's own `http.request.completed` row carries the route, the
    // 409 and the code; this row says which surface and why.
    expect(base).toMatchObject({
      component: "utils.agent-loop-guard.mcpjam_agent",
    });
    expect(payload).toEqual({
      surface: "mcpjam_agent",
      reason: "step_limit",
      steps: AGENT_MAX_STEPS,
      maxSteps: AGENT_MAX_STEPS,
    });
    expect(JSON.stringify(payload)).not.toContain("walk me through");
  });

  it("replays the runaway: every re-post of the same spent prompt is refused", async () => {
    // What an open tab on the old client keeps doing: the same prompt, the
    // same spent budget, a new request every few seconds.
    const history = incidentHistory(AGENT_MAX_STEPS);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await post(history);
      expect(response.status).toBe(409);
    }
    expect(managerConstructions.count).toBe(0);
    expect(streamWebChatTurnMock).not.toHaveBeenCalled();
  });

  it("refuses when the model's call to one tool had its input rejected twice in a row", async () => {
    const rejected = (id: string) => ({
      type: "tool-ui_create_eval_case",
      toolCallId: id,
      state: "output-error",
      rawInput: '{"title":"Sign in and',
      errorText:
        "Invalid input for tool ui_create_eval_case: JSON parsing failed",
    });
    const response = await post([
      userMessage("draft the case", "u1"),
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          rejected("c1"),
          { type: "step-start" },
          rejected("c2"),
        ],
      },
    ]);

    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.code).toBe("AGENT_STEP_LIMIT");
    expect(payload.message).toBe(REPEATED_TOOL_FAILURE_REFUSAL_MESSAGE);
    expect(payload.details).toMatchObject({
      reason: "repeated_tool_input_error",
    });
    expect(streamWebChatTurnMock).not.toHaveBeenCalled();
    const [, , logged] = loggerEventMock.mock.calls.find(
      ([name]) => name === "agent.loop_guard.tripped",
    )!;
    expect(logged).toMatchObject({
      reason: "repeated_tool_input_error",
      toolName: "ui_create_eval_case",
    });
  });

  it("lets an ordinary multi-step tool loop under the ceiling continue", async () => {
    const response = await post([
      userMessage("add a server", "u1"),
      assistantWithSteps(AGENT_MAX_STEPS - 1),
    ]);

    expect(response.status).toBe(200);
    expect(streamWebChatTurnMock).toHaveBeenCalledTimes(1);
  });

  it("gives a new user message a fresh budget, whatever came before", async () => {
    const response = await post([
      ...incidentHistory(AGENT_MAX_STEPS),
      userMessage("ok, continue", "u10"),
    ]);

    expect(response.status).toBe(200);
    expect(streamWebChatTurnMock).toHaveBeenCalledTimes(1);
  });
});
