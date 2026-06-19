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
  buildWidgetRenderOutput,
  parseWidgetRenderViewport,
  resolveRenderRequestTimeoutMs,
  resolveWidgetRenderInjectOpenAiCompat,
  runWidgetRender,
  type WidgetRenderClient,
  type WidgetRenderResponse,
} from "../src/lib/widget-render.js";
import { CliError } from "../src/lib/output.js";

/* ------------------------------------------------------------------ *
 * Pure helpers (no subprocess) — parsing + output shaping.
 * ------------------------------------------------------------------ */

test("parseWidgetRenderViewport parses WxH and rejects malformed values", () => {
  assert.deepEqual(parseWidgetRenderViewport("1280x800"), {
    width: 1280,
    height: 800,
  });
  assert.deepEqual(parseWidgetRenderViewport(" 414 x 896 "), {
    width: 414,
    height: 896,
  });
  assert.equal(parseWidgetRenderViewport(undefined), undefined);
  assert.equal(parseWidgetRenderViewport(""), undefined);

  for (const bad of ["1280", "1280*800", "axb", "1280x", "x800"]) {
    assert.throws(
      () => parseWidgetRenderViewport(bad),
      (error) => error instanceof CliError && /Invalid viewport/.test(error.message),
      bad,
    );
  }

  // Shares the server's max-edge cap so absurd sizes fail before connecting.
  assert.deepEqual(parseWidgetRenderViewport("8192x8192"), {
    width: 8192,
    height: 8192,
  });
  for (const tooBig of ["8193x100", "100x99999", "999999x999999"]) {
    assert.throws(
      () => parseWidgetRenderViewport(tooBig),
      (error) =>
        error instanceof CliError && /between 1 and 8192/.test(error.message),
      tooBig,
    );
  }
});

test("resolveWidgetRenderInjectOpenAiCompat maps protocol to the shim flag", () => {
  assert.equal(resolveWidgetRenderInjectOpenAiCompat(undefined), false);
  assert.equal(resolveWidgetRenderInjectOpenAiCompat("mcp-apps"), false);
  assert.equal(resolveWidgetRenderInjectOpenAiCompat("openai-sdk"), true);
  assert.throws(
    () => resolveWidgetRenderInjectOpenAiCompat("bogus"),
    (error) => error instanceof CliError && /Invalid protocol/.test(error.message),
  );
});

test("buildWidgetRenderOutput keeps base64 opt-in and folds the observation", () => {
  const response: WidgetRenderResponse = {
    status: "rendered",
    resourceUri: "ui://widget/seats",
    bridgeInitialized: true,
    screenshotBase64: "aGVsbG8=",
    consoleErrors: ["warn"],
    blockedRequests: ["https://blocked.example"],
    elapsedMs: 42,
  };

  const fileOnly = buildWidgetRenderOutput(response, {
    screenshotPath: "/tmp/out.png",
  });
  assert.equal(fileOnly.status, "rendered");
  assert.equal(fileOnly.screenshotCaptured, true);
  assert.equal(fileOnly.screenshotPath, "/tmp/out.png");
  assert.equal(fileOnly.screenshotBase64, undefined);
  assert.deepEqual(fileOnly.observation, {
    consoleErrors: ["warn"],
    blockedRequests: ["https://blocked.example"],
    resourceUri: "ui://widget/seats",
    bridgeInitialized: true,
    elapsedMs: 42,
  });

  const withBase64 = buildWidgetRenderOutput(response, {
    screenshotPath: "/tmp/out.png",
    includeBase64: true,
  });
  assert.equal(withBase64.screenshotBase64, "aGVsbG8=");

  // toolName/serverName echo the request for self-describing agent logs.
  assert.equal(fileOnly.toolName, undefined);
  assert.equal(fileOnly.serverName, undefined);
  const labeled = buildWidgetRenderOutput(response, {
    toolName: "show_seats",
    serverName: "flights",
  });
  assert.equal(labeled.toolName, "show_seats");
  assert.equal(labeled.serverName, "flights");
});

test("resolveRenderRequestTimeoutMs floors the render timeout for Chromium install", () => {
  // The default 30s op timeout is too short for a first-run Chromium install.
  assert.equal(resolveRenderRequestTimeoutMs(30_000), 5 * 60_000);
  // A larger explicit timeout still wins.
  assert.equal(resolveRenderRequestTimeoutMs(10 * 60_000), 10 * 60_000);
});

