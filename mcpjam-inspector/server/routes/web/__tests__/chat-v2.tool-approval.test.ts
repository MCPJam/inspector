import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * Tool approval on `POST /api/web/chat-v2`, end to end (MJ-008).
 *
 * Only the edges are stubbed: Convex (the model stream, the saved project
 * config, the caller's project role) and the `/api/v1` surface the workspace
 * tools call. The route, the built-in tool policy, the tool builders and the
 * chat engine are the real ones, so the SSE stream read here is the one a
 * browser would read, and the `/api/v1` calls recorded here are the ones the
 * workspace tools made.
 */

const {
  convexQueryMock,
  persistChatSessionToConvexMock,
  listCloudRuntimeSkillsMock,
  fetchHostRuntimeConfigMock,
  mcpToolExecuteMock,
} = vi.hoisted(() => ({
  convexQueryMock: vi.fn(),
  persistChatSessionToConvexMock: vi.fn(),
  listCloudRuntimeSkillsMock: vi.fn(),
  fetchHostRuntimeConfigMock: vi.fn(),
  mcpToolExecuteMock: vi.fn(),
}));

vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn().mockImplementation(() => ({
    setAuth: vi.fn(),
    query: convexQueryMock,
  })),
}));

// The caller's own MCP server: one tool, built the way the SDK builds it —
// with the approval declaration the route asked for.
vi.mock("@mcpjam/sdk", async () => {
  const actual =
    await vi.importActual<typeof import("@mcpjam/sdk")>("@mcpjam/sdk");
  const { jsonSchema } = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    isMCPAuthError: vi.fn().mockReturnValue(false),
    MCPClientManager: vi.fn().mockImplementation(() => ({
      disconnectAllServers: vi.fn(),
      hasServer: (id: string) => id === "server-1",
      listTools: vi.fn().mockResolvedValue({ tools: [] }),
      readResource: vi.fn().mockResolvedValue({ contents: [] }),
      getAllToolsMetadata: vi.fn().mockReturnValue({}),
      getToolsForAiSdk: vi.fn(
        async (serverIds: string[], options?: { needsApproval?: boolean }) =>
          serverIds.includes("server-1")
            ? {
                search_docs: {
                  description: "Search the docs",
                  inputSchema: jsonSchema({
                    type: "object",
                    properties: { q: { type: "string" } },
                  }),
                  execute: mcpToolExecuteMock,
                  _serverId: "server-1",
                  ...(options?.needsApproval ? { needsApproval: true } : {}),
                },
              }
            : {},
      ),
    })),
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

// Nothing here runs a harness turn; the engine imports the runner at load.
vi.mock("../../../utils/harness/run-harness-turn", () => ({
  runHarnessTurn: vi.fn(),
}));

vi.mock("../apps.js", () => ({ default: new Hono() }));

import {
  isReadOnlyMcpjamToolId,
  MCPJAM_TOOL_IDS,
} from "../../../utils/built-in-tools/mcpjam.js";
import { registerSelfFetch } from "../../../utils/self-app.js";
import {
  mintToolApprovalId,
  TOOL_APPROVAL_TOKEN_MAX_AGE_MS,
  toolApprovalBindingFor,
} from "../../../utils/tool-approval-token.js";
import { createWebTestApp, postJson } from "./helpers/test-app.js";

const CONVEX_URL = "https://example.convex.site";
const PROJECT_ID = "project-1";
/** The caller's bearer; approvals are bound to it. */
const BEARER = "test-token-123";
const MODEL = {
  id: "anthropic/claude-haiku-4.5",
  provider: "anthropic",
  name: "Claude Haiku 4.5",
};
/** A turn that can list projects and their servers, and add a server. */
const SERVER_TOOL_IDS = [
  "list_projects",
  "list_project_servers",
  "create_project_server",
];
const SERVER_INPUT = {
  body: {
    name: "Docs",
    enabled: true,
    transportType: "http",
    url: "https://mcp.example.test/mcp",
  },
};

type StreamEvent = Record<string, unknown>;
type V1Call = { method: string; path: string };

/** What the model says, one entry per `/stream` request, in order. */
let modelSteps: StreamEvent[][] = [];
/** The `/stream` request bodies the engine sent. */
let modelRequests: Array<{ tools?: Array<{ name?: string }> }> = [];
/** Every `/api/v1` request a workspace tool made. */
let v1Calls: V1Call[] = [];
let chatCounter = 0;

function sse(events: StreamEvent[]): Response {
  const payload = `${events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;
  return new Response(payload, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** A model step that calls one tool. */
function callsTool(
  toolName: string,
  toolCallId: string,
  input: Record<string, unknown> = {},
): StreamEvent[] {
  return [
    { type: "tool-input-start", toolCallId, toolName },
    { type: "tool-input-available", toolCallId, toolName, input },
    {
      type: "finish",
      finishReason: "tool-calls",
      totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  ];
}

const REPLY: StreamEvent[] = [
  { type: "text-start", id: "text-1" },
  { type: "text-delta", id: "text-1", delta: "Done." },
  { type: "text-end", id: "text-1" },
  {
    type: "finish",
    finishReason: "stop",
    totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  },
];

function v1Json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** The platform API as the workspace tools see it. */
function v1Response(method: string, path: string): Response {
  if (method === "GET" && path === "/api/v1/projects") {
    return v1Json({
      items: [
        {
          id: PROJECT_ID,
          name: "Project One",
          description: null,
          icon: null,
          organizationId: "org-1",
          visibility: "private",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });
  }
  if (path === `/api/v1/projects/${PROJECT_ID}/servers`) {
    return method === "GET"
      ? v1Json({ items: [] })
      : v1Json({
          id: "srv-new",
          projectId: PROJECT_ID,
          name: "Docs",
          enabled: true,
          transportType: "http",
          url: "https://mcp.example.test/mcp",
          useOAuth: false,
          hasClientSecret: false,
          createdAt: 1,
          updatedAt: 1,
        });
  }
  return v1Json({});
}

/** The requests that change something, as opposed to the reads. */
function v1Writes(): V1Call[] {
  return v1Calls.filter((call) => call.method !== "GET");
}

function newChatId(): string {
  chatCounter += 1;
  return `chat-approval-${chatCounter}`;
}

function userMessage(text = "Add the docs server to this project") {
  return { id: "u1", role: "user", parts: [{ type: "text", text }] };
}

function turn(
  chatSessionId: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    projectId: PROJECT_ID,
    chatSessionId,
    selectedServerIds: [],
    accessScope: "chat_v2",
    model: MODEL,
    builtInToolIds: SERVER_TOOL_IDS,
    requireToolApproval: false,
    messages: [userMessage()],
    ...extra,
  };
}

/** The same conversation, resumed with the user's answer to one approval. */
function resumeTurn(
  chatSessionId: string,
  args: {
    toolName: string;
    toolCallId: string;
    input: Record<string, unknown>;
    approvalId: string;
    approved?: boolean;
  },
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return turn(chatSessionId, {
    messages: [
      userMessage(),
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: `tool-${args.toolName}`,
            toolCallId: args.toolCallId,
            state: "approval-responded",
            input: args.input,
            approval: { id: args.approvalId, approved: args.approved ?? true },
          },
        ],
      },
    ],
    ...extra,
  });
}

async function send(body: Record<string, unknown>): Promise<StreamEvent[]> {
  const { app, token } = createWebTestApp({ bearerToken: BEARER });
  const response = await postJson(app, "/api/web/chat-v2", body, token);
  const text = await response.text();
  expect(response.status, text.slice(0, 500)).toBe(200);
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice("data: ".length)) as StreamEvent);
}

function approvalRequestFor(
  chunks: StreamEvent[],
  toolCallId: string,
): StreamEvent | undefined {
  return chunks.find(
    (chunk) =>
      chunk.type === "tool-approval-request" && chunk.toolCallId === toolCallId,
  );
}

function outputFor(
  chunks: StreamEvent[],
  toolCallId: string,
): StreamEvent | undefined {
  return chunks.find(
    (chunk) =>
      (chunk.type === "tool-output-available" ||
        chunk.type === "tool-output-error" ||
        chunk.type === "tool-output-denied") &&
      chunk.toolCallId === toolCallId,
  );
}

/** The tool names the engine offered the model on its first step. */
function offeredTools(): string[] {
  return (modelRequests[0]?.tools ?? []).map((tool) => String(tool.name));
}

/** Pause on `create_project_server` and return the approval the server issued. */
async function pauseOnCreate(chatSessionId: string, toolCallId: string) {
  modelSteps = [callsTool("create_project_server", toolCallId, SERVER_INPUT)];
  const chunks = await send(turn(chatSessionId));
  const request = approvalRequestFor(chunks, toolCallId);
  expect(request).toBeDefined();
  return String(request!.approvalId);
}

function savedProjectConfig(config: Record<string, unknown> | null) {
  convexQueryMock.mockImplementation(async (ref: string) => {
    if (ref === "hostConfigsV2:getProjectDefault") return config;
    if (ref === "projects:getProjectCapabilities") {
      return { projectRole: "admin" };
    }
    throw new Error(`Unexpected Convex query: ${ref}`);
  });
}

describe("web chat tool approval (MJ-008)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("CONVEX_HTTP_URL", CONVEX_URL);
    vi.stubEnv("CONVEX_URL", "https://example.convex.cloud");
    modelSteps = [];
    modelRequests = [];
    v1Calls = [];
    savedProjectConfig(null);
    listCloudRuntimeSkillsMock.mockResolvedValue([]);
    persistChatSessionToConvexMock.mockResolvedValue(undefined);
    mcpToolExecuteMock.mockResolvedValue({
      content: [{ type: "text", text: "found it" }],
    });
    registerSelfFetch(async (request) => {
      const url = new URL(request.url);
      v1Calls.push({ method: request.method, path: url.pathname });
      return v1Response(request.method, url.pathname);
    });
    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url === `${CONVEX_URL}/web/authorize-project`) {
        return v1Json({ ok: true });
      }
      if (url === `${CONVEX_URL}/web/authorize-batch`) {
        const payload = JSON.parse(String(init?.body ?? "{}"));
        return v1Json({
          results: Object.fromEntries(
            (payload.serverIds ?? []).map((serverId: string) => [
              serverId,
              {
                ok: true,
                role: "member",
                accessLevel: "shared_chat",
                permissions: { chatOnly: false },
                internalLogContext: {
                  authType: "signedIn",
                  userId: "u-1",
                  projectId: payload.projectId ?? null,
                },
                serverConfig: {
                  transportType: "http",
                  url: `https://${serverId}.example.test/mcp`,
                  headers: {},
                  useOAuth: false,
                },
              },
            ]),
          ),
        });
      }
      if (url === `${CONVEX_URL}/stream`) {
        modelRequests.push(JSON.parse(String(init?.body ?? "{}")));
        return sse(modelSteps.shift() ?? REPLY);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  describe("a turn that can add a project server", () => {
    it.each([
      ["a project with no saved default config", null],
      [
        "a saved default config with approval off",
        { builtInToolIds: SERVER_TOOL_IDS, requireToolApproval: false },
      ],
      [
        "a saved default config with approval on",
        { builtInToolIds: SERVER_TOOL_IDS, requireToolApproval: true },
      ],
    ])(
      "pauses create_project_server for %s and creates nothing",
      async (_label, config) => {
        savedProjectConfig(config);
        modelSteps = [
          callsTool("create_project_server", "call-create", SERVER_INPUT),
        ];

        const chunks = await send(turn(newChatId()));

        expect(offeredTools()).toEqual(expect.arrayContaining(SERVER_TOOL_IDS));
        const request = approvalRequestFor(chunks, "call-create");
        expect(request?.approvalId).toEqual(expect.any(String));
        expect(outputFor(chunks, "call-create")).toBeUndefined();
        expect(v1Calls).toEqual([]);
        // The turn stopped at the pause: the model was asked once.
        expect(modelRequests).toHaveLength(1);
      },
    );

    it("runs the pure reads without a pause", async () => {
      modelSteps = [callsTool("list_projects", "call-list"), REPLY];

      const chunks = await send(turn(newChatId()));

      expect(approvalRequestFor(chunks, "call-list")).toBeUndefined();
      expect(outputFor(chunks, "call-list")?.type).toBe(
        "tool-output-available",
      );
      expect(v1Calls).toEqual([{ method: "GET", path: "/api/v1/projects" }]);
    });
  });

  describe("workspace operations that change state", () => {
    // Every advertised workspace operation that is not read-only, read off
    // the operations themselves rather than listed here.
    const WRITES = MCPJAM_TOOL_IDS.filter((id) => !isReadOnlyMcpjamToolId(id));

    it("include the persona, goal, swarm, finding, backtest and cancel writes", () => {
      expect(WRITES).toEqual(
        expect.arrayContaining([
          "create_project_server",
          "create_persona",
          "update_persona",
          "create_goal",
          "update_goal",
          "create_swarm",
          "update_swarm",
          "dismiss_swarm_finding",
          "undismiss_swarm_finding",
          "dismiss_study_finding",
          "undismiss_study_finding",
          "backtest_eval_run",
          "cancel_eval_run",
          "cancel_readiness_run",
          "cancel_project_server_connection",
        ]),
      );
    });

    it.each(WRITES)(
      "pause %s whatever the approval setting says",
      async (toolName) => {
        savedProjectConfig({
          builtInToolIds: [toolName],
          requireToolApproval: false,
        });
        modelSteps = [callsTool(toolName, "call-write")];

        const chunks = await send(
          turn(newChatId(), {
            builtInToolIds: [toolName],
            requireToolApproval: false,
          }),
        );

        expect(approvalRequestFor(chunks, "call-write")).toBeDefined();
        expect(outputFor(chunks, "call-write")).toBeUndefined();
        expect(v1Calls).toEqual([]);
      },
    );
  });

  describe("reads that open a connection to a saved server", () => {
    const DIAGNOSE_INPUT = { server: "Docs" };

    async function diagnose(
      config: Record<string, unknown> | null,
      requireToolApproval: boolean,
    ) {
      savedProjectConfig(config);
      modelSteps = [
        callsTool("diagnose_server", "call-diagnose", DIAGNOSE_INPUT),
        REPLY,
      ];
      return send(
        turn(newChatId(), {
          builtInToolIds: ["diagnose_server"],
          requireToolApproval,
        }),
      );
    }

    it("pause when the project has no saved default config", async () => {
      const chunks = await diagnose(null, false);
      expect(approvalRequestFor(chunks, "call-diagnose")).toBeDefined();
      expect(v1Calls).toEqual([]);
    });

    it("pause when the saved config has approval on, whatever the request says", async () => {
      const chunks = await diagnose(
        { builtInToolIds: ["diagnose_server"], requireToolApproval: true },
        false,
      );
      expect(approvalRequestFor(chunks, "call-diagnose")).toBeDefined();
      expect(v1Calls).toEqual([]);
    });

    it("run without a pause when the saved config has approval off", async () => {
      const chunks = await diagnose(
        { builtInToolIds: ["diagnose_server"], requireToolApproval: false },
        false,
      );
      expect(approvalRequestFor(chunks, "call-diagnose")).toBeUndefined();
      expect(outputFor(chunks, "call-diagnose")).toBeDefined();
      expect(v1Calls.length).toBeGreaterThan(0);
    });

    it("pause when the request turns approval on over a saved setting that is off", async () => {
      const chunks = await diagnose(
        { builtInToolIds: ["diagnose_server"], requireToolApproval: false },
        true,
      );
      expect(approvalRequestFor(chunks, "call-diagnose")).toBeDefined();
      expect(v1Calls).toEqual([]);
    });

    it("follow the saved client's setting on a host-bound turn", async () => {
      fetchHostRuntimeConfigMock.mockResolvedValue({
        ok: true,
        config: {
          builtInToolIds: ["diagnose_server"],
          requireToolApproval: true,
        },
      });
      modelSteps = [
        callsTool("diagnose_server", "call-diagnose", DIAGNOSE_INPUT),
      ];

      const chunks = await send(
        turn(newChatId(), {
          hostId: "host-1",
          builtInToolIds: ["diagnose_server"],
          requireToolApproval: false,
        }),
      );

      expect(approvalRequestFor(chunks, "call-diagnose")).toBeDefined();
      expect(v1Calls).toEqual([]);
    });
  });

  describe("the caller's own MCP server tools", () => {
    async function searchDocs(requireToolApproval: boolean) {
      savedProjectConfig({ builtInToolIds: [], requireToolApproval: true });
      modelSteps = [
        callsTool("search_docs", "call-search", { q: "install" }),
        REPLY,
      ];
      return send(
        turn(newChatId(), {
          selectedServerIds: ["server-1"],
          builtInToolIds: [],
          requireToolApproval,
        }),
      );
    }

    it("run without a pause when the request turns approval off", async () => {
      const chunks = await searchDocs(false);
      expect(approvalRequestFor(chunks, "call-search")).toBeUndefined();
      expect(mcpToolExecuteMock).toHaveBeenCalledTimes(1);
    });

    it("pause when the request turns approval on", async () => {
      const chunks = await searchDocs(true);
      expect(approvalRequestFor(chunks, "call-search")).toBeDefined();
      expect(mcpToolExecuteMock).not.toHaveBeenCalled();
    });
  });

  describe("answering an approval", () => {
    it("creates the server once the approval the server issued comes back", async () => {
      const chatId = newChatId();
      const approvalId = await pauseOnCreate(chatId, "call-create");
      modelSteps = [REPLY];

      const chunks = await send(
        resumeTurn(chatId, {
          toolName: "create_project_server",
          toolCallId: "call-create",
          input: SERVER_INPUT,
          approvalId,
        }),
      );

      expect(outputFor(chunks, "call-create")?.type).toBe(
        "tool-output-available",
      );
      expect(v1Writes()).toEqual([
        { method: "POST", path: `/api/v1/projects/${PROJECT_ID}/servers` },
      ]);
    });

    it("does not create it again when the same approval comes back a second time", async () => {
      const chatId = newChatId();
      const approvalId = await pauseOnCreate(chatId, "call-create");
      const answer = resumeTurn(chatId, {
        toolName: "create_project_server",
        toolCallId: "call-create",
        input: SERVER_INPUT,
        approvalId,
      });

      modelSteps = [REPLY];
      await send(answer);
      expect(v1Writes()).toHaveLength(1);

      modelSteps = [REPLY];
      const again = await send(answer);
      const shown = outputFor(again, "call-create") as
        { type?: string; errorText?: string } | undefined;
      expect(shown?.type).toBe("tool-output-error");
      expect(shown?.errorText).toMatch(/already used/);
      expect(v1Writes()).toHaveLength(1);
    });

    /** An approval this server would have issued for the call `ageMs` ago. */
    function approvalIssuedAgo(chatSessionId: string, ageMs: number) {
      const id = mintToolApprovalId({
        call: {
          toolCallId: "call-create",
          toolName: "create_project_server",
          input: SERVER_INPUT,
        },
        binding: toolApprovalBindingFor({
          authHeader: `Bearer ${BEARER}`,
          projectId: PROJECT_ID,
          chatSessionId,
        }),
        nowMs: Date.now() - ageMs,
      });
      if (!id) throw new Error("test process has no approval signing key");
      return id;
    }

    it("creates nothing for an approval past its lifetime, and says it expired", async () => {
      const chatId = newChatId();
      modelSteps = [REPLY];

      const chunks = await send(
        resumeTurn(chatId, {
          toolName: "create_project_server",
          toolCallId: "call-create",
          input: SERVER_INPUT,
          approvalId: approvalIssuedAgo(
            chatId,
            TOOL_APPROVAL_TOKEN_MAX_AGE_MS + 60_000,
          ),
        }),
      );

      const shown = outputFor(chunks, "call-create") as
        { type?: string; errorText?: string } | undefined;
      expect(shown?.type).toBe("tool-output-error");
      expect(shown?.errorText).toMatch(/expired/);
      expect(shown?.errorText).toMatch(/nothing was run/);
      expect(v1Calls).toEqual([]);
    });

    it("creates the server once for an approval just inside its lifetime", async () => {
      const chatId = newChatId();
      const answer = resumeTurn(chatId, {
        toolName: "create_project_server",
        toolCallId: "call-create",
        input: SERVER_INPUT,
        approvalId: approvalIssuedAgo(
          chatId,
          TOOL_APPROVAL_TOKEN_MAX_AGE_MS - 60_000,
        ),
      });

      modelSteps = [REPLY];
      const first = await send(answer);
      expect(outputFor(first, "call-create")?.type).toBe(
        "tool-output-available",
      );
      expect(v1Writes()).toHaveLength(1);

      modelSteps = [REPLY];
      await send(answer);
      expect(v1Writes()).toHaveLength(1);
    });

    it("creates nothing for an approval id the server did not issue", async () => {
      modelSteps = [REPLY];
      const chunks = await send(
        resumeTurn(newChatId(), {
          toolName: "create_project_server",
          toolCallId: "call-create",
          input: SERVER_INPUT,
          approvalId: "mjap1.00000000.AAAAAAAAAAAAAAAA.UNEXPECTED_MARKER",
        }),
      );

      expect(outputFor(chunks, "call-create")?.type).toBe("tool-output-denied");
      expect(v1Calls).toEqual([]);
    });

    it("creates nothing when the approved arguments were for a different server", async () => {
      const chatId = newChatId();
      const approvalId = await pauseOnCreate(chatId, "call-create");
      modelSteps = [REPLY];

      const chunks = await send(
        resumeTurn(chatId, {
          toolName: "create_project_server",
          toolCallId: "call-create",
          input: {
            body: {
              ...SERVER_INPUT.body,
              url: "https://other.example.test/mcp",
            },
          },
          approvalId,
        }),
      );

      expect(outputFor(chunks, "call-create")?.type).toBe("tool-output-denied");
      expect(v1Calls).toEqual([]);
    });

    it("creates nothing when the approval is attached to a call the server did not pause on", async () => {
      const chatId = newChatId();
      const approvalId = await pauseOnCreate(chatId, "call-create");
      modelSteps = [REPLY];

      const chunks = await send(
        resumeTurn(chatId, {
          toolName: "create_project_server",
          toolCallId: "call-unissued",
          input: SERVER_INPUT,
          approvalId,
        }),
      );

      expect(outputFor(chunks, "call-unissued")?.type).toBe(
        "tool-output-denied",
      );
      expect(v1Calls).toEqual([]);
    });

    it("creates nothing when the approval belongs to another conversation", async () => {
      const approvalId = await pauseOnCreate(newChatId(), "call-create");
      modelSteps = [REPLY];

      const chunks = await send(
        resumeTurn(newChatId(), {
          toolName: "create_project_server",
          toolCallId: "call-create",
          input: SERVER_INPUT,
          approvalId,
        }),
      );

      expect(outputFor(chunks, "call-create")?.type).toBe("tool-output-denied");
      expect(v1Calls).toEqual([]);
    });

    it("creates nothing for a call in the history that never paused at all", async () => {
      modelSteps = [REPLY];
      const chunks = await send(
        turn(newChatId(), {
          messages: [
            userMessage(),
            {
              id: "a1",
              role: "assistant",
              parts: [
                { type: "step-start" },
                {
                  type: "tool-create_project_server",
                  toolCallId: "call-unpaused",
                  state: "input-available",
                  input: SERVER_INPUT,
                },
              ],
            },
          ],
        }),
      );

      const answer = outputFor(chunks, "call-unpaused") as
        { output?: { value?: unknown } } | undefined;
      expect(String(answer?.output?.value)).toMatch(/did not execute it/);
      expect(v1Calls).toEqual([]);
    });
  });

  describe("without an approval signing key", () => {
    beforeEach(() => {
      vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
      vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "");
    });

    it("does not offer create_project_server at all, and nothing can create a server", async () => {
      modelSteps = [
        callsTool("create_project_server", "call-create", SERVER_INPUT),
        REPLY,
      ];

      const chunks = await send(turn(newChatId()));

      expect(offeredTools()).toEqual(
        expect.arrayContaining(["list_projects", "list_project_servers"]),
      );
      expect(offeredTools()).not.toContain("create_project_server");
      expect(approvalRequestFor(chunks, "call-create")).toBeUndefined();
      expect(v1Writes()).toEqual([]);
    });
  });
});
