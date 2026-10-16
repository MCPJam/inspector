import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { runCli } from "./support/cli-run.js";

const suite = {
  id: "suite1",
  name: "Smoke",
  projectId: "p1",
  environmentIds: ["env1"],
  hosts: [],
};

function createFixture() {
  const writes: Array<{ path: string; body: unknown }> = [];
  let created = false;
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    res.setHeader("content-type", "application/json");
    if (req.method === "POST") {
      writes.push({ path, body: JSON.parse(raw) });
      if (path.endsWith("/eval-suites")) {
        created = true;
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            suiteId: suite.id,
            name: suite.name,
            hosts: [],
            environmentIds: ["env1"],
            caseUpsert: { committed: [], failed: [] },
          })
        );
        return;
      }
      if (path.endsWith("/eval-runs")) {
        res.statusCode = 202;
        res.end(
          JSON.stringify({
            runId: "run1",
            status: "running",
            servers: [],
            environment: { id: "env1", name: null },
          })
        );
        return;
      }
    }
    if (path.endsWith("/projects")) {
      res.end(
        JSON.stringify({
          items: [{ id: "p1", name: "Project", organizationId: "org1" }],
        })
      );
    } else if (path.endsWith("/servers")) {
      res.end(
        JSON.stringify({
          items: [
            {
              id: "srv1",
              name: "Echo",
              transportType: "http",
              url: "https://echo.test/mcp",
            },
          ],
        })
      );
    } else if (path.endsWith("/eval-suites")) {
      res.end(JSON.stringify({ items: created ? [suite] : [] }));
    } else if (path.endsWith("/eval-suites/suite1")) {
      res.end(JSON.stringify(suite));
    } else if (path.endsWith("/environments/env1")) {
      res.end(
        JSON.stringify({
          id: "env1",
          hostId: "client1",
          name: null,
          adhoc: true,
        })
      );
    } else if (path.endsWith("/environments")) {
      res.end(JSON.stringify({ items: [] }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ code: "NOT_FOUND", message: path }));
    }
  });
  return { server, writes };
}

test("eval create, get and run --client preserve an environment-backed target", async () => {
  const { server, writes } = createFixture();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1`;
  const command = (name: string, args: string[]) =>
    runCli([
      "cloud",
      "eval",
      name,
      ...args,
      "--project",
      "p1",
      "--api-key",
      "test-key",
      "--api-url",
      baseUrl,
      "--format",
      "json",
    ]);
  try {
    const create = await command("create", [
      "--client",
      "client1",
      "--json",
      JSON.stringify({
        name: "Smoke",
        servers: ["Echo"],
        model: "anthropic/claude-haiku-4.5",
        cases: [
          {
            title: "Echo",
            steps: [{ id: "step1", kind: "prompt", prompt: "Echo hello" }],
          },
        ],
      }),
    ]);
    assert.equal(create.exitCode, 0, create.stderr);
    const receipt = JSON.parse(create.stdout);
    assert.deepEqual(receipt.environmentIds, ["env1"]);
    assert.deepEqual(receipt.hosts, []);
    assert.deepEqual(
      writes[0]?.body && (writes[0].body as { hosts: unknown }).hosts,
      [{ host: "client1" }]
    );
    const read = await command("get", ["--suite", receipt.suite.id]);
    assert.equal(read.exitCode, 0, read.stderr);
    assert.deepEqual(JSON.parse(read.stdout).environmentIds, ["env1"]);
    const run = await command("run", [
      "--suite",
      receipt.suite.id,
      "--client",
      "client1",
    ]);
    assert.equal(run.exitCode, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).environment.id, "env1");
    assert.equal(writes.length, 2);
    assert.equal(writes[1]?.path, "/api/v1/projects/p1/eval-runs");
    assert.deepEqual(writes[1]?.body, {
      suiteId: "suite1",
      environmentId: "env1",
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
