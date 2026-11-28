import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { LauncherAttachRegistry } from "../../../services/launcher-attach/registry.js";
import { createLauncherRoutes } from "../launcher.js";

function createApp() {
  const registry = new LauncherAttachRegistry({ isPidAlive: () => true });
  const app = new Hono();
  app.route("/api/mcp/launcher", createLauncherRoutes(registry));
  const post = (path: string, body?: unknown) =>
    app.request(`/api/mcp/launcher${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { app, registry, post };
}

const POLL = {
  focusedAt: 1,
  signedIn: true,
  project: { id: "proj-acme", name: "Acme Tools" },
};

describe("/api/mcp/launcher", () => {
  it("runs an attach from request to connected", async () => {
    const { app, post } = createApp();

    const attach = await post("/attach", {
      attachId: "a1",
      server: { name: "billing-mcp", url: "http://127.0.0.1:7102/mcp" },
      pid: 4242,
    });
    expect(attach.status).toBe(202);
    expect(await attach.json()).toMatchObject({ status: "pending" });

    const poll = await (await post("/tabs/t1/poll", POLL)).json();
    expect(poll.tasks).toEqual([
      expect.objectContaining({
        kind: "attach",
        attachId: "a1",
        server: { name: "billing-mcp", url: "http://127.0.0.1:7102/mcp" },
      }),
    ]);

    expect((await post("/attach/a1/claim", { tabId: "t1" })).status).toBe(200);
    expect((await post("/attach/a1/claim", { tabId: "t2" })).status).toBe(409);

    const decision = {
      projectId: "proj-acme",
      projectName: "Acme Tools",
      serverName: "billing-mcp",
      createdByAttach: true,
    };
    const result = await post("/attach/a1/result", {
      tabId: "t1",
      outcome: "connected",
      decision,
    });
    expect(result.status).toBe(200);

    const state = await app.request("/api/mcp/launcher/attach/a1");
    expect(await state.json()).toEqual({
      attachId: "a1",
      status: "connected",
      serverName: "billing-mcp",
      projectName: "Acme Tools",
    });

    const release = await app.request("/api/mcp/launcher/attach/a1", {
      method: "DELETE",
    });
    expect(release.status).toBe(200);
    const undo = await (await post("/tabs/t1/poll", POLL)).json();
    expect(undo.tasks).toEqual([
      expect.objectContaining({ kind: "release", decision }),
    ]);
    expect((await post("/attach/a1/released", { tabId: "t1" })).status).toBe(200);
  });

  it("rejects a server with both or neither of url and command", async () => {
    const { post } = createApp();
    const both = await post("/attach", {
      attachId: "a1",
      server: { name: "x", url: "http://localhost:1/mcp", command: "node" },
    });
    const neither = await post("/attach", { attachId: "a1", server: { name: "x" } });

    expect(both.status).toBe(400);
    expect(neither.status).toBe(400);
    expect(await neither.json()).toMatchObject({ code: "invalid_request" });
  });

  it("accepts a stdio server", async () => {
    const { post } = createApp();
    const res = await post("/attach", {
      attachId: "s1",
      server: { name: "local", command: "node", args: ["server.js"] },
    });
    expect(res.status).toBe(202);
  });

  it("rejects a malformed body and a malformed poll", async () => {
    const { app, post } = createApp();
    const badJson = await app.request("/api/mcp/launcher/attach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(badJson.status).toBe(400);
    expect((await post("/tabs/t1/poll", { signedIn: true })).status).toBe(400);
  });

  it("answers 404 for an unknown attach id", async () => {
    const { app, post } = createApp();
    expect((await app.request("/api/mcp/launcher/attach/nope")).status).toBe(404);
    expect(
      (await app.request("/api/mcp/launcher/attach/nope", { method: "DELETE" }))
        .status,
    ).toBe(404);
    expect((await post("/attach/nope/claim", { tabId: "t" })).status).toBe(404);
  });

  it("rejects a result without a decision for a connected outcome", async () => {
    const { post } = createApp();
    await post("/attach", {
      attachId: "a1",
      server: { name: "billing-mcp", url: "http://127.0.0.1:7102/mcp" },
    });
    await post("/tabs/t1/poll", POLL);
    await post("/attach/a1/claim", { tabId: "t1" });
    const res = await post("/attach/a1/result", { tabId: "t1", outcome: "connected" });
    expect(res.status).toBe(400);
  });

  it("reports a saved checkpoint, then tracks the release until a tab acknowledges it", async () => {
    const { app, post } = createApp();
    const decision = {
      projectId: "proj-acme",
      projectName: "Acme Tools",
      serverName: "billing-mcp",
      createdByAttach: true,
    };
    await post("/attach", {
      attachId: "a1",
      server: { name: "billing-mcp", url: "http://127.0.0.1:7102/mcp" },
    });
    await post("/tabs/t1/poll", POLL);
    await post("/attach/a1/claim", { tabId: "t1" });

    // The tab saved the entry and is still connecting.
    const saved = await post("/attach/a1/result", { tabId: "t1", outcome: "saved", decision });
    expect(saved.status).toBe(200);
    const state = await (await app.request("/api/mcp/launcher/attach/a1")).json();
    expect(state).toMatchObject({ status: "claimed", projectName: "Acme Tools" });

    // The dev command quits: the undo is pending until the tab acknowledges it.
    await app.request("/api/mcp/launcher/attach/a1", { method: "DELETE" });
    const pending = await app.request("/api/mcp/launcher/attach/a1/release");
    expect(await pending.json()).toEqual({ status: "pending" });

    await post("/tabs/t1/poll", POLL);
    await post("/attach/a1/released", { tabId: "t1" });
    const done = await app.request("/api/mcp/launcher/attach/a1/release");
    expect(await done.json()).toEqual({ status: "done" });
  });

  it("a saved report needs the decision", async () => {
    const { post } = createApp();
    await post("/attach", {
      attachId: "a1",
      server: { name: "billing-mcp", url: "http://127.0.0.1:7102/mcp" },
    });
    await post("/tabs/t1/poll", POLL);
    await post("/attach/a1/claim", { tabId: "t1" });
    expect((await post("/attach/a1/result", { tabId: "t1", outcome: "saved" })).status).toBe(400);
  });

  it("a request released mid-save still accepts the tab's report", async () => {
    const { app, post } = createApp();
    await post("/attach", {
      attachId: "a1",
      server: { name: "billing-mcp", url: "http://127.0.0.1:7102/mcp" },
    });
    await post("/tabs/t1/poll", POLL);
    await post("/attach/a1/claim", { tabId: "t1" });
    await app.request("/api/mcp/launcher/attach/a1", { method: "DELETE" });

    const report = await post("/attach/a1/result", {
      tabId: "t1",
      outcome: "saved",
      decision: {
        projectId: "proj-acme",
        projectName: "Acme Tools",
        serverName: "billing-mcp",
        createdByAttach: true,
      },
    });
    expect(report.status).toBe(200);
    const undo = await (await post("/tabs/t1/poll", POLL)).json();
    expect(undo.tasks).toEqual([expect.objectContaining({ kind: "release" })]);
  });
});
