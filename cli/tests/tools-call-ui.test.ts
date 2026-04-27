import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { buildInspectorServerName } from "../src/lib/inspector-render.js";

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
        env: {
          ...process.env,
          MCPJAM_CLI_DISABLE_BROWSER_OPEN: "1",
          MCPJAM_TELEMETRY_DISABLED: "1",
        },
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

async function startMockServer(options: {
  toolResult?: unknown;
  toolRpcError?: { code: number; message: string };
  failRender?: boolean;
}) {
  const requests: Array<{ method?: string; url?: string; body?: unknown }> = [];
  const toolResult =
    options.toolResult ?? { content: [{ type: "text", text: "view created" }] };

  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ status: "ok", frontend: "http://localhost:5173/" }),
      );
      return;
    }

    if (request.method === "GET" && request.url === "/api/session-token") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ token: "test-token" }));
      return;
    }

    if (request.method === "POST" && request.url === "/mcp") {
      const body = await readJsonBody(request);
      requests.push({ method: request.method, url: request.url, body });
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
          JSON.stringify(
            options.toolRpcError
              ? { jsonrpc: "2.0", id, error: options.toolRpcError }
              : { jsonrpc: "2.0", id, result: toolResult },
          ),
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
        response.writeHead(options.failRender && isRender ? 500 : 200, {
          "Content-Type": "application/json",
        });
        response.end(
          JSON.stringify(
            options.failRender && isRender
              ? {
                  id: (body.id as string | undefined) ?? "cmd",
                  status: "error",
                  error: {
                    code: "render_failed",
                    message: "Render failed.",
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

  return {
    port,
    requests,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

test("tools call --ui executes once and sends the raw result to Inspector", async () => {
  const toolResult = {
    content: [{ type: "text", text: "view created" }],
    _meta: { requestId: "tool-result-1" },
  };
  const server = await startMockServer({ toolResult });

  try {
    const result = await runCli([
      "--format",
      "json",
      "tools",
      "call",
      "--ui",
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "create_view",
      "--tool-args",
      '{"shape":"circle"}',
      "--theme",
      "dark",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(payload.success, true);
    assert.equal(payload.command, "tools call");
    assert.equal(payload.inspectorUi, true);
    assert.deepEqual(payload.result, toolResult);
    assert.ok(payload.inspectorRender);

    const mcpMethods = server.requests
      .filter((entry) => entry.url === "/mcp")
      .map((entry) => (entry.body as { method?: string }).method);
    assert.equal(
      mcpMethods.filter((method) => method === "tools/call").length,
      1,
    );
    assert.equal(mcpMethods.includes("tools/list"), false);

    const connectRequest = server.requests.find(
      (entry) => entry.url === "/api/mcp/connect",
    );
    assert.equal(
      (connectRequest?.body as { serverId?: string } | undefined)?.serverId,
      `127-0-0-1-${server.port}-mcp`,
    );

    const commandRequests = server.requests.filter(
      (entry) => entry.url === "/api/mcp/command",
    );
    assert.deepEqual(
      commandRequests.map((entry) => (entry.body as { type?: string }).type),
      ["openAppBuilder", "setAppContext", "renderToolResult", "snapshotApp"],
    );
    const renderRequest = commandRequests.find(
      (entry) => (entry.body as { type?: string }).type === "renderToolResult",
    );
    assert.deepEqual(
      (renderRequest?.body as { payload?: { result?: unknown } } | undefined)
        ?.payload?.result,
      toolResult,
    );
  } finally {
    await server.stop();
  }
});

test("tools call without --ui preserves raw output and does not contact Inspector", async () => {
  const toolResult = { content: [{ type: "text", text: "plain result" }] };
  const server = await startMockServer({ toolResult });

  try {
    const result = await runCli([
      "--format",
      "json",
      "tools",
      "call",
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "create_view",
      "--tool-args",
      "{}",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), toolResult);
    assert.equal(
      server.requests.some((entry) => entry.url?.startsWith("/api/")),
      false,
    );
  } finally {
    await server.stop();
  }
});

test("tools call --ui keeps the tool result when Inspector render fails", async () => {
  const toolResult = { content: [{ type: "text", text: "view created" }] };
  const server = await startMockServer({ toolResult, failRender: true });

  try {
    const result = await runCli([
      "--format",
      "json",
      "tools",
      "call",
      "--ui",
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "create_view",
      "--tool-args",
      "{}",
    ]);

    assert.equal(result.exitCode, 1, result.stderr);
    const payload = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(payload.success, false);
    assert.deepEqual(payload.result, toolResult);
    assert.equal(payload.error.code, "render_failed");
    assert.ok(payload.inspectorRender.renderToolResult);

    const commandRequests = server.requests.filter(
      (entry) => entry.url === "/api/mcp/command",
    );
    assert.deepEqual(
      commandRequests.map((entry) => (entry.body as { type?: string }).type),
      ["openAppBuilder", "renderToolResult"],
    );
  } finally {
    await server.stop();
  }
});

test("tools call --ui skips Inspector rendering when tool execution throws", async () => {
  const server = await startMockServer({
    toolRpcError: { code: -32602, message: "Bad params." },
  });

  try {
    const result = await runCli([
      "--format",
      "json",
      "tools",
      "call",
      "--ui",
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "create_view",
      "--tool-args",
      "{}",
    ]);

    assert.notEqual(result.exitCode, 0);
    assert.equal(
      server.requests.some((entry) => entry.url?.startsWith("/api/")),
      false,
    );
  } finally {
    await server.stop();
  }
});

test("tools call --ui rejects reporter output", async () => {
  const result = await runCli([
    "--format",
    "json",
    "tools",
    "call",
    "--ui",
    "--reporter",
    "json-summary",
    "--expect-success",
    "--url",
    "http://example.test/mcp",
    "--tool-name",
    "create_view",
    "--tool-args",
    "{}",
  ]);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /--ui cannot be used together with --reporter/);
});

test("tools call --ui validates render flags before executing the tool", async () => {
  const server = await startMockServer({});

  try {
    const result = await runCli([
      "--format",
      "json",
      "tools",
      "call",
      "--ui",
      "--theme",
      "blue",
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "create_view",
      "--tool-args",
      "{}",
    ]);

    assert.equal(result.exitCode, 2);
    assert.match(
      (JSON.parse(result.stderr) as { error?: { message?: string } }).error
        ?.message ?? "",
      /Invalid theme "blue"/,
    );
    assert.deepEqual(server.requests, []);
  } finally {
    await server.stop();
  }
});

test("tools call --ui applies expect-success to the raw tool result", async () => {
  const errorToolResult = {
    isError: true,
    content: [{ type: "text", text: "tool failed" }],
  };
  const server = await startMockServer({ toolResult: errorToolResult });

  try {
    const result = await runCli([
      "--format",
      "json",
      "tools",
      "call",
      "--ui",
      "--expect-success",
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "create_view",
      "--tool-args",
      "{}",
    ]);

    assert.equal(result.exitCode, 1, result.stderr);
    const payload = JSON.parse(result.stdout) as Record<string, any>;
    assert.equal(payload.success, false);
    assert.deepEqual(payload.result, errorToolResult);
    assert.ok(payload.inspectorRender);
  } finally {
    await server.stop();
  }
});

test("buildInspectorServerName trims URL targets before parsing", () => {
  assert.equal(
    buildInspectorServerName({ url: " http://example.test:8080/mcp " }),
    "example-test-8080-mcp",
  );
});

test("removed apps debug and widget commands are rejected", async () => {
  for (const command of ["debug", "mcp-widget", "chatgpt-widget"]) {
    const result = await runCli(["--format", "json", "apps", command]);
    assert.equal(result.exitCode, 2, command);
    assert.match(result.stderr, /unknown command/i, command);
  }
});

test("tools call --ui still requires a tool name", async () => {
  const result = await runCli([
    "--format",
    "json",
    "tools",
    "call",
    "--ui",
    "--url",
    "http://example.test/mcp",
    "--tool-args",
    "{}",
  ]);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Tool name is required/);
});
