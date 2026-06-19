import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import {
  resolveInspectorOpenBrowser,
  resolveInspectorSkipDiscovery,
  resolveInspectorStartIfNeeded,
} from "../src/commands/tools.js";
import { buildInspectorServerName } from "../src/lib/inspector-render.js";

const CLI_DIR = process.cwd().endsWith(`${path.sep}cli`)
  ? process.cwd()
  : path.join(process.cwd(), "cli");
const requireFromCli = createRequire(path.join(CLI_DIR, "package.json"));
const TSX_CLI_PATH = requireFromCli.resolve("tsx/cli");
const CLI_ENTRY_PATH = path.join(CLI_DIR, "src", "index.ts");
const INSPECTOR_FRONTEND_HTML =
  '<!doctype html><meta name="mcpjam-inspector" content="true"><title>MCPJam Inspector</title><div id="root"></div>';

async function runCli(
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<{
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
          NODE_NO_WARNINGS: "1",
          ...options.env,
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

function lastJsonLine(stdout: string): string {
  const lines = stdout.trim().split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }
    try {
      JSON.parse(line);
      return line;
    } catch {
      // Keep scanning for the final JSON envelope.
    }
  }
  return "";
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
  frontendUrl?: string;
  hasActiveClient?: boolean;
  serveFrontend?: boolean;
  toolResult?: unknown;
  toolRpcError?: { code: number; message: string };
  failRender?: boolean;
  commandDelays?: Partial<Record<string, number>>;
  commandErrors?: Partial<
    Record<string, { code: string; message: string; status?: number }>
  >;
}) {
  const requests: Array<{ method?: string; url?: string; body?: unknown }> = [];
  const toolResult = options.toolResult ?? {
    content: [{ type: "text", text: "view created" }],
  };

  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      requests.push({ method: request.method, url: request.url });
      if (options.serveFrontend === false) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(INSPECTOR_FRONTEND_HTML);
      return;
    }

    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          status: "ok",
          hasActiveClient: options.hasActiveClient ?? true,
          frontend: options.frontendUrl ?? `http://${request.headers.host}/`,
        }),
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

      if (request.url === "/api/mcp/connect-adhoc") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ success: true, status: "connected" }));
        return;
      }

      if (request.url === "/api/mcp/command") {
        const type = body.type as string | undefined;
        const commandError = type ? options.commandErrors?.[type] : undefined;
        const commandDelayMs = type ? options.commandDelays?.[type] : undefined;
        if (typeof commandDelayMs === "number" && commandDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, commandDelayMs));
        }
        if (commandError) {
          response.writeHead(commandError.status ?? 500, {
            "Content-Type": "application/json",
          });
          response.end(
            JSON.stringify({
              id: (body.id as string | undefined) ?? "cmd",
              status: "error",
              error: {
                code: commandError.code,
                message: commandError.message,
              },
            }),
          );
          return;
        }

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

