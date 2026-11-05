import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { resolveInspectorProjectTarget } from "../src/lib/inspector-project-target.js";

const credential = "sk_fixture_project_target";

test("saved Inspector target resolves within the selected project", async () => {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    assert.equal(req.headers.authorization, `Bearer ${credential}`);
    res.setHeader("content-type", "application/json");
    const data =
      req.url === "/projects"
        ? {
            items: [
              { id: "selected", name: "QA", updatedAt: 1 },
              { id: "other", name: "Other", updatedAt: 2 },
            ],
          }
        : { items: [{ id: "saved", name: "CAD", projectId: "selected" }] };
    res.end(JSON.stringify(data));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const target = await resolveInspectorProjectTarget({
      project: "selected",
      serverId: "saved",
      apiKey: credential,
      apiUrl: `http://127.0.0.1:${port}`,
    });
    assert.deepEqual(target, {
      projectId: "selected",
      serverId: "saved",
      serverName: "CAD",
      accessToken: credential,
    });
    assert.deepEqual(requests, ["/projects", "/projects/selected/servers"]);
    await assert.rejects(
      resolveInspectorProjectTarget({
        project: "selected",
        serverId: "not-in-project",
        apiKey: credential,
        apiUrl: `http://127.0.0.1:${port}`,
      }),
      (error: Error) =>
        error.message.includes("not saved in project") &&
        !error.message.includes(credential),
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

test("ad-hoc target is never silently replaced by a saved server", async () => {
  await assert.rejects(
    resolveInspectorProjectTarget({
      serverId: "saved",
      url: "https://example.test/mcp",
    }),
    /cannot be combined/,
  );
  assert.equal(
    await resolveInspectorProjectTarget({ url: "https://example.test/mcp" }),
    undefined,
  );
});