test("runWidgetRender sends the render POST with the floored timeout", async () => {
  const calls: Array<{ path: string; timeoutMs?: number }> = [];
  const client: WidgetRenderClient = {
    ensureBackend: async () => ({
      baseUrl: "http://127.0.0.1:6274",
      hasActiveClient: false,
      started: false,
    }),
    connectServerAdhoc: async () => ({ success: true }),
    request: async (path: string, init?: { timeoutMs?: number }) => {
      calls.push({ path, timeoutMs: init?.timeoutMs });
      return { status: "rendered", elapsedMs: 1 } satisfies WidgetRenderResponse;
    },
  };

  const response = await runWidgetRender(
    {
      config: { url: "http://127.0.0.1:9/mcp" } as never,
      serverName: "srv",
      toolName: "show_seats",
      parameters: {},
      timeoutMs: 30_000,
    },
    { client },
  );

  assert.equal(response.status, "rendered");
  const renderCall = calls.find((c) => c.path === "/api/mcp/widget-render");
  assert.ok(renderCall, "render POST was issued");
  assert.equal(renderCall?.timeoutMs, 5 * 60_000);
});

test("buildWidgetRenderOutput surfaces the install hint and no screenshot", () => {
  const output = buildWidgetRenderOutput({
    status: "browser_unavailable",
    hint: "npx playwright install chromium",
    elapsedMs: 3,
  });
  assert.equal(output.status, "browser_unavailable");
  assert.equal(output.hint, "npx playwright install chromium");
  assert.equal(output.screenshotCaptured, false);
  assert.equal(output.screenshotPath, undefined);
  assert.equal(output.screenshotBase64, undefined);
});

/* ------------------------------------------------------------------ *
 * Subprocess integration — drives the real CLI against a mock Inspector.
 * ------------------------------------------------------------------ */

const CLI_DIR = process.cwd().endsWith(`${path.sep}cli`)
  ? process.cwd()
  : path.join(process.cwd(), "cli");
const requireFromCli = createRequire(path.join(CLI_DIR, "package.json"));
const TSX_CLI_PATH = requireFromCli.resolve("tsx/cli");
const CLI_ENTRY_PATH = path.join(CLI_DIR, "src", "index.ts");

// Bytes that begin with the PNG signature so the round-trip can assert both the
// exact payload and that a PNG landed on disk. Not a fully-valid image, which is
// unnecessary for the write path.
const SCREENSHOT_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("fake-png-body"),
]);
const SCREENSHOT_B64 = SCREENSHOT_BYTES.toString("base64");

