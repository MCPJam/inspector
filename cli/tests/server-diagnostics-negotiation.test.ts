import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { runCli } from "./support/cli-run.js";

test("server probe and doctor detect both MCP eras and stop at an OAuth challenge", async (t) => {
  const originalExitCode = process.exitCode;
  const methods: string[] = [];
  const serverInfo = { name: "diagnostics-fixture", version: "1.0.0" };
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const { id, method } = JSON.parse(Buffer.concat(chunks).toString());
    methods.push(method);
    const legacy = req.url === "/legacy";
    const write = (status: number, payload: unknown) =>
      res
        .writeHead(status, { "Content-Type": "application/json" })
        .end(JSON.stringify(payload));
    const reply = (result: unknown) =>
      write(200, { jsonrpc: "2.0", id, result });
    const modernResult = {
      resultType: "complete",
      ttlMs: 60_000,
      cacheScope: "public",
    };

    if (!legacy && method === "server/discover") {
      if (req.url === "/oauth") {
        res.writeHead(401, { "WWW-Authenticate": "Bearer" }).end();
        return;
      }
      reply({
        ...modernResult,
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
        _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
      });
    } else if (legacy && method === "initialize") {
      reply({
        protocolVersion: "2025-11-25",
        capabilities: { tools: {} },
        serverInfo,
      });
    } else if (legacy && method === "notifications/initialized") {
      res.writeHead(202).end();
    } else if (method === "tools/list") {
      reply({
        ...(legacy ? {} : modernResult),
        tools: [{ name: "echo", inputSchema: { type: "object" } }],
      });
    } else {
      write(400, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" },
      });
    }
  });
  t.after(() => {
    process.exitCode = originalExitCode;
    server.closeAllConnections();
    server.close();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  for (const command of ["probe", "doctor"]) {
    for (const fixture of ["modern", "legacy", "oauth"]) {
      await t.test(`${command} on ${fixture}`, async () => {
        methods.length = 0;
        const oauth = fixture === "oauth";
        const run = await runCli([
          "--format",
          "json",
          "--timeout",
          "3500",
          "server",
          command,
          "--url",
          `${origin}/${fixture}`,
        ]);
        assert.equal(
          run.exitCode,
          oauth && command === "doctor" ? 1 : 0,
          run.stdout,
        );
        const result = JSON.parse(run.stdout);
        const probe = command === "doctor" ? result.probe : result;
        assert.equal(result.status, oauth ? "oauth_required" : "ready");
        if (fixture === "legacy") {
          assert.deepEqual(methods.slice(0, 2), [
            "server/discover",
            "initialize",
          ]);
          assert.equal(probe.protocolVersion, "2025-11-25");
        } else if (oauth) {
          assert.deepEqual(methods, ["server/discover"]);
          assert.equal(probe.oauth.required, true);
        } else {
          assert.equal(methods[0], "server/discover");
          assert.ok(!methods.includes("initialize"));
          assert.equal(probe.protocolVersion, "2026-07-28");
          if (command === "doctor") {
            assert.match(
              result.checks.probe.detail,
              /server\/discover probe succeeded/,
            );
            assert.equal(
              result.checks.initialization.detail,
              "Server discovery info captured.",
            );
            assert.equal(result.tools[0].name, "echo");
          }
        }
      });
    }
  }
});
