/**
 * `MCPJAM_PLATFORM_AGENT=off`, proven on the real server.
 *
 * The agent's MCP servers are pointed at names that exist nowhere, and the
 * server runs under the deny-mode network guard (`test/support/
 * deny-network.mjs`), which records every attempt to reach them. Off, the
 * agent's routes answer a clear refusal and nothing tries those hosts: not at
 * boot, not when both routes are called, not at shutdown. The control runs the
 * same server with the agent on, makes the same call, and the guard sees the
 * platform worker being dialled, so the silence above means something.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  removeScratch,
  startGuardedServer,
  type GuardedServer,
  type NetworkAttempt,
} from "../test/support/guarded-server.js";

const AGENT_SERVERS = {
  MCPJAM_PLATFORM_MCP_URL: "https://platform-agent.example.test/mcp",
  MCPJAM_DOCS_MCP_URL: "https://docs-agent.example.test/mcp",
  MCPJAM_SPEC_MCP_URL: "https://spec-agent.example.test/mcp",
};

const isAgentServer = ({ target }: NetworkAttempt) =>
  /(^|\.)(platform|docs|spec)-agent\.example\.test$/.test(target) ||
  /(^|\.)mcp\.mcpjam\.com$/.test(target);

/** The two agent routes, called the way the client calls them. */
async function callAgent(server: GuardedServer) {
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${server.baseUrl}/api/web${path}`, {
      method: "POST",
      headers: {
        authorization: "Bearer opaque-session-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    // An agent that is on answers the chat route with an event stream.
    const text = await response.text();
    return {
      status: response.status,
      body: text.startsWith("{") ? (JSON.parse(text) as unknown) : text,
    };
  };
  return {
    chat: await post("/mcpjam-agent", {
      messages: [{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }],
      model: { id: "agent" },
      chatSessionId: "session-1",
      projectId: "project-1",
    }),
    widget: await post("/mcpjam-agent/widget-content", {
      resourceUri: "ui://widget/agent.html",
      toolId: "call-1",
      toolName: "show_projects",
    }),
  };
}

describe("a hosted server with MCPJAM_PLATFORM_AGENT=off", () => {
  let off: GuardedServer;
  let on: GuardedServer;
  let offCalls: Awaited<ReturnType<typeof callAgent>>;
  let offDocument: string;
  let offExit: number | null;
  let onAttempts: NetworkAttempt[];

  beforeAll(async () => {
    const env = {
      ...AGENT_SERVERS,
      DO_NOT_TRACK: "1",
      // Guest tokens are checked against a guest authority; keep that on a
      // closed loopback port so the only names the guard can see are the
      // agent's own.
      MCPJAM_GUEST_AUTHORITY_ORIGIN: "http://127.0.0.1:9",
    };
    [off, on] = await Promise.all([
      startGuardedServer({ env: { ...env, MCPJAM_PLATFORM_AGENT: "off" } }),
      startGuardedServer({ env }),
    ]);
    offCalls = await callAgent(off);
    offDocument = await (await fetch(`${off.baseUrl}/`)).text();
    await callAgent(on);
    offExit = await off.stop();
    await on.stop();
    onAttempts = on.attempts();
  }, 180_000);

  afterAll(async () => {
    for (const server of [off, on]) {
      if (!server) continue;
      await server.stop();
      removeScratch(server);
    }
  });

  it("answers both agent routes with a clear refusal", () => {
    for (const call of [offCalls.chat, offCalls.widget]) {
      expect(call.status).toBe(404);
      expect(call.body).toMatchObject({
        code: "FEATURE_NOT_SUPPORTED",
        message:
          "Ask MCPJam is turned off on this deployment. Ask your administrator to turn it on.",
        details: { reason: "platform_agent_off" },
      });
    }
  });

  it("never tries the platform MCP host or the agent's docs servers", () => {
    expect(offExit, off.output()).toBe(0);
    expect(off.attempts().filter(isAgentServer)).toEqual([]);
  });

  it("tells the browser to hide the agent", () => {
    const runtimeConfig = /window\.__MCP_RUNTIME_CONFIG__=(\{.*?\});/.exec(
      offDocument,
    );
    expect(JSON.parse(runtimeConfig?.[1] ?? "null")).toMatchObject({
      platformAgentDisabled: true,
    });
  });

  it("control: with the agent on, the same call dials the platform worker", () => {
    expect(
      onAttempts.map(({ target }) => target),
      on.output(),
    ).toContain("platform-agent.example.test");
  });
});
