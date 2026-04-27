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
      {
        cwd: CLI_DIR,
        encoding: "utf8",
        env: { ...process.env, MCPJAM_CLI_DISABLE_BROWSER_OPEN: "1" },
      },
      (error, stdout, stderr) => {
        if (
          error &&
          (error as NodeJS.ErrnoException).code !== undefined &&
          typeof (error as NodeJS.ErrnoException).code !== "number"
        ) {
          reject(
            new Error(
              `Failed to execute CLI: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          );
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

test("apps debug rejects removed --engine flag", async () => {
  const result = await runCli([
    "--format",
    "json",
    "apps",
    "debug",
    "--engine",
    "inspector",
    "--url",
    "http://example.test/mcp",
    "--tool-name",
    "create_view",
  ]);

  assert.notEqual(result.exitCode, 0);
});

test("apps debug rejects removed --render flag", async () => {
  const result = await runCli([
    "--format",
    "json",
    "apps",
    "debug",
    "--render",
    "inspector",
    "--url",
    "http://example.test/mcp",
    "--tool-name",
    "create_view",
  ]);

  assert.notEqual(result.exitCode, 0);
});

test("apps debug rejects removed --name alias", async () => {
  const result = await runCli([
    "--format",
    "json",
    "apps",
    "debug",
    "--name",
    "create_view",
    "--url",
    "http://example.test/mcp",
  ]);

  assert.notEqual(result.exitCode, 0);
});

test("apps debug exits non-zero when MCP tool result reports isError", async () => {
  const server = http.createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/mcp") {
      const body = await readJsonBody(request);
      const method = body.method as string;
      const id = body.id;

      if (method === "initialize") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "test-server", version: "1.0.0" },
            },
          }),
        );
        return;
      }

      if (method === "tools/list") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [{ name: "fail_view", inputSchema: { type: "object" } }],
            },
          }),
        );
        return;
      }

      if (method === "tools/call") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              isError: true,
              content: [{ type: "text", text: "tool failed" }],
            },
          }),
        );
        return;
      }

      if (method === "notifications/initialized") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0" }));
        return;
      }

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
      return;
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
      "--url",
      `http://127.0.0.1:${port}/mcp`,
      "--tool-name",
      "fail_view",
      "--params",
      "{}",
    ]);

    assert.equal(result.exitCode, 1, result.stderr);
    const payload = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(payload.success, false);
    assert.equal(payload.error.code, "tool_execution_failed");
    assert.match(payload.error.message, /tool failed/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("apps debug --ui starts Inspector and drives command bus render", async () => {
  const requests: Array<{ method?: string; url?: string; body?: unknown }> = [];

  // This mock server handles both:
  // 1. Inspector API routes (health, session-token, connect, command)
  // 2. MCP Streamable HTTP at /mcp (initialize, tools/list, tools/call)
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/session-token") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ token: "test-token" }));
      return;
    }

    if (request.method === "POST" && request.url === "/mcp") {
      const body = await readJsonBody(request);
      const method = body.method as string;
      const id = body.id;

      if (method === "initialize") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "test-server", version: "1.0.0" },
            },
          }),
        );
        return;
      }

      if (method === "tools/list") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [{ name: "create_view", inputSchema: { type: "object" } }],
            },
          }),
        );
        return;
      }

      if (method === "tools/call") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: "view created" }] },
          }),
        );
        return;
      }

      if (method === "notifications/initialized") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0" }));
        return;
      }

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
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
      "--ui",
      "--inspector-url",
      `http://127.0.0.1:${port}`,
      "--url",
      `http://127.0.0.1:${port}/mcp`,
      "--tool-name",
      "create_view",
      "--params",
      "{}",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(payload.inspectorUi, true);
    assert.equal(payload.toolName, "create_view");
    assert.ok(payload.execution, "SDK execution result should be present");
    assert.ok(
      payload.inspectorRender,
      "Inspector render result should be present",
    );

    const commandRequests = requests.filter(
      (entry) => entry.url === "/api/mcp/command",
    );
    const connectRequest = requests.find(
      (entry) => entry.url === "/api/mcp/connect",
    );
    assert.equal(
      (connectRequest?.body as { serverId?: string } | undefined)?.serverId,
      `127-0-0-1-${port}-mcp`,
    );
    const commandTypes = commandRequests.map(
      (entry) => (entry.body as { type?: string }).type,
    );
    assert.equal(commandTypes[0], "openAppBuilder");
    assert.deepEqual(commandTypes.slice(-2), [
      "renderToolResult",
      "snapshotApp",
    ]);
    assert.ok(
      commandTypes.length === 3 ||
        (commandTypes.length === 4 && commandTypes[1] === "setAppContext"),
      `Unexpected command sequence: ${commandTypes.join(", ")}`,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("apps debug --ui exits non-zero when Inspector render command fails", async () => {
  const requests: Array<{ method?: string; url?: string; body?: unknown }> = [];

  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (request.method === "GET" && request.url === "/api/session-token") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ token: "test-token" }));
      return;
    }

    if (request.method === "POST" && request.url === "/mcp") {
      const body = await readJsonBody(request);
      const method = body.method as string;
      const id = body.id;

      if (method === "initialize") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "test-server", version: "1.0.0" },
            },
          }),
        );
        return;
      }

      if (method === "tools/list") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              tools: [{ name: "create_view", inputSchema: { type: "object" } }],
            },
          }),
        );
        return;
      }

      if (method === "tools/call") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: { content: [{ type: "text", text: "view created" }] },
          }),
        );
        return;
      }

      if (method === "notifications/initialized") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ jsonrpc: "2.0" }));
        return;
      }

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
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

      if (request.url === "/api/mcp/command") {
        const type = body.type as string | undefined;
        const isRender = type === "renderToolResult";
        response.writeHead(isRender ? 500 : 200, {
          "Content-Type": "application/json",
        });
        response.end(
          JSON.stringify(
            isRender
              ? {
                  id: (body.id as string | undefined) ?? "cmd",
                  status: "error",
                  error: {
                    code: "unknown_tool",
                    message: "Unknown tool.",
                  },
                }
              : {
                  id: (body.id as string | undefined) ?? "cmd",
                  status: "success",
                  result: { type },
                },
          ),
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
      "--ui",
      "--inspector-url",
      `http://127.0.0.1:${port}`,
      "--url",
      `http://127.0.0.1:${port}/mcp`,
      "--tool-name",
      "create_view",
      "--params",
      "{}",
    ]);

    assert.equal(result.exitCode, 1, result.stderr);
    const payload = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(payload.success, false);
    assert.equal(payload.error.code, "unknown_tool");

    const commandRequests = requests.filter(
      (entry) => entry.url === "/api/mcp/command",
    );
    assert.deepEqual(
      commandRequests.map((entry) => (entry.body as { type?: string }).type),
      ["openAppBuilder", "renderToolResult"],
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
