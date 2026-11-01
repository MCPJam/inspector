import { Hono, type Context } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { platformAgentGate } from "../platform-agent-gate.js";

function agentApp() {
  const handler = vi.fn((c: Context) => c.json({ ran: true }));
  const app = new Hono();
  app.use("/mcpjam-agent", platformAgentGate);
  app.use("/mcpjam-agent/*", platformAgentGate);
  app.post("/mcpjam-agent", handler);
  app.post("/mcpjam-agent/widget-content", handler);
  return { app, handler };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("platformAgentGate", () => {
  it("refuses every agent route under MCPJAM_PLATFORM_AGENT=off, before the route runs", async () => {
    vi.stubEnv("MCPJAM_PLATFORM_AGENT", "off");
    const { app, handler } = agentApp();

    for (const path of ["/mcpjam-agent", "/mcpjam-agent/widget-content"]) {
      const response = await app.request(path, { method: "POST" });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        code: "FEATURE_NOT_SUPPORTED",
        message:
          "Ask MCPJam is turned off on this deployment. Ask your administrator to turn it on.",
        details: { reason: "platform_agent_off" },
      });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "on", "OFF", "false"])(
    "lets the agent run when MCPJAM_PLATFORM_AGENT is %s",
    async (value) => {
      if (value === undefined) vi.stubEnv("MCPJAM_PLATFORM_AGENT", undefined);
      else vi.stubEnv("MCPJAM_PLATFORM_AGENT", value);
      const { app, handler } = agentApp();

      const response = await app.request("/mcpjam-agent/widget-content", {
        method: "POST",
      });
      expect(response.status).toBe(200);
      expect(handler).toHaveBeenCalledOnce();
    },
  );
});