async function startFrontendServerOnAvailablePort(ports: number[]) {
  let lastError: unknown;

  for (const port of ports) {
    let rootRequests = 0;
    const server = http.createServer((request, response) => {
      if (request.method === "GET" && request.url === "/") {
        rootRequests += 1;
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(INSPECTOR_FRONTEND_HTML);
        return;
      }

      response.writeHead(404);
      response.end();
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });

      return {
        get rootRequests() {
          return rootRequests;
        },
        url: `http://127.0.0.1:${port}`,
        stop: async () => {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        },
      };
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw error;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("No available port for frontend test server.");
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
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.equal(payload.success, true);
    assert.equal(payload.command, "tools call");
    assert.equal(payload.inspectorUi, true);
    assert.equal(
      payload.inspectorBrowserUrl,
      `http://127.0.0.1:${server.port}/#playground`,
    );
    assert.deepEqual(payload.result, toolResult);
    assert.deepEqual(payload.parameterKeys, ["shape"]);
    assert.equal(payload.params, undefined);
    assert.ok(payload.inspectorRender);
    assert.equal(payload.inspectorRender.status, "rendered");
    assert.equal(payload.inspectorRender.mode, "active-client");
    assert.equal(payload.inspectorRender.urlHydratesRender, false);
    assert.equal(
      payload.inspectorRender.browserUrl,
      `http://127.0.0.1:${server.port}/#playground`,
    );
    assert.deepEqual(payload.inspectorRender.commands, {
      openPlayground: { status: "success" },
      setAppContext: { status: "success" },
      renderToolResult: { status: "success" },
      snapshot: { status: "success" },
    });

    const mcpMethods = server.requests
      .filter((entry) => entry.url === "/mcp")
      .map((entry) => (entry.body as { method?: string }).method);
    assert.equal(
      mcpMethods.filter((method) => method === "tools/call").length,
      1,
    );
    assert.equal(mcpMethods.includes("tools/list"), false);

    const connectRequest = server.requests.find(
      (entry) => entry.url === "/api/mcp/connect-adhoc",
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
      ["openPlayground", "setAppContext", "renderToolResult", "snapshotApp"],
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

test("tools call --ui --frontend-url uses the explicit browser URL without probing frontend candidates", async () => {
  const toolResult = { content: [{ type: "text", text: "view created" }] };
  const server = await startMockServer({ toolResult });

  try {
    const explicitFrontendUrl = `http://localhost:${server.port}/inspector/?debug=1#old`;
    const result = await runCli([
      "--format",
      "json",
      "tools",
      "call",
      "--ui",
      "--frontend-url",
      explicitFrontendUrl,
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "create_view",
      "--tool-args",
      "{}",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.equal(payload.success, true);
    assert.equal(
      payload.inspectorBrowserUrl,
      `http://localhost:${server.port}/inspector/#playground`,
    );
    assert.equal(
      payload.inspectorFrontendUrl,
      `http://localhost:${server.port}/inspector`,
    );
    assert.equal(
      payload.inspectorRender.browserUrl,
      `http://localhost:${server.port}/inspector/#playground`,
    );
    assert.equal(payload.inspectorRender.browserOpenRequested, false);
    assert.equal(
      server.requests.some((entry) => entry.method === "GET" && entry.url === "/"),
      false,
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

test("tools call --ui --no-open in JSON mode skips render without an active Inspector client", async () => {
  const toolResult = { content: [{ type: "text", text: "view created" }] };
  const server = await startMockServer({ hasActiveClient: false, toolResult });

  try {
    const result = await runCli([
      "--format",
      "json",
      "tools",
      "call",
      "--ui",
      "--no-open",
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "create_view",
      "--tool-args",
      "{}",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stderr, /Warning: Inspector UI render skipped/);
    assert.match(result.stderr, /Tip: open the Inspector Playground/);
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.equal(payload.success, true);
    assert.equal(
      payload.inspectorBrowserUrl,
      `http://127.0.0.1:${server.port}/#playground`,
    );
    assert.equal(payload.inspectorRender.status, "skipped");
    assert.equal(payload.inspectorRender.remediation, "open_browser");
    assert.equal(payload.inspectorRender.hasActiveClient, false);
    assert.equal(payload.inspectorRender.inspectorStarted, false);
    assert.equal(payload.inspectorRender.browserOpenRequested, undefined);
    assert.equal(payload.error, undefined);
    assert.equal(payload.warning.code, "no_active_client");
    assert.equal(payload.warning.remediation, "open_browser");
    assert.equal(payload.warning.browserUrl, payload.inspectorBrowserUrl);
    assert.equal(payload.warning.hasActiveClient, false);
    assert.equal(payload.warning.inspectorStarted, false);
    assert.match(payload.warning.message, /no active browser client/i);
    assert.equal(payload.inspectorRender.warning.code, "no_active_client");
    assert.equal(payload.inspectorRender.warning.remediation, "open_browser");
    assert.equal(
      server.requests.some((entry) => entry.url === "/api/mcp/command"),
      false,
    );
  } finally {
    await server.stop();
  }
});

test("tools call --ui defaults to no-open in a non-TTY shell", async () => {
  const toolResult = { content: [{ type: "text", text: "view created" }] };
  const server = await startMockServer({ hasActiveClient: false, toolResult });

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

    assert.equal(result.exitCode, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /Inspector Playground URL:/);
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.equal(payload.success, true);
    assert.equal(payload.inspectorRender.status, "skipped");
    assert.equal(payload.inspectorRender.browserOpenRequested, undefined);
    assert.equal(payload.inspectorRender.remediation, "open_browser");
    assert.equal(payload.warning.code, "no_active_client");
    assert.equal(payload.warning.remediation, "open_browser");
    assert.equal(
      server.requests.some((entry) => entry.url === "/api/mcp/command"),
      false,
    );
  } finally {
    await server.stop();
  }
});

test("tools call --ui --no-open --quiet --format json does not scan nearby frontend ports", async () => {
  const frontend = await startFrontendServerOnAvailablePort([
    5181, 5182, 5183, 5184, 5185,
  ]);
  const frontendPort = Number(new URL(frontend.url).port);
  const staleFrontendUrl = `http://127.0.0.1:${frontendPort - 1}`;
  const toolResult = { content: [{ type: "text", text: "view created" }] };
  const server = await startMockServer({
    frontendUrl: staleFrontendUrl,
    hasActiveClient: false,
    serveFrontend: false,
    toolResult,
  });

  try {
    const result = await runCli([
      "--format",
      "json",
      "--quiet",
      "tools",
      "call",
      "--ui",
      "--no-open",
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "create_view",
      "--tool-args",
      "{}",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(frontend.rootRequests, 0);
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.equal(payload.success, true);
    assert.equal(
      payload.inspectorBrowserUrl,
      `${staleFrontendUrl}/#playground`,
    );
    assert.equal(payload.inspectorRender.status, "skipped");
    assert.equal(payload.inspectorRender.hasActiveClient, false);
    assert.equal(payload.inspectorRender.inspectorStarted, false);
    assert.equal(payload.error, undefined);
    assert.match(payload.warning.message, /no active browser client/i);
  } finally {
    await server.stop();
    await frontend.stop();
  }
});

test("tools call --ui --require-render turns skipped renders into hard errors", async () => {
  const toolResult = { content: [{ type: "text", text: "view created" }] };
  const server = await startMockServer({ hasActiveClient: false, toolResult });

  try {
    const result = await runCli([
      "--format",
      "json",
      "tools",
      "call",
      "--ui",
      "--require-render",
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
    assert.match(result.stderr, /Error: Inspector UI render required but skipped/);
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.equal(payload.success, false);
    assert.equal(payload.warning, undefined);
    assert.equal(payload.error.code, "no_active_client");
    assert.equal(payload.error.remediation, "open_browser");
    assert.equal(payload.inspectorRender.status, "skipped");
    assert.equal(payload.inspectorRender.remediation, "open_browser");
    assert.equal(payload.inspectorRender.warning.code, "no_active_client");
  } finally {
    await server.stop();
  }
});

test("tools call --ui opens by default in a TTY and may render while waiting for a browser client", async () => {
  const toolResult = { content: [{ type: "text", text: "view created" }] };
  const server = await startMockServer({ hasActiveClient: false, toolResult });

  try {
    const result = await runCli(
      [
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
      ],
      {
        env: {
          MCPJAM_CLI_TEST_STDOUT_TTY: "1",
          MCPJAM_CLI_TEST_STDERR_TTY: "1",
        },
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stderr, /Inspector Playground URL:/);
    assert.match(result.stderr, /Waiting for Inspector browser client/);
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.equal(payload.success, true);
    assert.equal(payload.inspectorRender.browserOpenRequested, true);
    assert.deepEqual(
      server.requests
        .filter((entry) => entry.url === "/api/mcp/command")
        .map((entry) => (entry.body as { type?: string }).type),
      ["openPlayground", "renderToolResult", "snapshotApp"],
    );
  } finally {
    await server.stop();
  }
});

test("tools call --ui --open keeps milestone progress but drops the elapsed heartbeat when stderr is not a TTY", async () => {
  const toolResult = { content: [{ type: "text", text: "view created" }] };
  const server = await startMockServer({
    commandDelays: { openPlayground: 2_100 },
    hasActiveClient: false,
    toolResult,
  });

  try {
    const result = await runCli(
      [
        "--format",
        "json",
        "tools",
        "call",
        "--ui",
        "--open",
        "--inspector-url",
        `http://127.0.0.1:${server.port}`,
        "--url",
        `http://127.0.0.1:${server.port}/mcp`,
        "--tool-name",
        "create_view",
        "--tool-args",
        "{}",
      ],
      {
        env: {
          MCPJAM_CLI_TEST_STDERR_TTY: "0",
        },
      },
    );

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stderr, /Inspector Playground URL:/);
    assert.match(result.stderr, /Waiting for Inspector browser client to connect/);
    assert.doesNotMatch(
      result.stderr,
      /Waiting for Inspector browser client to handle .* \(\d+s\)/,
    );
  } finally {
    await server.stop();
  }
});

test("tools call --ui --open treats Inspector command timeouts as render skips", async () => {
  const toolResult = { content: [{ type: "text", text: "view created" }] };
  const server = await startMockServer({
    commandErrors: {
      openPlayground: {
        code: "timeout",
        message: "Inspector command timed out after 30000ms.",
        status: 504,
      },
    },
    toolResult,
  });

  try {
    const result = await runCli([
      "--format",
      "json",
      "tools",
      "call",
      "--ui",
      "--open",
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "create_view",
      "--tool-args",
      "{}",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stderr, /Inspector Playground URL:/);
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.equal(payload.success, true);
    assert.equal(payload.error, undefined);
    assert.equal(payload.warning.code, "timeout");
    assert.equal(payload.warning.remediation, "retry");
    assert.equal(payload.inspectorRender.status, "skipped");
    assert.equal(payload.inspectorRender.remediation, "retry");
    assert.equal(payload.inspectorRender.warning.code, "timeout");
    assert.equal(payload.inspectorRender.warning.remediation, "retry");
    assert.equal(
      payload.inspectorRender.commands.openPlayground.error.code,
      "timeout",
    );
    assert.deepEqual(
      server.requests
        .filter((entry) => entry.url === "/api/mcp/command")
        .map((entry) => (entry.body as { type?: string }).type),
      ["openPlayground"],
    );
  } finally {
    await server.stop();
  }
});

test("tools call --ui classifies disconnected Inspector clients for agent recovery", async () => {
  const toolResult = { content: [{ type: "text", text: "view created" }] };
  const server = await startMockServer({
    commandErrors: {
      openPlayground: {
        code: "disconnected_server",
        message: "The Inspector client disconnected before the command completed.",
        status: 409,
      },
    },
    toolResult,
  });

  try {
    const result = await runCli([
      "--timeout",
      "250",
      "--format",
      "json",
      "tools",
      "call",
      "--ui",
      "--open",
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "create_view",
      "--tool-args",
      "{}",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.equal(payload.success, true);
    assert.equal(payload.warning.code, "disconnected_server");
    assert.equal(payload.warning.remediation, "reconnect_server");
    assert.equal(payload.inspectorRender.status, "skipped");
    assert.equal(payload.inspectorRender.remediation, "reconnect_server");
    assert.equal(payload.inspectorRender.warning.code, "disconnected_server");
  } finally {
    await server.stop();
  }
});

test("tools call --ui classifies unsupported Inspector modes for agent recovery", async () => {
  const toolResult = { content: [{ type: "text", text: "view created" }] };
  const server = await startMockServer({
    commandErrors: {
      openPlayground: {
        code: "unsupported_in_mode",
        message: "Playground is unavailable in the current Inspector mode.",
        status: 409,
      },
    },
    toolResult,
  });

  try {
    const result = await runCli([
      "--timeout",
      "250",
      "--format",
      "json",
      "tools",
      "call",
      "--ui",
      "--open",
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "create_view",
      "--tool-args",
      "{}",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.equal(payload.success, true);
    assert.equal(payload.warning.code, "unsupported_in_mode");
    assert.equal(payload.warning.remediation, "none");
    assert.equal(payload.inspectorRender.status, "skipped");
    assert.equal(payload.inspectorRender.remediation, "none");
    assert.equal(payload.inspectorRender.warning.code, "unsupported_in_mode");
  } finally {
    await server.stop();
  }
});

test("tools call --ui --open can discover a nearby dev frontend", async () => {
  const frontend = await startFrontendServerOnAvailablePort([
    5181, 5182, 5183, 5184, 5185,
  ]);
  const frontendPort = Number(new URL(frontend.url).port);
  const staleFrontendUrl = `http://127.0.0.1:${frontendPort - 1}`;
  const toolResult = { content: [{ type: "text", text: "view created" }] };
  const server = await startMockServer({
    frontendUrl: staleFrontendUrl,
    hasActiveClient: false,
    serveFrontend: false,
    toolResult,
  });

  try {
    const result = await runCli([
      "--format",
      "json",
      "tools",
      "call",
      "--ui",
      "--open",
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "create_view",
      "--tool-args",
      "{}",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.ok(frontend.rootRequests > 0);
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.equal(payload.success, true);
    assert.equal(payload.inspectorBrowserUrl, `${frontend.url}/#playground`);
    assert.equal(payload.inspectorFrontendUrl, frontend.url);
    assert.equal(payload.inspectorRender.browserOpenRequested, true);
  } finally {
    await server.stop();
    await frontend.stop();
  }
});

test("tools call --ui keeps full render details in --debug-out", async () => {
  const toolResult = {
    content: [{ type: "text", text: "view created" }],
    _meta: { requestId: "tool-result-1" },
  };
  const server = await startMockServer({ toolResult });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-cli-ui-"));
  const debugOut = path.join(tempDir, "debug.json");

  try {
    const result = await runCli([
      "--format",
      "json",
      "--quiet",
      "tools",
      "call",
      "--ui",
      "--debug-out",
      debugOut,
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "create_view",
      "--tool-args",
      '{"elements":"large payload"}',
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.deepEqual(payload.parameterKeys, ["elements"]);
    assert.equal(payload.params, undefined);
    assert.equal(payload.inspectorRender.renderToolResult, undefined);

    const artifact = JSON.parse(await readFile(debugOut, "utf8")) as Record<
      string,
      any
    >;
    assert.deepEqual(artifact.outcome.result.params, {
      elements: "large payload",
    });
    assert.deepEqual(
      artifact.outcome.result.inspectorRender.renderToolResult.result,
      { type: "renderToolResult" },
    );
  } finally {
    await server.stop();
    await rm(tempDir, { recursive: true, force: true });
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
    assert.equal(
      payload.inspectorRender.commands.renderToolResult.error.code,
      "render_failed",
    );

    const commandRequests = server.requests.filter(
      (entry) => entry.url === "/api/mcp/command",
    );
    assert.deepEqual(
      commandRequests.map((entry) => (entry.body as { type?: string }).type),
      ["openPlayground", "renderToolResult"],
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

test("tools call --require-render requires --ui", async () => {
  const result = await runCli([
    "--format",
    "json",
    "tools",
    "call",
    "--require-render",
    "--url",
    "http://example.test/mcp",
    "--tool-name",
    "create_view",
    "--tool-args",
    "{}",
  ]);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /--require-render requires --ui/);
});

test("tools call help lists frontend-url", async () => {
  const result = await runCli(["tools", "call", "--help"]);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /--tool-args-stdin/);
  assert.match(result.stdout, /--frontend-url <url>/);
  assert.match(result.stdout, /--require-render/);
  assert.match(result.stdout, /default with --ui in a TTY/);
});

test("tools call --ui rejects attach-only with open", async () => {
  const result = await runCli([
    "--format",
    "json",
    "tools",
    "call",
    "--ui",
    "--attach-only",
    "--open",
    "--url",
    "http://example.test/mcp",
    "--tool-name",
    "create_view",
    "--tool-args",
    "{}",
  ]);

  assert.equal(result.exitCode, 2);
  assert.match(
    result.stderr,
    /--attach-only cannot be used together with --open/,
  );
});

test("tools call --ui --attach-only keeps missing browser clients as hard errors", async () => {
  const toolResult = { content: [{ type: "text", text: "view created" }] };
  const server = await startMockServer({ hasActiveClient: false, toolResult });

  try {
    const result = await runCli([
      "--format",
      "json",
      "tools",
      "call",
      "--ui",
      "--attach-only",
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
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.equal(payload.success, false);
    assert.equal(payload.warning, undefined);
    assert.equal(payload.error.code, "no_active_client");
    assert.equal(payload.error.remediation, "open_browser");
    assert.equal(payload.inspectorRender.status, "error");
    assert.equal(payload.inspectorRender.error.code, "no_active_client");
    assert.equal(
      server.requests.some((entry) => entry.url === "/api/mcp/command"),
      false,
    );
  } finally {
    await server.stop();
  }
});

test("tools call --ui accepts frontend-url with open", async () => {
  const toolResult = { content: [{ type: "text", text: "view created" }] };
  const server = await startMockServer({
    hasActiveClient: false,
    serveFrontend: false,
    toolResult,
  });

  try {
    const result = await runCli([
      "--format",
      "json",
      "tools",
      "call",
      "--ui",
      "--open",
      "--frontend-url",
      `http://localhost:${server.port}/client`,
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "create_view",
      "--tool-args",
      "{}",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.equal(payload.success, true);
    assert.equal(
      payload.inspectorBrowserUrl,
      `http://localhost:${server.port}/client/#playground`,
    );
    assert.equal(payload.inspectorRender.browserOpenRequested, true);
  } finally {
    await server.stop();
  }
});

test("tools call --ui treats no-open as startable but attach-only as strict attach", () => {
  assert.equal(resolveInspectorStartIfNeeded({}), true);
  assert.equal(resolveInspectorStartIfNeeded({ open: false }), true);
  assert.equal(resolveInspectorStartIfNeeded({ open: true }), true);
  assert.equal(resolveInspectorStartIfNeeded({ attachOnly: true }), false);
});

test("tools call --ui resolves browser opening from TTY, attach, and explicit flags", () => {
  assert.equal(resolveInspectorOpenBrowser({}, { stdoutIsTTY: true }), true);
  assert.equal(resolveInspectorOpenBrowser({}, { stdoutIsTTY: false }), false);
  assert.equal(
    resolveInspectorOpenBrowser({ open: true }, { stdoutIsTTY: false }),
    true,
  );
  assert.equal(
    resolveInspectorOpenBrowser({ open: false }, { stdoutIsTTY: true }),
    false,
  );
  assert.equal(
    resolveInspectorOpenBrowser({ attachOnly: true }, { stdoutIsTTY: true }),
    false,
  );
});

test("tools call --ui resolves discovery policy from output mode and TTY defaults", () => {
  const humanOptions = {
    format: "human" as const,
    quiet: false,
    rpc: false,
    telemetry: true,
    timeout: 30_000,
  };
  const jsonOptions = { ...humanOptions, format: "json" as const };
  const quietOptions = { ...humanOptions, quiet: true };

  assert.equal(
    resolveInspectorSkipDiscovery({}, humanOptions, {
      openBrowser: true,
      stdoutIsTTY: true,
    }),
    false,
  );
  assert.equal(
    resolveInspectorSkipDiscovery({ open: true }, jsonOptions, {
      openBrowser: true,
      stdoutIsTTY: false,
    }),
    false,
  );
  assert.equal(
    resolveInspectorSkipDiscovery({}, jsonOptions, {
      openBrowser: false,
      stdoutIsTTY: false,
    }),
    true,
  );
  assert.equal(
    resolveInspectorSkipDiscovery({}, quietOptions, {
      openBrowser: false,
      stdoutIsTTY: false,
    }),
    true,
  );
  assert.equal(
    resolveInspectorSkipDiscovery({ open: false }, jsonOptions, {
      openBrowser: false,
      stdoutIsTTY: true,
    }),
    true,
  );
  assert.equal(
    resolveInspectorSkipDiscovery({ open: false }, quietOptions, {
      openBrowser: false,
      stdoutIsTTY: true,
    }),
    true,
  );
  assert.equal(
    resolveInspectorSkipDiscovery({ attachOnly: true }, humanOptions, {
      openBrowser: false,
      stdoutIsTTY: true,
    }),
    true,
  );
  assert.equal(
    resolveInspectorSkipDiscovery(
      { frontendUrl: "http://localhost:5173", open: true },
      humanOptions,
      {
        openBrowser: true,
        stdoutIsTTY: true,
      },
    ),
    true,
  );
  assert.equal(
    resolveInspectorSkipDiscovery({}, humanOptions, {
      openBrowser: false,
      stdoutIsTTY: false,
    }),
    true,
  );
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
    // stderr may carry Node/tsx warnings (e.g. DEP0205), so scan for the JSON line.
    assert.match(
      (JSON.parse(lastJsonLine(result.stderr)) as {
        error?: { message?: string };
      }).error?.message ?? "",
      /Invalid theme "blue"/,
    );
    assert.deepEqual(server.requests, []);
  } finally {
    await server.stop();
  }
});

test("tools call --ui validates frontend-url before executing the tool", async () => {
  const server = await startMockServer({});

  try {
    const result = await runCli([
      "--format",
      "json",
      "tools",
      "call",
      "--ui",
      "--frontend-url",
      "not a url",
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
    // stderr may carry Node/tsx warnings (e.g. DEP0205), so scan for the JSON line.
    assert.match(
      (JSON.parse(lastJsonLine(result.stderr)) as {
        error?: { message?: string };
      }).error?.message ?? "",
      /Invalid --frontend-url "not a url"/,
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
