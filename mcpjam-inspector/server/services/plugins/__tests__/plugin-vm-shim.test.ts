/**
 * The shim runs as a standalone Node program inside a sandbox VM, so every
 * wire test here drives the real thing: a spawned `node mcpjam-plugin-shim.mjs`
 * with a real stdio MCP child under it, over real HTTP on an ephemeral port.
 * Mocking either boundary would test the parts the shim does not own.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyClientMessage,
  constantTimeEquals,
  drainFramedLines,
  parseLaunchSpec,
  parseShimConfig,
} from "../shim/mcpjam-plugin-shim.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SHIM_PATH = join(here, "..", "shim", "mcpjam-plugin-shim.mjs");
const FIXTURE_PATH = join(here, "fixtures", "fake-stdio-mcp-server.mjs");

const TOKEN = "shim-test-token-0123456789abcdefghij";

/** Spawned with `stdio: ["ignore", "pipe", "pipe"]`: no stdin, both readers. */
type ShimProcess = ChildProcessByStdio<null, Readable, Readable>;

interface ShimHandle {
  url: string;
  token: string;
  stderr: () => string;
  stop: () => Promise<void>;
}

interface StartOptions {
  /** Extra/overriding `MCPJAM_SHIM_*` variables. */
  env?: Record<string, string>;
  /** Extra environment for the stdio child the shim launches. */
  childEnv?: Record<string, string>;
  /** Replace the child command, to exercise a launch that cannot succeed. */
  command?: string;
}

const running = new Set<ShimProcess>();

async function startShim(options: StartOptions = {}): Promise<ShimHandle> {
  const launch = {
    command: options.command ?? process.execPath,
    args: options.command === undefined ? [FIXTURE_PATH] : [],
    env: options.childEnv ?? {},
  };
  const child = spawn(process.execPath, [SHIM_PATH], {
    env: {
      ...process.env,
      MCPJAM_SHIM_PORT: "0",
      MCPJAM_SHIM_TOKEN: TOKEN,
      MCPJAM_SHIM_LAUNCH: JSON.stringify(launch),
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.add(child);

  let stderrText = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrText += chunk;
  });

  const port = await readListeningPort(child);

  return {
    url: `http://127.0.0.1:${port}`,
    token: TOKEN,
    stderr: () => stderrText,
    stop: () => stopChild(child),
  };
}

function readListeningPort(child: ShimProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    child.stdout.setEncoding("utf8");
    const onData = (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
        try {
          const parsed = JSON.parse(line);
          if (parsed?.event === "listening") {
            child.stdout.off("data", onData);
            resolve(parsed.port);
            return;
          }
        } catch {
          // Not the ready line; the shim writes nothing else here.
        }
      }
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) =>
      reject(new Error(`shim exited before listening (code ${code})`))
    );
  });
}