async function runCli(
  args: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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
          // Keep the tsx runner's Node deprecation warnings (e.g. [DEP0205])
          // out of stdout/stderr so the CLI's JSON is the only content there.
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
    if (!line) continue;
    try {
      JSON.parse(line);
      return line;
    } catch {
      // keep scanning
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
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

async function startMockInspector(options: {
  render?: Record<string, unknown>;
  renderStatus?: number;
}) {
  const requests: Array<{ method?: string; url?: string; body?: unknown }> = [];
  const renderBody = options.render ?? {
    status: "rendered",
    resourceUri: "ui://widget/seats",
    bridgeInitialized: true,
    screenshotBase64: SCREENSHOT_B64,
    elapsedMs: 12,
  };

  const server = http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ status: "ok", hasActiveClient: false }),
      );
      return;
    }

    if (request.method === "GET" && request.url === "/api/session-token") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ token: "test-token" }));
      return;
    }

    if (request.method === "POST" && request.url === "/api/mcp/connect-adhoc") {
      const body = await readJsonBody(request);
      requests.push({ method: request.method, url: request.url, body });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: true, status: "connected" }));
      return;
    }

    if (request.method === "POST" && request.url === "/api/mcp/widget-render") {
      const body = await readJsonBody(request);
      requests.push({ method: request.method, url: request.url, body });
      response.writeHead(options.renderStatus ?? 200, {
        "Content-Type": "application/json",
      });
      response.end(JSON.stringify(renderBody));
      return;
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

function widgetRenderRequest(
  requests: Array<{ url?: string; body?: unknown }>,
): Record<string, unknown> | undefined {
  return requests.find((entry) => entry.url === "/api/mcp/widget-render")
    ?.body as Record<string, unknown> | undefined;
}

test("apps render writes the screenshot to a file and keeps stdout clean", async () => {
  const server = await startMockInspector({});
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-apps-render-"));
  const screenshotOut = path.join(tempDir, "out.png");

  try {
    const result = await runCli([
      "--format",
      "json",
      "apps",
      "render",
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "show_seats",
      "--tool-args",
      '{"seat":12}',
      "--screenshot-out",
      screenshotOut,
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.equal(payload.status, "rendered");
    assert.equal(payload.toolName, "show_seats");
    assert.equal(payload.serverName, `127-0-0-1-${server.port}-mcp`);
    assert.equal(payload.screenshotPath, screenshotOut);
    assert.equal(payload.screenshotCaptured, true);
    assert.equal(payload.screenshotBase64, undefined);
    assert.equal(payload.observation.resourceUri, "ui://widget/seats");
    assert.equal(payload.observation.bridgeInitialized, true);

    const bytes = await readFile(screenshotOut);
    assert.ok(bytes.equals(SCREENSHOT_BYTES));
    assert.ok(
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    );

    // The render server-side path connects the target server first.
    const connect = server.requests.find(
      (entry) => entry.url === "/api/mcp/connect-adhoc",
    );
    assert.equal(
      (connect?.body as { serverId?: string } | undefined)?.serverId,
      `127-0-0-1-${server.port}-mcp`,
    );
    const renderReq = widgetRenderRequest(server.requests);
    assert.equal(renderReq?.serverId, `127-0-0-1-${server.port}-mcp`);
    assert.equal(renderReq?.toolName, "show_seats");
    assert.deepEqual(renderReq?.parameters, { seat: 12 });
    assert.equal(renderReq?.injectOpenAiCompat, undefined);
    assert.equal(renderReq?.viewport, undefined);
  } finally {
    await server.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("apps render --screenshot-base64 inlines the image", async () => {
  const server = await startMockInspector({});

  try {
    const result = await runCli([
      "--format",
      "json",
      "apps",
      "render",
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "show_seats",
      "--tool-args",
      "{}",
      "--screenshot-base64",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.equal(payload.status, "rendered");
    assert.equal(payload.screenshotBase64, SCREENSHOT_B64);
    assert.equal(payload.screenshotPath, undefined);
    assert.equal(payload.screenshotCaptured, true);
  } finally {
    await server.stop();
  }
});

test("apps render without screenshot flags reports capture but emits no image", async () => {
  const server = await startMockInspector({});

  try {
    const result = await runCli([
      "--format",
      "json",
      "apps",
      "render",
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "show_seats",
      "--tool-args",
      "{}",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.equal(payload.status, "rendered");
    assert.equal(payload.screenshotCaptured, true);
    assert.equal(payload.screenshotBase64, undefined);
    assert.equal(payload.screenshotPath, undefined);
  } finally {
    await server.stop();
  }
});

test("apps render forwards viewport and protocol to the render request", async () => {
  const server = await startMockInspector({});

  try {
    const result = await runCli([
      "--format",
      "json",
      "apps",
      "render",
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "show_seats",
      "--tool-args",
      "{}",
      "--viewport",
      "414x896",
      "--protocol",
      "openai-sdk",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const renderReq = widgetRenderRequest(server.requests);
    assert.deepEqual(renderReq?.viewport, { width: 414, height: 896 });
    assert.equal(renderReq?.injectOpenAiCompat, true);
  } finally {
    await server.stop();
  }
});

test("apps render --require-render exits non-zero when the widget does not render", async () => {
  const server = await startMockInspector({
    render: {
      status: "browser_unavailable",
      hint: "npx playwright install chromium",
      elapsedMs: 2,
    },
  });

  try {
    const result = await runCli([
      "--format",
      "json",
      "apps",
      "render",
      "--require-render",
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "show_seats",
      "--tool-args",
      "{}",
    ]);

    assert.equal(result.exitCode, 1, result.stderr);
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.equal(payload.status, "browser_unavailable");
    assert.equal(payload.hint, "npx playwright install chromium");
  } finally {
    await server.stop();
  }
});

test("apps render surfaces browser_unavailable without --require-render at exit 0", async () => {
  const server = await startMockInspector({
    render: {
      status: "browser_unavailable",
      hint: "npx playwright install chromium",
      elapsedMs: 2,
    },
  });

  try {
    const result = await runCli([
      "--format",
      "json",
      "apps",
      "render",
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "show_seats",
      "--tool-args",
      "{}",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.equal(payload.status, "browser_unavailable");
    assert.equal(payload.hint, "npx playwright install chromium");
    assert.equal(payload.screenshotCaptured, false);
  } finally {
    await server.stop();
  }
});

test("apps render requires a tool name", async () => {
  const result = await runCli([
    "--format",
    "json",
    "apps",
    "render",
    "--url",
    "http://example.test/mcp",
  ]);

  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /Tool name is required/);
});

test("apps render rejects a malformed viewport before contacting Inspector", async () => {
  const result = await runCli([
    "--format",
    "json",
    "apps",
    "render",
    "--url",
    "http://example.test/mcp",
    "--tool-name",
    "show_seats",
    "--tool-args",
    "{}",
    "--viewport",
    "wide",
  ]);

  assert.equal(result.exitCode, 2);
  assert.match(
    (JSON.parse(lastJsonLine(result.stderr)) as { error?: { message?: string } })
      .error?.message ?? "",
    /Invalid viewport "wide"/,
  );
});

test("apps render help lists the headless render flags", async () => {
  const result = await runCli(["apps", "render", "--help"]);

  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /--screenshot-out <path>/);
  assert.match(result.stdout, /--screenshot-base64/);
  assert.match(result.stdout, /--viewport <WxH>/);
  assert.match(result.stdout, /--protocol <protocol>/);
  assert.match(result.stdout, /--require-render/);
});
