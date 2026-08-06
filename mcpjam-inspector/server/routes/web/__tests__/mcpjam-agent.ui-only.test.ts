import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

const {
  streamWebChatTurnMock,
  disconnectAllServersMock,
  listToolsMock,
  managerConfigs,
} = vi.hoisted(() => ({
  streamWebChatTurnMock: vi.fn(),
  disconnectAllServersMock: vi.fn(),
  listToolsMock: vi.fn(async (_serverId?: unknown) => ({ tools: [] })),
  managerConfigs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@mcpjam/sdk", async () => {
  const actual = await vi.importActual<typeof import("@mcpjam/sdk")>(
    "@mcpjam/sdk"
  );
  return {
    ...actual,
    isMCPAuthError: vi.fn().mockReturnValue(false),
    MCPClientManager: vi.fn().mockImplementation((configs: any) => {
      managerConfigs.push(configs);
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

import { createWebTestApp, postJson } from "./helpers/test-app.js";

const BASE_BODY = {
  messages: [{ role: "user", content: "show me my servers" }],
  model: { id: "openai/gpt-5-mini", provider: "openai", name: "GPT-5 Mini" },
  chatSessionId: "agent-session-1",
  projectId: "project-1",
};

async function postAgentTurn() {
  const { app, token } = createWebTestApp();
  const response = await postJson(app, "/api/web/mcpjam-agent", BASE_BODY, token);
  expect(response.status).toBe(200);
  return streamWebChatTurnMock.mock.calls[0][0];
}

describe("web routes — mcpjam-agent is UI-only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managerConfigs.length = 0;
    delete process.env.MCPJAM_AGENT_PLATFORM_TOOLS;
    streamWebChatTurnMock.mockResolvedValue(new Response("ok", { status: 200 }));
    // `clearAllMocks` clears calls but NOT implementations, so the degraded
    // -preflight test below would otherwise leak its throwing stub into every
    // later test in the file.
    listToolsMock.mockImplementation(async () => ({ tools: [] }));
  });

  afterEach(() => {
    delete process.env.MCPJAM_AGENT_PLATFORM_TOOLS;
  });

  it("never connects the platform server for a chat turn", async () => {
    // The platform tools mutate the workspace server-side and invisibly —
    // exactly what a surface whose premise is "you can watch me work" must
    // not do.
    await postAgentTurn();
    expect(Object.keys(managerConfigs[0])).toEqual(["mcpjam-docs", "mcp-spec"]);
  });

  it("selects both read-only knowledge servers", async () => {
    const args = await postAgentTurn();
    expect(args.prepare.selectedServerIds).toEqual(["mcpjam-docs", "mcp-spec"]);
  });

  it("connects the MCP spec docs server unauthenticated", async () => {
    // It's a third party. Forwarding the caller's bearer would put an AuthKit
    // token outside our trust boundary for what is a public docs search.
    await postAgentTurn();
    const spec = managerConfigs[0]!["mcp-spec"] as Record<string, unknown>;
    expect(spec.url).toBe("https://modelcontextprotocol.io/mcp");
    expect(spec.accessToken).toBeUndefined();
  });

  it("drops the spec guidance when the spec server failed preflight", async () => {
    // Same rule as the workspace-context section: never describe a tool the
    // degraded turn doesn't advertise.
    listToolsMock.mockImplementation(async (serverId?: unknown) => {
      if (serverId === "mcp-spec") throw new Error("upstream unreachable");
      return { tools: [] };
    });
    const args = await postAgentTurn();
    expect(args.prepare.systemPrompt).not.toContain("MCP SPECIFICATION");
  });

  it("declines the docs servers' submit_feedback write tool", async () => {
    // Both Mintlify docs servers ship it under the SAME unqualified name, and
    // `getToolsForAiSdk` flattens last-in-wins — so advertising it would both
    // let the agent post free text to a third party unattended AND silently
    // route MCPJam docs feedback to the MCP project.
    const args = await postAgentTurn();
    expect(args.prepare.excludeMcpToolNames).toContain("submit_feedback");
  });

  it("degrades instead of failing when a knowledge server is down", async () => {
    // `getToolsForAiSdk` fails the WHOLE turn when any SELECTED server errors
    // at connect/list time, so an outage at modelcontextprotocol.io — which we
    // do not operate — must not take the agent down with it.
    listToolsMock.mockImplementation(async (serverId?: unknown) => {
      if (serverId === "mcp-spec") throw new Error("upstream unreachable");
      return { tools: [] };
    });
    const args = await postAgentTurn();
    expect(args.prepare.selectedServerIds).toEqual(["mcpjam-docs"]);
  });

  it("keeps web_search — knowledge tools are read-only, not actions", async () => {
    const args = await postAgentTurn();
    expect(Object.keys(args.prepare.builtInTools ?? {})).toContain("web_search");
  });

  it("tells the model it acts by driving the UI", async () => {
    const args = await postAgentTurn();
    expect(args.prepare.systemPrompt).toContain("MCPJam in-app assistant");
    expect(args.prepare.systemPrompt).toContain("`ui_*` tools");
  });

  it("steers product questions to docs-first, then offer-before-acting", async () => {
    const args = await postAgentTurn();
    expect(args.prepare.systemPrompt).toContain(
      "search the MCPJam documentation first",
    );
    expect(args.prepare.systemPrompt).toContain("wait for a yes before acting");
    // Brevity + honesty rails for the same answer path.
    expect(args.prepare.systemPrompt).toContain("lead with the answer");
  });

  it("routes protocol questions to the spec server, version-first", async () => {
    // The whole point of connecting modelcontextprotocol.io: priors degrade
    // across exactly the version range this debugger targets, and the four
    // recent specs are near-identical text, so answering without pinning a
    // version is how you get a confidently wrong answer.
    const args = await postAgentTurn();
    expect(args.prepare.systemPrompt).toContain("MCP SPECIFICATION");
    expect(args.prepare.systemPrompt).toContain("/specification/<version>");
    expect(args.prepare.systemPrompt).toContain(
      "ALWAYS establish which version",
    );
    expect(args.prepare.systemPrompt).toContain(
      "Never generalize one version's behavior to another",
    );
  });

  it("ships the app atlas so the model knows what screens exist", async () => {
    const args = await postAgentTurn();
    expect(args.prepare.systemPrompt).toContain("screen by screen");
    expect(args.prepare.systemPrompt).toContain("### Connect (servers)");
    expect(args.prepare.systemPrompt).toContain("### Playground (playground)");
  });

  it("maps the screens this deployment actually has", async () => {
    // The atlas follows HOSTED_MODE (false under test): hosted-blocked
    // screens are real locally, and hard-coding `hosted: true` handed local
    // users an incomplete map of their own app. `buildAppAtlas` is unit-
    // tested for the hosted filter itself.
    const args = await postAgentTurn();
    expect(args.prepare.systemPrompt).toContain("### Tracing");
  });

  it("keeps the system prompt free of per-request values so the prefix stays cacheable", async () => {
    // Anything volatile here (projectId, route, timestamp) would invalidate
    // the cached prefix for the WHOLE conversation on every turn. Per-turn UI
    // state rides append-only on the user message instead (PR D).
    const args = await postAgentTurn();
    expect(args.prepare.systemPrompt).not.toContain("project-1");
    expect(args.prepare.systemPrompt).not.toContain("Workspace context");
  });

  it("is byte-stable across turns", async () => {
    const first = await postAgentTurn();
    vi.clearAllMocks();
    streamWebChatTurnMock.mockResolvedValue(new Response("ok", { status: 200 }));
    const second = await postAgentTurn();
    expect(second.prepare.systemPrompt).toBe(first.prepare.systemPrompt);
  });

  describe("MCPJAM_AGENT_PLATFORM_TOOLS=1 rollback", () => {
    beforeEach(() => {
      process.env.MCPJAM_AGENT_PLATFORM_TOOLS = "1";
    });

    it("still connects the knowledge servers — the switch governs acting, not reading", async () => {
      // The kill-switch exists to restore the ACTION contract (platform tools
      // back, UI-only prompt gone). Read-only docs are orthogonal to that
      // question, so they stay in both modes rather than giving the config two
      // shapes that have to be reasoned about separately.
      await postAgentTurn();
      expect(Object.keys(managerConfigs[0])).toContain("mcp-spec");
    });

    it("keeps the spec-reading guidance alongside the connected spec server", async () => {
      // The identity prompt goes (its "ui_* is your only way to act" claim is
      // false here), but the spec guidance is a READ instruction and must
      // track the server. Connecting the authoritative protocol source while
      // deleting the instruction to read it is the one combination that has
      // the feature's cost and none of its value.
      const args = await postAgentTurn();
      expect(args.prepare.systemPrompt).not.toContain("MCPJam in-app assistant");
      expect(args.prepare.systemPrompt).toContain("MCP SPECIFICATION");
      expect(args.prepare.systemPrompt).toContain(
        "ALWAYS establish which version",
      );
    });

    it("drops the UI-only identity prompt so the rollback isn't self-contradictory", async () => {
      // "The ui_* tools are your only way to act" is false once the platform
      // tools are back. Shipping both would leave the model with opposite
      // instructions in the one configuration meant to behave exactly like
      // the old one.
      const args = await postAgentTurn();
      expect(args.prepare.systemPrompt).not.toContain("MCPJam in-app assistant");
      expect(args.prepare.systemPrompt).not.toContain("no other way to act");
      expect(args.prepare.systemPrompt).toContain("Workspace context");
    });

    it("restores the platform server, its selection, AND its workspace prompt", async () => {
      // A rollback that restored the tools but not their `project` guidance
      // would leave the worker defaulting to the caller's most-recently-updated
      // project — a state we never shipped.
      const args = await postAgentTurn();
      expect(Object.keys(managerConfigs[0])).toEqual([
        "mcpjam-docs",
        "mcp-spec",
        "mcpjam-platform",
      ]);
      expect(args.prepare.selectedServerIds).toEqual([
        "mcpjam-docs",
        "mcp-spec",
        "mcpjam-platform",
      ]);
      expect(args.prepare.systemPrompt).toContain("Workspace context");
      expect(args.prepare.systemPrompt).toContain("project-1");
    });
  });
});