function stopChild(child: ShimProcess): Promise<void> {
  running.delete(child);
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

afterEach(async () => {
  await Promise.all([...running].map((child) => stopChild(child)));
});

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  label: string,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface PostOptions {
  sessionId?: string;
  token?: string | null;
  headers?: Record<string, string>;
}

function post(shim: ShimHandle, body: unknown, options: PostOptions = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...options.headers,
  };
  const token = options.token === undefined ? shim.token : options.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (options.sessionId !== undefined)
    headers["mcp-session-id"] = options.sessionId;
  return fetch(`${shim.url}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

let nextId = 1;
function initializeRequest() {
  return {
    jsonrpc: "2.0",
    id: nextId++,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    },
  };
}

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: nextId++,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

/** Open a session and return its id plus the child's pid from the handshake. */
async function openSession(shim: ShimHandle) {
  const response = await post(shim, initializeRequest());
  expect(response.status).toBe(200);
  const sessionId = response.headers.get("mcp-session-id");
  expect(sessionId).toBeTruthy();
  const body = (await response.json()) as {
    result: { _meta: { pid: number } };
  };
  return { sessionId: sessionId as string, pid: body.result._meta.pid };
}

async function health(shim: ShimHandle) {
  const response = await fetch(`${shim.url}/healthz`);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

describe("plugin vm shim: framing", () => {
  it("returns complete lines and carries the partial one forward", () => {
    const first = drainFramedLines('{"a":1}\n{"b":');
    expect(first.lines).toEqual(['{"a":1}']);
    expect(first.rest).toBe('{"b":');

    const second = drainFramedLines(`${first.rest}2}\n`);
    expect(second.lines).toEqual(['{"b":2}']);
    expect(second.rest).toBe("");
  });

  it("drops blank lines and trims the carriage return of CRLF framing", () => {
    const drained = drainFramedLines('\n  \n{"a":1}\r\n\n{"b":2}\r\n');
    expect(drained.lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(drained.rest).toBe("");
  });

  it("keeps a buffer with no newline whole", () => {
    const drained = drainFramedLines('{"a"');
    expect(drained.lines).toEqual([]);
    expect(drained.rest).toBe('{"a"');
  });
});

describe("plugin vm shim: message classification", () => {
  it("separates requests, notifications and everything else", () => {
    expect(
      classifyClientMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    ).toBe("request");
    expect(
      classifyClientMessage({ jsonrpc: "2.0", id: "a", method: "tools/list" })
    ).toBe("request");
    expect(
      classifyClientMessage({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      })
    ).toBe("notification");
    // A response has no method: it could only answer a server-initiated
    // request, which this transport never delivers.
    expect(classifyClientMessage({ jsonrpc: "2.0", id: 1, result: {} })).toBe(
      "unsupported"
    );
    expect(classifyClientMessage({ id: 1, method: "tools/list" })).toBe(
      "invalid"
    );
    expect(classifyClientMessage({ jsonrpc: "2.0", id: {}, method: "x" })).toBe(
      "invalid"
    );
    expect(classifyClientMessage("nope")).toBe("invalid");
  });
});

describe("plugin vm shim: configuration parsing", () => {
  const baseEnv = {
    MCPJAM_SHIM_PORT: "0",
    MCPJAM_SHIM_TOKEN: TOKEN,
    MCPJAM_SHIM_LAUNCH: JSON.stringify({ command: "node" }),
  };

  it("fills in defaults for every optional knob", () => {
    const config = parseShimConfig(baseEnv);
    expect(config.host).toBe("0.0.0.0");
    expect(config.maxSessions).toBe(8);
    expect(config.sessionIdleMs).toBe(300000);
    expect(config.requestTimeoutMs).toBe(120000);
    expect(config.launch).toEqual({
      command: "node",
      args: [],
      env: {},
      cwd: undefined,
    });
  });

  it("accepts overrides and rejects unusable ones", () => {
    expect(
      parseShimConfig({ ...baseEnv, MCPJAM_SHIM_MAX_SESSIONS: "3" }).maxSessions
    ).toBe(3);
    expect(() =>
      parseShimConfig({ ...baseEnv, MCPJAM_SHIM_MAX_SESSIONS: "0" })
    ).toThrow(/greater than 0/);
    expect(() =>
      parseShimConfig({ ...baseEnv, MCPJAM_SHIM_SESSION_IDLE_MS: "-1" })
    ).toThrow();
    expect(() =>
      parseShimConfig({ ...baseEnv, MCPJAM_SHIM_PORT: "abc" })
    ).toThrow(/0-65535/);
    expect(() =>
      parseShimConfig({ ...baseEnv, MCPJAM_SHIM_TOKEN: "tiny" })
    ).toThrow(/32 characters/);
  });

  it("validates the launch spec strictly", () => {
    expect(
      parseLaunchSpec(
        JSON.stringify({
          command: "node",
          args: ["a"],
          env: { X: "1" },
          cwd: "/w",
        })
      )
    ).toEqual({
      command: "node",
      args: ["a"],
      env: { X: "1" },
      cwd: "/w",
    });
    expect(() => parseLaunchSpec(undefined)).toThrow(/required/);
    expect(() => parseLaunchSpec("{")).toThrow(/not valid JSON/);
    expect(() => parseLaunchSpec(JSON.stringify({ command: "" }))).toThrow(
      /non-empty string/
    );
    expect(() =>
      parseLaunchSpec(JSON.stringify({ command: "node", cwd: "" }))
    ).toThrow(/cwd/);
    expect(() =>
      parseLaunchSpec(JSON.stringify({ command: "node", shell: true }))
    ).toThrow(/unknown key "shell"/);
  });
});

describe("plugin vm shim: token comparison", () => {
  it("matches only the exact token, whatever the lengths", () => {
    expect(constantTimeEquals(TOKEN, TOKEN)).toBe(true);
    expect(constantTimeEquals(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(constantTimeEquals("", TOKEN)).toBe(false);
    expect(constantTimeEquals(TOKEN.slice(0, -1), TOKEN)).toBe(false);
  });
});

describe("plugin vm shim: handshake and calls", () => {
  it("mints a session on initialize and round-trips a tool call", async () => {
    const shim = await startShim();
    const { sessionId } = await openSession(shim);

    const response = await post(shim, toolCall("echo", { text: "hi" }), {
      sessionId,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(body.result.content[0]!.text).toMatch(/^echo:hi:\d+$/);
  });

  it("answers a notification with 202 and no body, leaving the session usable", async () => {
    const shim = await startShim();
    const { sessionId } = await openSession(shim);

    const notified = await post(
      shim,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { sessionId }
    );
    expect(notified.status).toBe(202);
    expect(await notified.text()).toBe("");

    const response = await post(shim, toolCall("echo", { text: "after" }), {
      sessionId,
    });
    const body = (await response.json()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(body.result.content[0]!.text).toContain("echo:after");
  });

  it("correlates concurrent responses by id, not by arrival order", async () => {
    const shim = await startShim();
    const { sessionId } = await openSession(shim);

    const slow = toolCall("slow", { text: "first", delayMs: 60 });
    const fast = toolCall("echo", { text: "second" });
    const [slowResponse, fastResponse] = await Promise.all([
      post(shim, slow, { sessionId }).then((r) => r.json()),
      post(shim, fast, { sessionId }).then((r) => r.json()),
    ]);

    expect((slowResponse as { id: number }).id).toBe(slow.id);
    expect(
      (slowResponse as { result: { content: Array<{ text: string }> } }).result
        .content[0]!.text
    ).toContain("slow:first");
    expect((fastResponse as { id: number }).id).toBe(fast.id);
    expect(
      (fastResponse as { result: { content: Array<{ text: string }> } }).result
        .content[0]!.text
    ).toContain("echo:second");
  });

  it("reassembles messages split across stdout chunk boundaries", async () => {
    const shim = await startShim({ childEnv: { FAKE_MCP_SPLIT_WRITES: "1" } });
    const { sessionId } = await openSession(shim);

    // Every response leaves the child in two writes cut at a random offset, so
    // a run of calls covers splits inside keys, values and the trailing brace.
    for (let index = 0; index < 12; index += 1) {
      const response = await post(
        shim,
        toolCall("echo", { text: `n${index}` }),
        { sessionId }
      );
      const body = (await response.json()) as {
        result: { content: Array<{ text: string }> };
      };
      expect(body.result.content[0]!.text).toContain(`echo:n${index}`);
    }
  });

  it("refuses a server-initiated request instead of parking the call forever", async () => {
    const shim = await startShim();
    const { sessionId } = await openSession(shim);

    const response = await post(shim, toolCall("provoke"), { sessionId });
    const body = (await response.json()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(body.result.content[0]!.text).toBe("host answered with -32601");
  });
});

describe("plugin vm shim: authentication", () => {
  it("rejects a missing bearer with a detail-free 401", async () => {
    const shim = await startShim();
    const response = await post(shim, initializeRequest(), { token: null });
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });

  it("rejects a wrong bearer", async () => {
    const shim = await startShim();
    const response = await post(shim, initializeRequest(), {
      token: `${TOKEN}x`,
    });
    expect(response.status).toBe(401);

    const shortToken = await post(shim, initializeRequest(), { token: "nope" });
    expect(shortToken.status).toBe(401);
  });

  it("serves /healthz without a bearer and reports the live session count", async () => {
    const shim = await startShim();
    const idle = await health(shim);
    expect(idle.status).toBe(200);
    expect(idle.body.ok).toBe(true);
    expect(idle.body.sessions).toBe(0);
    expect(JSON.stringify(idle.body)).not.toContain(TOKEN);

    await openSession(shim);
    expect((await health(shim)).body.sessions).toBe(1);
  });

  it("never writes the bearer token to its own stderr", async () => {
    const shim = await startShim();
    await openSession(shim);
    await post(shim, initializeRequest(), { token: "wrong-token-value" });
    expect(shim.stderr()).not.toContain(TOKEN);
  });

  it("rejects a request carrying an Origin header", async () => {
    const shim = await startShim();
    const response = await post(shim, initializeRequest(), {
      headers: { origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
  });
});

describe("plugin vm shim: session routing", () => {
  it("gives two sessions two separate children", async () => {
    const shim = await startShim();
    const first = await openSession(shim);
    const second = await openSession(shim);

    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.pid).not.toBe(first.pid);

    const firstEcho = await post(shim, toolCall("echo"), {
      sessionId: first.sessionId,
    });
    const secondEcho = await post(shim, toolCall("echo"), {
      sessionId: second.sessionId,
    });
    const firstBody = (await firstEcho.json()) as {
      result: { content: Array<{ text: string }> };
    };
    const secondBody = (await secondEcho.json()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(firstBody.result.content[0]!.text).toContain(`:${first.pid}`);
    expect(secondBody.result.content[0]!.text).toContain(`:${second.pid}`);
  });

  it("rejects a non-initialize request without a session header", async () => {
    const shim = await startShim();
    await openSession(shim);
    const response = await post(shim, toolCall("echo"));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("Mcp-Session-Id");
  });

  it("answers an unknown session id with 404 so the client re-initializes", async () => {
    const shim = await startShim();
    const response = await post(shim, toolCall("echo"), {
      sessionId: "00000000-0000-4000-8000-000000000000",
    });
    expect(response.status).toBe(404);
  });

  it("terminates the session's child on DELETE", async () => {
    const shim = await startShim();
    const { sessionId } = await openSession(shim);
    expect((await health(shim)).body.sessions).toBe(1);

    const deleted = await fetch(`${shim.url}/mcp`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "mcp-session-id": sessionId,
      },
    });
    expect(deleted.status).toBe(204);
    expect((await health(shim)).body.sessions).toBe(0);

    const afterDelete = await post(shim, toolCall("echo"), { sessionId });
    expect(afterDelete.status).toBe(404);
  });

  it("evicts the least recently used session past the cap", async () => {
    const shim = await startShim({ env: { MCPJAM_SHIM_MAX_SESSIONS: "2" } });
    const first = await openSession(shim);
    const second = await openSession(shim);

    // Touching the first makes the second the least recently used one.
    await post(shim, toolCall("echo"), { sessionId: first.sessionId });
    const third = await openSession(shim);

    expect((await health(shim)).body.sessions).toBe(2);
    expect(
      (await post(shim, toolCall("echo"), { sessionId: second.sessionId }))
        .status
    ).toBe(404);
    expect(
      (await post(shim, toolCall("echo"), { sessionId: first.sessionId }))
        .status
    ).toBe(200);
    expect(
      (await post(shim, toolCall("echo"), { sessionId: third.sessionId }))
        .status
    ).toBe(200);
  });

  it("reaps sessions that go idle past the ttl", async () => {
    const shim = await startShim({
      env: { MCPJAM_SHIM_SESSION_IDLE_MS: "300" },
    });
    const { sessionId } = await openSession(shim);

    await waitFor(
      async () => (await health(shim)).body.sessions === 0,
      "the idle session to be reaped"
    );
    expect((await post(shim, toolCall("echo"), { sessionId })).status).toBe(
      404
    );
  });
});

describe("plugin vm shim: failure handling", () => {
  it("fails the in-flight request and drops the session when the child exits", async () => {
    const shim = await startShim();
    const { sessionId } = await openSession(shim);

    const response = await post(shim, toolCall("boom"), { sessionId });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toContain("exited with code 3");

    await waitFor(
      async () => (await health(shim)).body.sessions === 0,
      "the crashed session to be dropped"
    );
    expect((await post(shim, toolCall("echo"), { sessionId })).status).toBe(
      404
    );

    // A fresh initialize must still succeed against a new child.
    const revived = await openSession(shim);
    expect(
      (await post(shim, toolCall("echo"), { sessionId: revived.sessionId }))
        .status
    ).toBe(200);
  });

  it("fails the handshake without advertising a session when the child cannot start", async () => {
    const shim = await startShim({
      command: "mcpjam-shim-no-such-command",
    });

    const response = await post(shim, initializeRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("mcp-session-id")).toBeNull();
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32000);
    expect((await health(shim)).body.sessions).toBe(0);
  });

  it("fails a request the child never answers rather than hanging", async () => {
    const shim = await startShim({
      env: { MCPJAM_SHIM_REQUEST_TIMEOUT_MS: "300" },
    });
    const { sessionId } = await openSession(shim);

    const response = await post(shim, toolCall("hang"), { sessionId });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32001);

    // The session survives a single unanswered request.
    expect((await health(shim)).body.sessions).toBe(1);
  });

  it("rejects malformed and unsupported request bodies", async () => {
    const shim = await startShim();

    const notJson = await fetch(`${shim.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: "{",
    });
    expect(notJson.status).toBe(400);
    expect(
      ((await notJson.json()) as { error: { code: number } }).error.code
    ).toBe(-32700);

    const batch = await post(shim, [initializeRequest()]);
    expect(batch.status).toBe(400);

    const response = await post(shim, { jsonrpc: "2.0", id: 1, result: {} });
    expect(response.status).toBe(400);
  });
});

