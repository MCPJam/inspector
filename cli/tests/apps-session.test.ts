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
  buildWidgetSessionActionOutput,
  buildWidgetSessionStartOutput,
  parseBrowserActionSpec,
  type WidgetSessionActionResponse,
  type WidgetSessionStartResponse,
} from "../src/lib/widget-session.js";
import { CliError } from "../src/lib/output.js";

/* ------------------------------------------------------------------ *
 * Pure helpers — action parsing + output shaping.
 * ------------------------------------------------------------------ */

test("parseBrowserActionSpec builds specs and validates flags", () => {
  assert.deepEqual(parseBrowserActionSpec({ action: "screenshot" }), {
    action: "screenshot",
  });
  assert.deepEqual(
    parseBrowserActionSpec({ action: "left_click", coordinate: "640,400" }),
    { action: "left_click", coordinate: [640, 400] },
  );
  assert.deepEqual(
    parseBrowserActionSpec({
      action: "scroll",
      scrollDirection: "down",
      scrollAmount: "3",
    }),
    { action: "scroll", scrollDirection: "down", scrollAmount: 3 },
  );
  assert.deepEqual(parseBrowserActionSpec({ action: "type", text: "hi" }), {
    action: "type",
    text: "hi",
  });

  assert.throws(
    () => parseBrowserActionSpec({}),
    (e) => e instanceof CliError && /--action is required/.test(e.message),
  );
  assert.throws(
    () => parseBrowserActionSpec({ action: "teleport" }),
    (e) => e instanceof CliError && /Invalid action/.test(e.message),
  );
  assert.throws(
    () => parseBrowserActionSpec({ action: "left_click", coordinate: "640" }),
    (e) => e instanceof CliError && /Invalid --coordinate/.test(e.message),
  );
  assert.throws(
    () =>
      parseBrowserActionSpec({ action: "scroll", scrollDirection: "sideways" }),
    (e) => e instanceof CliError && /Invalid --scroll-direction/.test(e.message),
  );
  // Numeric action flags are bounded — negative/zero values are nonsensical.
  assert.throws(
    () =>
      parseBrowserActionSpec({
        action: "scroll",
        scrollDirection: "down",
        scrollAmount: "0",
      }),
    (e) =>
      e instanceof CliError && /--scroll-amount must be greater than 0/.test(e.message),
  );
  assert.throws(
    () => parseBrowserActionSpec({ action: "wait", duration: "-1" }),
    (e) =>
      e instanceof CliError &&
      /--duration must be greater than or equal to 0/.test(e.message),
  );
});

test("buildWidgetSessionStartOutput carries session metadata and keeps base64 opt-in", () => {
  const response: WidgetSessionStartResponse = {
    sessionId: "sess-1",
    status: "rendered",
    mountedWidgetId: "widget-1",
    viewport: { width: 1280, height: 800 },
    expiresAt: 123,
    idleTimeoutMs: 300000,
    resourceUri: "ui://widget/seats",
    screenshotBase64: "aGVsbG8=",
    elapsedMs: 9,
  };
  const fileOnly = buildWidgetSessionStartOutput(response, {
    screenshotPath: "/tmp/s.png",
    toolName: "show_seats",
    serverName: "flights",
  });
  assert.equal(fileOnly.sessionId, "sess-1");
  assert.equal(fileOnly.mountedWidgetId, "widget-1");
  assert.deepEqual(fileOnly.viewport, { width: 1280, height: 800 });
  assert.equal(fileOnly.idleTimeoutMs, 300000);
  assert.equal(fileOnly.toolName, "show_seats");
  assert.equal(fileOnly.serverName, "flights");
  assert.equal(fileOnly.screenshotPath, "/tmp/s.png");
  assert.equal(fileOnly.screenshotCaptured, true);
  assert.equal(fileOnly.screenshotBase64, undefined);
  assert.equal(fileOnly.observation.resourceUri, "ui://widget/seats");

  const withBase64 = buildWidgetSessionStartOutput(response, {
    includeBase64: true,
  });
  assert.equal(withBase64.screenshotBase64, "aGVsbG8=");
});

