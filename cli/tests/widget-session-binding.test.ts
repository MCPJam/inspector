import { provisionInspectorRuntime } from "./support/inspector-runtime.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runWidgetRender } from "../src/lib/widget-render.js";
import {
  runWidgetSessionStart,
  runWidgetSessionSnapshot,
  runWidgetSessionAction,
  runWidgetSessionScriptedStep,
  runWidgetSessionClose,
} from "../src/lib/widget-session.js";

const home = await mkdtemp(path.join(os.tmpdir(), "widget-scope-test-"));
const originalXdg = process.env.XDG_CONFIG_HOME;
const originalKey = process.env.MCPJAM_API_KEY;
process.env.XDG_CONFIG_HOME = home;
after(async () => {
  if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = originalXdg;
  if (originalKey === undefined) delete process.env.MCPJAM_API_KEY;
  else process.env.MCPJAM_API_KEY = originalKey;
  await rm(home, { recursive: true, force: true });
});
test("saved widget operations keep their project, server and fresh credential across HTTP requests", async () => {
  const id = "f6207571-197f-4c91-98bc-005ff62e904b";
  const paths: string[] = [];
  let expectedCredential = "sk_initial_fixture",
    expired = false;
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (url === "/health") {
      res.end('{"status":"ok"}');
      return;
    }
    if (url === "/api/session-token") {
      res.end('{"ok":true}');
      return;
    }
    paths.push(url);
    assert.equal(req.headers.authorization, `Bearer ${expectedCredential}`);
    assert.ok(url.startsWith("/api/v1/projects/selected/servers/saved/"));
    if (expired) {
      res.statusCode = 401;
      res.end('{"error":"Expired session"}');
      return;
    }
    if (url.endsWith("/widgets/render")) {
      res.end(
        JSON.stringify({
          status: "rendered",
          screenshot: { base64: "cG5n" },
          timings: { totalMs: 3 },
        }),
      );
      return;
    }
    if (url.endsWith("/widget-sessions")) {
      res.end(JSON.stringify({ status: "rendered", sessionId: id }));
      return;
    }
    if (url.endsWith("/snapshot")) {
      res.end(
        JSON.stringify({
          snapshot: { mode: "a11y", tree: "viewer", elements: [] },
        }),
      );
      return;
    }
    if (url.endsWith("/scripted-step")) {
      res.end(
        JSON.stringify({
          step: { kind: "wait" },
          ok: true,
          widgetToolCalls: [],
          followUps: [],
        }),
      );
      return;
    }
    if (url.endsWith("/action")) {
      res.end(
        JSON.stringify({
          action: { action: "screenshot" },
          widgetToolCalls: [],
        }),
      );
      return;
    }
    res.end('{"closed":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  provisionInspectorRuntime(port);
  const baseUrl = `http://127.0.0.1:${port}`;
  const target = {
    projectId: "selected",
    serverId: "saved",
    serverName: "Friendly name",
    apiUrl: `${baseUrl}/api/v1`,
    accessToken: expectedCredential,
  };
  const options = {
    baseUrl,
    target,
    serverName: target.serverName,
    toolName: "show",
    parameters: {},
    timeoutMs: 1000,
  };
  try {
    const rendered = await runWidgetRender(options);
    assert.equal(rendered.screenshotBase64, "cG5n");
    assert.equal(rendered.elapsedMs, 3);
    const started = await runWidgetSessionStart(options);
    assert.equal(started.sessionId, id);
    const bindingFile = path.join(home, "mcpjam/widget-sessions", `${id}.json`);
    const saved = await readFile(bindingFile, "utf8");
    assert.ok(!saved.includes(expectedCredential));
    assert.equal((await stat(bindingFile)).mode & 0o777, 0o600);
    expectedCredential = "sk_current_fixture";
    process.env.MCPJAM_API_KEY = expectedCredential;
    const control = { sessionId: id, timeoutMs: 1000 };
    await runWidgetSessionSnapshot(control);
    await runWidgetSessionAction({
      ...control,
      action: { action: "screenshot" },
    });
    await runWidgetSessionScriptedStep({
      ...control,
      step: { kind: "wait", ms: 1 },
    });
    const count = paths.length;
    await assert.rejects(
      runWidgetSessionSnapshot({ ...control, baseUrl: "http://127.0.0.1:1" }),
      /different Inspector/,
    );
    assert.equal(paths.length, count);
    expired = true;
    const beforeRefusal = paths.length;
    await assert.rejects(runWidgetSessionSnapshot(control), /Expired session/);
    assert.equal(paths.length, beforeRefusal + 1);
    assert.equal(
      paths.at(-1),
      `/api/v1/projects/selected/servers/saved/widget-sessions/${id}/snapshot`,
    );
    expired = false;
    await runWidgetSessionClose(control);
    await assert.rejects(readFile(bindingFile), { code: "ENOENT" });
    assert.ok(paths.every((url) => !url.includes("Friendly")));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
