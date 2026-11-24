import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWebConnectorEndpoint,
  mountWebConnectorEndpoint,
} from "../forwarding-endpoint.js";
import {
  createLocalConnectorRegistry,
  createLocalConnectorRoutes,
} from "../local-connectors.js";
import { createInMemoryToolCallLedger } from "../tool-call-ledger.js";
import { createInMemoryTurnWindowStore } from "../turn-windows.js";
import { startFixtureServer, vendorClient } from "./forwarding-fixtures.js";

const recorder = { frame: () => undefined, client: () => undefined };
let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
beforeAll(async () => {
  fixture = await startFixtureServer();
});
afterAll(async () => {
  await fixture.close();
});

describe("local connector registration", () => {
  function setup(enabled = true) {
    const registry = createLocalConnectorRegistry();
    const turns = createInMemoryTurnWindowStore();
    const app = new Hono();
    mountWebConnectorEndpoint(
      app,
      createWebConnectorEndpoint({
        resolver: registry.resolver,
        turns,
        ledger: createInMemoryToolCallLedger(),
        recorder,
        isEnabled: async () => true,
      }),
    );
    app.route(
      "/api/web-clients/local-connectors",
      createLocalConnectorRoutes({
        registry,
        turns,
        isEnabled: async () => enabled,
      }),
    );
    const control = (path: string, init: RequestInit = {}) =>
      app.request(`http://localhost:6274/api/web-clients/local-connectors${path}`, {
        ...init,
        headers: { "content-type": "application/json" },
      });
    return { app, control, turns };
  }

  it("registers a capability connector, opens a turn that allows named tools, and forwards through it", async () => {
    const { app, control } = setup();
    const created = await control("", {
      method: "POST",
      body: JSON.stringify({
        upstreamUrl: fixture.url,
        headers: { authorization: "Bearer local-server-token" },
      }),
    });
    expect(created.status).toBe(201);
    const { connectorId, path } = await created.json();
    expect(connectorId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const listed = await (await control("")).json();
    expect(JSON.stringify(listed)).not.toContain("local-server-token");

    fixture.received.length = 0;
    const vendor = vendorClient(app, { path });
    expect((await vendor.initialize()).status).toBe(200);
    const outside = await (await vendor.post(vendor.callToolRaw(2, "echo", "x"))).json();
    expect(outside.error.message).toMatch(/^No MCPJam run/);

    const turn = await control(`/${connectorId}/turn`, {
      method: "POST",
      body: JSON.stringify({ allowTools: ["echo"] }),
    });
    expect(turn.status).toBe(201);
    expect(
      await (await vendor.post(vendor.callToolRaw(3, "echo", "y"))).json(),
    ).toMatchObject({ id: 3, result: { content: [{ text: "echo: y" }] } });
    const denied = await (await vendor.post(vendor.callToolRaw(4, "delete_all", "z"))).json();
    expect(denied.error.message).toMatch(/^The local turn allows only echo/);
    expect(fixture.received[1]?.headers.authorization).toBe("Bearer local-server-token");

    expect((await control(`/${connectorId}/turn`, { method: "DELETE" })).status).toBe(204);
    expect((await control(`/${connectorId}`, { method: "DELETE" })).status).toBe(204);
    expect((await vendor.initialize()).status).toBe(404);
  });

  it("opens no turn for a body that isn't JSON, and a turn that allows every tool for {}", async () => {
    const { app, control } = setup();
    const created = await control("", {
      method: "POST",
      body: JSON.stringify({ upstreamUrl: fixture.url }),
    });
    const { connectorId, path } = await created.json();
    const vendor = vendorClient(app, { path });
    // A restrictive request cut off in transit.
    const cut = await control(`/${connectorId}/turn`, {
      method: "POST",
      body: '{"allowTools":["echo"]',
    });
    expect(cut.status).toBe(400);
    fixture.received.length = 0;
    const refused = await (await vendor.post(vendor.callToolRaw(2, "delete_all", "x"))).json();
    expect(refused.error.message).toMatch(/^No MCPJam run/);
    expect(fixture.received).toHaveLength(0);

    const open = await control(`/${connectorId}/turn`, { method: "POST", body: "{}" });
    expect(open.status).toBe(201);
    expect(
      await (await vendor.post(vendor.callToolRaw(3, "delete_all", "y"))).json(),
    ).toMatchObject({ id: 3, result: { content: [{ text: "echo: y" }] } });
  });

  it("leaves the turn of a connector it didn't register open", async () => {
    const { control, turns } = setup();
    // The runtime's turn on a backend connector, in the store both use.
    const window = turns.open({
      connectorId: "backend-connector",
      runId: "run_1",
      approve: async () => ({ allow: true }),
    });
    for (const path of ["/backend-connector/turn", "/backend-connector"]) {
      expect((await control(path, { method: "DELETE" })).status).toBe(404);
    }
    expect(turns.active("backend-connector")?.turnId).toBe(window.turnId);
  });

  it("refuses registration with the flag off or a URL that is not http", async () => {
    const off = setup(false);
    const body = JSON.stringify({ upstreamUrl: fixture.url });
    expect((await off.control("", { method: "POST", body })).status).toBe(404);
    const on = setup();
    const bad = JSON.stringify({ upstreamUrl: "file:///etc/passwd" });
    expect((await on.control("", { method: "POST", body: bad })).status).toBe(400);
  });
});