test("buildWidgetSessionActionOutput surfaces tool calls, note, and TTL", () => {
  const response: WidgetSessionActionResponse = {
    action: { action: "left_click", coordinate: [1, 2] },
    screenshotBase64: "ZnJhbWU=",
    widgetToolCalls: [
      { name: "reserve", args: { seat: 1 }, ok: true, elapsedMs: 1 },
    ],
    note: "step_budget_exceeded",
    elapsedMs: 5,
    expiresAt: 999,
  };
  const out = buildWidgetSessionActionOutput(response, { includeBase64: true });
  assert.deepEqual(out.action, { action: "left_click", coordinate: [1, 2] });
  assert.equal(out.widgetToolCalls.length, 1);
  assert.equal(out.note, "step_budget_exceeded");
  assert.equal(out.expiresAt, 999);
  assert.equal(out.screenshotBase64, "ZnJhbWU=");
  assert.equal(out.screenshotCaptured, true);
});

/* ------------------------------------------------------------------ *
 * Subprocess integration — start -> action -> close against a mock Inspector.
 * ------------------------------------------------------------------ */

const CLI_DIR = process.cwd().endsWith(`${path.sep}cli`)
  ? process.cwd()
  : path.join(process.cwd(), "cli");
const requireFromCli = createRequire(path.join(CLI_DIR, "package.json"));
const TSX_CLI_PATH = requireFromCli.resolve("tsx/cli");
const CLI_ENTRY_PATH = path.join(CLI_DIR, "src", "index.ts");

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("frame"),
]);
const PNG_B64 = PNG_BYTES.toString("base64");

async function runCli(
  args: string[],
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
        },
      },
      (error, stdout, stderr) => {
        if (
          error &&
          (error as NodeJS.ErrnoException).code !== undefined &&
          typeof (error as NodeJS.ErrnoException).code !== "number"
        ) {
          reject(new Error(`Failed to execute CLI: ${String(error)}`));
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
      /* keep scanning */
    }
  }
  return "";
}

async function readJsonBody(
  request: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

async function startMockInspector(
  options: { startResponse?: Record<string, unknown> } = {},
) {
  const requests: Array<{ method?: string; url?: string; body?: unknown }> = [];

  const server = http.createServer(async (request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url === "/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok", hasActiveClient: false }));
      return;
    }
    if (request.method === "GET" && url === "/api/session-token") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ token: "test-token" }));
      return;
    }
    if (request.method === "POST" && url === "/api/mcp/connect") {
      requests.push({ method: "POST", url, body: await readJsonBody(request) });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ success: true, status: "connected" }));
      return;
    }
    if (request.method === "POST" && url === "/api/mcp/widget-session") {
      requests.push({ method: "POST", url, body: await readJsonBody(request) });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          options.startResponse ?? {
            sessionId: "sess-abc",
            status: "rendered",
            mountedWidgetId: "widget-abc",
            viewport: { width: 1280, height: 800 },
            expiresAt: Date.now() + 300000,
            idleTimeoutMs: 300000,
            resourceUri: "ui://widget/seats",
            bridgeInitialized: true,
            screenshotBase64: PNG_B64,
            elapsedMs: 11,
          },
        ),
      );
      return;
    }
    if (request.method === "POST" && /\/action$/.test(url)) {
      requests.push({ method: "POST", url, body: await readJsonBody(request) });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          action: { action: "left_click", coordinate: [640, 400] },
          screenshotBase64: PNG_B64,
          widgetToolCalls: [
            { name: "reserve", args: { seat: 12 }, ok: true, elapsedMs: 2 },
          ],
          elapsedMs: 4,
          expiresAt: Date.now() + 300000,
        }),
      );
      return;
    }
    if (request.method === "DELETE" && url.startsWith("/api/mcp/widget-session/")) {
      requests.push({ method: "DELETE", url });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ closed: true }));
      return;
    }
    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    requests,
    stop: async () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  };
}

