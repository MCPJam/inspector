import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";

const CLI_DIR = process.cwd().endsWith(`${path.sep}cli`)
  ? process.cwd()
  : path.join(process.cwd(), "cli");
const requireFromCli = createRequire(path.join(CLI_DIR, "package.json"));
const TSX_CLI_PATH = requireFromCli.resolve("tsx/cli");
const CLI_ENTRY_PATH = path.join(CLI_DIR, "src", "index.ts");

async function runCli(args: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [TSX_CLI_PATH, CLI_ENTRY_PATH, ...args],
      { cwd: CLI_DIR, encoding: "utf8", env: process.env },
      (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code !== "number") {
          reject(error);
          return;
        }
        resolve({
          exitCode:
            typeof (error as NodeJS.ErrnoException | null)?.code === "number"
              ? Number((error as NodeJS.ErrnoException).code)
              : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

async function readJsonBody(
  request: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return JSON.parse(body) as Record<string, unknown>;
}

test("apps debug --engine inspector calls Inspector REST endpoints", async () => {
  const requests: Array<{ method?: string; url?: string; body?: unknown }> = [];
  const token = "debug-session-token";
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/session-token") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ token }));
      return;
    }

    if (request.url?.startsWith("/api/mcp/servers/init-info/")) {
      requests.push({ method: request.method, url: request.url });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: true, initInfo: { protocolVersion: "2025-11-25" } }));
      return;
    }

    if (request.method === "POST" && request.url) {
      const body = await readJsonBody(request);
      requests.push({ method: request.method, url: request.url, body });

      if (request.url === "/api/mcp/connect") {
        assert.equal(request.headers["x-mcp-session-auth"], `Bearer ${token}`);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ success: true, status: "connected" }));
        return;
      }

      if (request.url === "/api/mcp/tools/list") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            tools: [{ name: "create_view", inputSchema: { type: "object" } }],
            toolsMetadata: {
              create_view: { ui: { resourceUri: "ui://demo/widget.html" } },
            },
          }),
        );
        return;
      }

      if (request.url === "/api/mcp/tools/execute") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            status: "completed",
            result: { content: [{ type: "text", text: "view" }] },
          }),
        );
        return;
      }
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  try {
    const result = await runCli([
      "--format",
      "json",
      "apps",
      "debug",
      "--engine",
      "inspector",
      "--inspector-url",
      `http://127.0.0.1:${port}`,
      "--url",
      "http://example.test/mcp",
      "--tool-name",
      "create_view",
      "--params",
      '{"title":"Hello"}',
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(payload.engine, "inspector");
    assert.equal(payload.render, "none");
    assert.equal(payload.toolName, "create_view");
    assert.equal(payload.ui.resourceUri, "ui://demo/widget.html");
    assert.deepEqual(payload.execution, {
      content: [{ type: "text", text: "view" }],
    });
    assert.deepEqual(
      requests
        .filter((entry) => entry.method === "POST")
        .map((entry) => entry.url),
      ["/api/mcp/connect", "/api/mcp/tools/list", "/api/mcp/tools/execute"],
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("apps debug --render inspector performs REST connect before command bus render", async () => {
  const requests: Array<{ method?: string; url?: string; body?: unknown }> = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/session-token") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ token: "render-token" }));
      return;
    }

    if (request.url?.startsWith("/api/mcp/servers/init-info/")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: true, initInfo: null }));
      return;
    }

    if (request.method === "POST" && request.url) {
      const body = await readJsonBody(request);
      requests.push({ method: request.method, url: request.url, body });

      if (request.url === "/api/mcp/connect") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ success: true, status: "connected" }));
        return;
      }

      if (request.url === "/api/mcp/tools/list") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            tools: [{ name: "create_view", inputSchema: { type: "object" } }],
            toolsMetadata: {},
          }),
        );
        return;
      }

      if (request.url === "/api/mcp/tools/execute") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ status: "completed", result: { ok: true } }));
        return;
      }

      if (request.url === "/api/mcp/command") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            id: (body.id as string | undefined) ?? "cmd",
            status: "success",
            result: { type: body.type },
          }),
        );
        return;
      }
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  try {
    const result = await runCli([
      "--format",
      "json",
      "apps",
      "debug",
      "--render",
      "inspector",
      "--inspector-url",
      `http://127.0.0.1:${port}`,
      "--url",
      "http://example.test/mcp",
      "--tool-name",
      "create_view",
      "--params",
      "{}",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(
      requests.map((entry) => entry.url),
      [
        "/api/mcp/connect",
        "/api/mcp/tools/list",
        "/api/mcp/tools/execute",
        "/api/mcp/command",
        "/api/mcp/command",
        "/api/mcp/command",
      ],
    );
    assert.deepEqual(
      requests
        .filter((entry) => entry.url === "/api/mcp/command")
        .map((entry) => (entry.body as { type?: string }).type),
      ["openAppBuilder", "executeTool", "snapshotApp"],
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
