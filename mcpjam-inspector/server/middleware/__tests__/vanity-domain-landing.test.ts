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
    ["score.mcpjam.com", "/", "/embed/score"],
  ])("redirects %s%s to %s", async (host, path, location) => {
    const response = await app.request(path, { headers: { Host: host } });

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(location);
  });

  it.each([
    ["caniuse.dev", "/capabilities/event-delivery?slice=poll"],
    ["caniuse.dev", "/embed/host-compare?capability=elicitation"],
    ["score.mcpjam.com", "/results/tok_abc"],
    ["app.mcpjam.com", "/?slice=poll"],
  ])("passes %s%s through to the SPA", async (host, path) => {
    const response = await app.request(path, { headers: { Host: host } });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("SPA");
  });
});