describe("plugin vm shim: http surface", () => {
  it("answers GET /mcp with 405 rather than an error the client cannot classify", async () => {
    const shim = await startShim();
    const response = await fetch(`${shim.url}/mcp`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        accept: "text/event-stream",
      },
    });
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toContain("POST");
  });

  it("404s any other path", async () => {
    const shim = await startShim();
    expect((await fetch(`${shim.url}/`)).status).toBe(404);
    expect((await fetch(`${shim.url}/mcp/extra`)).status).toBe(404);
  });
});

describe("plugin vm shim: startup configuration", () => {
  async function runWithEnv(env: Record<string, string | undefined>) {
    const child = spawn(process.execPath, [SHIM_PATH], {
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderrText = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrText += chunk;
    });
    const code = await new Promise<number | null>((resolve) =>
      child.once("exit", (exitCode) => resolve(exitCode))
    );
    return { code, stderr: stderrText };
  }

  const validLaunch = JSON.stringify({
    command: process.execPath,
    args: [FIXTURE_PATH],
  });

  it("exits 2 with a clear message when the launch spec is malformed", async () => {
    const cases: Array<[string, string]> = [
      ["not json", "not valid JSON"],
      [JSON.stringify([]), "must be a JSON object"],
      [JSON.stringify({ args: [] }), "command must be a non-empty string"],
      [
        JSON.stringify({ command: "node", args: "x" }),
        "args must be an array of strings",
      ],
      [
        JSON.stringify({ command: "node", env: { A: 1 } }),
        'env["A"] must be a string',
      ],
      [
        JSON.stringify({ command: "node", workingDirectory: "/tmp" }),
        'unknown key "workingDirectory"',
      ],
    ];

    for (const [launch, expected] of cases) {
      const result = await runWithEnv({
        MCPJAM_SHIM_PORT: "0",
        MCPJAM_SHIM_TOKEN: TOKEN,
        MCPJAM_SHIM_LAUNCH: launch,
      });
      expect(result.code, `launch=${launch}`).toBe(2);
      expect(result.stderr, `launch=${launch}`).toContain(expected);
    }
  });

  it("exits 2 on a missing or too-short token, without echoing it", async () => {
    const missing = await runWithEnv({
      MCPJAM_SHIM_PORT: "0",
      MCPJAM_SHIM_TOKEN: undefined,
      MCPJAM_SHIM_LAUNCH: validLaunch,
    });
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("at least 32 characters");

    const tooShort = await runWithEnv({
      MCPJAM_SHIM_PORT: "0",
      MCPJAM_SHIM_TOKEN: "short-secret",
      MCPJAM_SHIM_LAUNCH: validLaunch,
    });
    expect(tooShort.code).toBe(2);
    expect(tooShort.stderr).not.toContain("short-secret");
  });

  it("exits 2 on an unusable port", async () => {
    const result = await runWithEnv({
      MCPJAM_SHIM_PORT: "70000",
      MCPJAM_SHIM_TOKEN: TOKEN,
      MCPJAM_SHIM_LAUNCH: validLaunch,
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("0-65535");
  });

  it("keeps its own MCPJAM_SHIM_ variables out of the child's environment", async () => {
    const shim = await startShim({ childEnv: { PLUGIN_ROOT: "/opt/plugin" } });
    const { sessionId } = await openSession(shim);

    const response = await post(
      shim,
      toolCall("env-keys", { prefix: "MCPJAM_SHIM_" }),
      { sessionId }
    );
    const body = (await response.json()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(JSON.parse(body.result.content[0]!.text)).toEqual([]);

    // The launch spec's own env still reaches the child.
    const spec = await post(
      shim,
      toolCall("env-keys", { prefix: "PLUGIN_ROOT" }),
      {
        sessionId,
      }
    );
    const specBody = (await spec.json()) as {
      result: { content: Array<{ text: string }> };
    };
    expect(JSON.parse(specBody.result.content[0]!.text)).toEqual([
      "PLUGIN_ROOT",
    ]);
  });
});
