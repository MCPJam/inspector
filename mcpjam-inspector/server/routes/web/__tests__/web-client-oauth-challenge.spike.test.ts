import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { startLazyAuthServer } from "../../../../../sdk/tests/mock-servers/lazy-auth-server.js";
import {
  claudeLiveSpikeResponseCleanup,
  createClaudeLiveSpikeRouter,
} from "../claude-live-spike.js";

// HARN-129 characterization of the PLB-580 draft. Both routes call the same
// read-only tool on the same protected fixture with no upstream credential.
it.each([
  { mode: "http401", status: 401, httpChallenge: true, toolChallenge: false },
  { mode: "meta", status: 200, httpChallenge: false, toolChallenge: true },
] as const)("compares direct and forwarded $mode challenges", async (testCase) => {
  const upstream = await startLazyAuthServer({ mode: testCase.mode });
  try {
    const config = {
      upstreamUrl: upstream.url,
      connectorSecret: randomUUID(),
      controlSecret: randomUUID(),
      serverId: "harn129-qa",
    };
    const app = new Hono();
    app.use("/spike/*", claudeLiveSpikeResponseCleanup);
    app.route("/spike", createClaudeLiveSpikeRouter({ config }));
    const turn = await app.request("/spike/turn", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mcpjam-spike-control": config.controlSecret,
      },
      body: JSON.stringify({ live: true, label: "oauth-challenge-control" }),
    });
    expect(turn.status).toBe(200);

    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "get_my_orders", arguments: {} },
    });
    const direct = await fetch(upstream.url, { method: "POST", headers, body });
    const forwarded = await app.request("/spike/mcp", {
      method: "POST",
      headers: { ...headers, "x-mcpjam-spike-key": config.connectorSecret },
      body,
    });

    for (const response of [direct, forwarded]) {
      expect(response.status).toBe(testCase.status);
      const reply = await response.json();
      const challenges = reply.result?._meta?.["mcp/www_authenticate"];
      expect(JSON.stringify(challenges ?? []).includes("resource_metadata")).toBe(
        testCase.toolChallenge,
      );
      if (testCase.toolChallenge) expect(reply.id).toBe(42);
    }
    expect(direct.headers.has("www-authenticate")).toBe(testCase.httpChallenge);
    expect(forwarded.headers.has("www-authenticate")).toBe(false);
  } finally {
    await upstream.close();
  }
});
