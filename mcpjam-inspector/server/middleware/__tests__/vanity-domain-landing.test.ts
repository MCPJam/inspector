import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { vanityDomainLandingMiddleware } from "../vanity-domain-landing.js";

const app = new Hono();
app.use("/*", vanityDomainLandingMiddleware);
app.get("*", (c) => c.text("SPA"));

describe("vanityDomainLandingMiddleware", () => {
  it.each([
    ["caniuse.dev", "/", "/compare"],
    ["caniuse.dev", "/?slice=poll", "/compare?slice=poll"],
    [
      "WWW.CANIUSE.DEV:443",
      "/?q=MCP%20Events&slice=poll",
      "/compare?q=MCP%20Events&slice=poll",
    ],
    ["caniuse.dev", "/embed/host-compare", "/compare"],
    ["caniuse.dev", "/embed/host-compare/", "/compare"],
    [
      "www.caniuse.dev",
      "/embed/host-compare?hosts=preset%3Aclaude%2Cpreset%3Acursor&capability=elicitation",
      "/compare?hosts=preset%3Aclaude%2Cpreset%3Acursor&capability=elicitation",
    ],
    ["caniuse.dev", "/capabilities", "/capabilities/event-delivery"],
    [
      "WWW.CANIUSE.DEV:443",
      "/events?slice=poll&tag=MCP%20Events",
      "/capabilities/event-delivery?slice=poll&tag=MCP%20Events",
    ],
    ["caniuse.dev", "/apps", "/capabilities/ui-extension"],
    ["caniuse.dev", "/tasks", "/capabilities/mcp-tasks"],
    ["caniuse.dev", "/skills", "/capabilities/skills-extension"],
    [
      "caniuse.dev",
      "/protocol-versions?slice=2025-11-25",
      "/capabilities/supported-protocol-versions?slice=2025-11-25",
    ],
    ["caniuse.dev", "/elicitation", "/capabilities/elicitation"],
    ["caniuse.dev", "/sampling", "/capabilities/sampling"],
    ["caniuse.dev", "/roots", "/capabilities/roots"],
    ["score.mcpjam.com", "/", "/embed/score"],
  ])("redirects %s%s to %s", async (host, path, location) => {
    const response = await app.request(path, { headers: { Host: host } });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(location);
  });

  it.each([
    ["caniuse.dev", "/capabilities/event-delivery?slice=poll"],
    ["caniuse.dev", "/compare?q=Events"],
    ["caniuse.dev", "/embed/host-compare/other"],
    ["caniuse.dev", "/events/other"],
    ["score.mcpjam.com", "/results/tok_abc"],
    ["score.mcpjam.com", "/events"],
    ["app.mcpjam.com", "/?slice=poll"],
    ["app.mcpjam.com", "/embed/host-compare?capability=elicitation"],
    ["app.mcpjam.com", "/events?slice=poll"],
    ["app.mcpjam.com", "/tasks"],
    ["app.mcpjam.com", "/skills"],
    ["app.mcpjam.com", "/p/test-project/events"],
  ])("passes %s%s through to the SPA", async (host, path) => {
    const response = await app.request(path, { headers: { Host: host } });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("SPA");
  });
});