test("apps session start renders, writes the frame, and returns a sessionId", async () => {
  const server = await startMockInspector();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "mcpjam-apps-session-"));
  const screenshotOut = path.join(tempDir, "frame.png");

  try {
    const result = await runCli([
      "--format",
      "json",
      "apps",
      "session",
      "start",
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--url",
      `http://127.0.0.1:${server.port}/mcp`,
      "--tool-name",
      "show_seats",
      "--tool-args",
      "{}",
      "--screenshot-out",
      screenshotOut,
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.equal(payload.status, "rendered");
    assert.equal(payload.sessionId, "sess-abc");
    assert.equal(payload.mountedWidgetId, "widget-abc");
    assert.deepEqual(payload.viewport, { width: 1280, height: 800 });
    assert.equal(payload.toolName, "show_seats");
    assert.equal(payload.screenshotPath, screenshotOut);
    assert.equal(payload.screenshotBase64, undefined);

    const bytes = await readFile(screenshotOut);
    assert.ok(bytes.equals(PNG_BYTES));

    const startReq = server.requests.find(
      (r) => r.url === "/api/mcp/widget-session",
    );
    assert.equal((startReq?.body as any)?.toolName, "show_seats");
  } finally {
    await server.stop();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("apps session start rejects a rendered response with no sessionId", async () => {
  // A rendered verdict with no session id is unusable — the agent has nothing
  // to step — so the CLI must fail rather than exit 0.
  const server = await startMockInspector({
    startResponse: { status: "rendered" },
  });
  try {
    const result = await runCli([
      "--format",
      "json",
      "apps",
      "session",
      "start",
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
    assert.match(
      (JSON.parse(lastJsonLine(result.stderr)) as { error?: { message?: string } })
        .error?.message ?? "",
      /rendered but missing a sessionId/,
    );
  } finally {
    await server.stop();
  }
});

test("apps session action forwards the action spec and returns tool calls", async () => {
  const server = await startMockInspector();

  try {
    const result = await runCli([
      "--format",
      "json",
      "apps",
      "session",
      "action",
      "--session",
      "sess-abc",
      "--action",
      "left_click",
      "--coordinate",
      "640,400",
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
      "--screenshot-base64",
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    const payload = JSON.parse(lastJsonLine(result.stdout)) as Record<
      string,
      any
    >;
    assert.deepEqual(payload.action, {
      action: "left_click",
      coordinate: [640, 400],
    });
    assert.equal(payload.widgetToolCalls[0].name, "reserve");
    assert.equal(payload.screenshotBase64, PNG_B64);

    const actionReq = server.requests.find((r) => /\/action$/.test(r.url ?? ""));
    assert.equal(actionReq?.url, "/api/mcp/widget-session/sess-abc/action");
    assert.deepEqual((actionReq?.body as any)?.action, {
      action: "left_click",
      coordinate: [640, 400],
    });
  } finally {
    await server.stop();
  }
});

test("apps session close disposes the session", async () => {
  const server = await startMockInspector();

  try {
    const result = await runCli([
      "--format",
      "json",
      "apps",
      "session",
      "close",
      "--session",
      "sess-abc",
      "--inspector-url",
      `http://127.0.0.1:${server.port}`,
    ]);

    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(lastJsonLine(result.stdout)), { closed: true });
    const del = server.requests.find((r) => r.method === "DELETE");
    assert.equal(del?.url, "/api/mcp/widget-session/sess-abc");
  } finally {
    await server.stop();
  }
});

test("apps session action requires --session and --action", async () => {
  const missingSession = await runCli([
    "--format",
    "json",
    "apps",
    "session",
    "action",
    "--action",
    "screenshot",
  ]);
  assert.equal(missingSession.exitCode, 2);
  assert.match(missingSession.stderr, /required option .*--session/i);

  const missingAction = await runCli([
    "--format",
    "json",
    "apps",
    "session",
    "action",
    "--session",
    "sess-abc",
  ]);
  assert.equal(missingAction.exitCode, 2);
  assert.match(missingAction.stderr, /required option .*--action/i);
});

test("apps session help lists start, action, and close", async () => {
  const result = await runCli(["apps", "session", "--help"]);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /start/);
  assert.match(result.stdout, /action/);
  assert.match(result.stdout, /close/);
});
