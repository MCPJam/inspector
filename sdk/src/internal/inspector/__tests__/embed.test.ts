import { createServer, type Server } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { embedInspector, type EmbeddedInspector } from "../embed.js";
import { choosePort, isPortFree } from "../ports.js";
import { holdInspector, inspectorHoldersDir, otherInspectorHolders } from "../holders.js";
import {
  clearInspectorSessionTokenCache,
  fetchInspectorSessionToken,
} from "../session-token.js";
import { inspectorAttachId } from "../attach-client.js";

/**
 * A stand-in for `bin/start.js`: listens on `--port`, confirms its own
 * session token, records attach requests, and writes its environment where
 * the test can read it.
 */
const FAKE_START = `
import { createServer } from "node:http";
import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const token = process.env.MCPJAM_SESSION_TOKEN;
const record = process.env.FAKE_RECORD;
writeFileSync(record + "." + process.pid + ".env.json", JSON.stringify({
  holders: process.env.MCPJAM_INSPECTOR_HOLDERS_DIR ?? null,
  orphanCheck: process.env.MCPJAM_INSPECTOR_DISABLE_ORPHAN_CHECK ?? null,
  suppressOpen: process.env.MCPJAM_INSPECTOR_SUPPRESS_AUTO_OPEN ?? null,
  tab: process.env.MCP_INITIAL_TAB ?? null,
  args: process.argv.slice(2),
}));
if (process.env.FAKE_EXIT) { console.error("port " + port + " is broken, token " + token); process.exit(3); }
// Like bin/start.js: the access link is printed unless auto open is suppressed.
if (process.env.MCPJAM_INSPECTOR_SUPPRESS_AUTO_OPEN !== "1") {
  console.log("Local http://localhost:" + port + "/#token=" + token);
}
const releasedAt = new Map();
const delay = Number(process.env.FAKE_RELEASE_DELAY_MS ?? 0);
const server = createServer((req, res) => {
  const authed = req.headers["x-mcp-session-auth"] === "Bearer " + token;
  if (!authed) { res.writeHead(401); res.end(); return; }
  if (req.url === "/api/session-token") { res.end(JSON.stringify({ ok: true })); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    appendFileSync(record + ".requests", req.method + " " + req.url + " " + body + "\\n");
    const id = req.url.split("/")[5];
    if (req.method === "DELETE") releasedAt.set(id, Date.now());
    if (req.method === "GET" && req.url.endsWith("/release")) {
      const at = releasedAt.get(id);
      const pending = at !== undefined && Date.now() - at < delay;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: pending ? "pending" : "done" }));
      return;
    }
    res.writeHead(req.method === "POST" ? 202 : 200, { "Content-Type": "application/json" });
    const parsed = body ? JSON.parse(body) : {};
    res.end(JSON.stringify({ attachId: parsed.attachId, status: "pending", serverName: parsed.server?.name }));
  });
});
// Losing a race for the port ends the process, as the real server does.
server.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  const dir = path.join(os.homedir(), ".mcpjam", "inspector");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(dir, port + ".json"), JSON.stringify({
    port, pid: process.pid, token, startedAt: new Date().toISOString(),
  }), { mode: 0o600 });
});
`;

let home: string;
let script: string;
let record: string;
const launched: EmbeddedInspector[] = [];
const servers: Server[] = [];

async function freePort(): Promise<number> {
  for (let port = 41_000 + Math.floor(Math.random() * 4_000); ; port += 1) {
    if (await isPortFree(port)) return port;
  }
}

function launch(overrides: Partial<Parameters<typeof embedInspector>[0]> = {}) {
  return embedInspector({
    start: { command: process.execPath, args: [script] },
    silent: true,
    env: { FAKE_RECORD: record },
    readyTimeoutMs: 10_000,
    ...overrides,
  }).then((inspector) => {
    launched.push(inspector);
    return inspector;
  });
}

function envFile(): string {
  const name = readdirSync(path.dirname(record)).find((f) => f.endsWith(".env.json"));
  return path.join(path.dirname(record), name!);
}

function requests(): string[] {
  const file = `${record}.requests`;
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "mcpjam-embed-"));
  // os.homedir() reads USERPROFILE on Windows and HOME elsewhere. Setting both
  // keeps this process and every MCPJam it starts out of the real profile.
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  script = path.join(home, "fake-start.mjs");
  record = path.join(home, "record");
  writeFileSync(script, FAKE_START);
  clearInspectorSessionTokenCache();
});

afterEach(async () => {
  await Promise.all(launched.splice(0).map((inspector) => inspector.stop()));
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("choosePort", () => {
  const takenUntil = (last: number) => async (port: number) => port > last;

  it("uses the preferred port when it is free", async () => {
    expect(await choosePort({ preferred: 6274, isFree: async () => true })).toBe(6274);
  });

  it("moves to the next free port", async () => {
    expect(await choosePort({ preferred: 6274, isFree: takenUntil(6276) })).toBe(6277);
  });

  it("fails with strictPort and names the port", async () => {
    await expect(
      choosePort({ preferred: 6274, strictPort: true, isFree: takenUntil(6274) }),
    ).rejects.toThrow("Port 6274 is in use");
  });

  it("fails when the next 20 ports are taken and names the range", async () => {
    await expect(
      choosePort({ preferred: 6274, isFree: async () => false }),
    ).rejects.toThrow("Ports 6274 to 6294 are all in use");
  });
});

describe("holdInspector", () => {
  it("writes one file per process and removes it with the last hold", () => {
    const releaseA = holdInspector(6274, { home, pid: 4242 })!;
    const releaseB = holdInspector(6274, { home, pid: 4242 })!;
    const dir = inspectorHoldersDir(6274, home);
    expect(readdirSync(dir)).toEqual(["4242.json"]);
    releaseA();
    expect(readdirSync(dir)).toEqual(["4242.json"]);
    releaseB();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("counts other live holders only", () => {
    const dir = inspectorHoldersDir(6274, home);
    mkdirSync(dir, { recursive: true });
    for (const pid of [1, 2, 3]) writeFileSync(path.join(dir, `${pid}.json`), "{}");
    expect(
      otherInspectorHolders(6274, { home, pid: 1, isAlive: (pid) => pid !== 3 }),
    ).toBe(1);
  });
});

describe("inspectorAttachId", () => {
  const http = { name: "a", url: "http://127.0.0.1:7102/mcp" };

  it("is stable for one process, port and server", () => {
    expect(inspectorAttachId(1, 6274, http)).toBe(inspectorAttachId(1, 6274, { ...http }));
    expect(inspectorAttachId(1, 6274, http)).not.toBe(inspectorAttachId(2, 6274, http));
    expect(inspectorAttachId(1, 6274, http)).not.toBe(inspectorAttachId(1, 6275, http));
  });

  it("tells two servers with the same name but different targets apart", () => {
    expect(inspectorAttachId(1, 6274, http)).not.toBe(
      inspectorAttachId(1, 6274, { name: "a", url: "http://127.0.0.1:9999/mcp" }),
    );
    const stdio = { name: "a", command: "node", args: ["server.js"] };
    expect(inspectorAttachId(1, 6274, stdio)).not.toBe(
      inspectorAttachId(1, 6274, { ...stdio, args: ["other.js"] }),
    );
    expect(inspectorAttachId(1, 6274, stdio)).not.toBe(inspectorAttachId(1, 6274, http));
  });

  it("ignores headers and environment, which do not make a different server", () => {
    expect(inspectorAttachId(1, 6274, { ...http, headers: { Authorization: "Bearer x" } })).toBe(
      inspectorAttachId(1, 6274, http),
    );
  });
});

describe("embedInspector", () => {
  it("starts MCPJam, attaches a server, and releases it on stop", async () => {
    const port = await freePort();
    const inspector = await launch({ port, tab: "playground" });

    expect(inspector.started).toBe(true);
    expect(inspector.port).toBe(port);
    expect(inspector.process).toBeDefined();
    expect(inspector.url).toMatch(
      new RegExp(`^http://localhost:${port}/#token=[A-Za-z0-9_-]+&tab=playground$`),
    );

    const state = await inspector.connect({ name: "billing-mcp", url: "http://127.0.0.1:7102/mcp" });
    expect(state).toMatchObject({ status: "pending", serverName: "billing-mcp" });
    const attachId = inspectorAttachId(process.pid, port, {
      name: "billing-mcp",
      url: "http://127.0.0.1:7102/mcp",
    });
    expect(requests()[0]).toContain(`POST /api/mcp/launcher/attach`);
    expect(JSON.parse(requests()[0].split(" ").slice(2).join(" "))).toEqual({
      attachId,
      server: { name: "billing-mcp", url: "http://127.0.0.1:7102/mcp" },
      pid: process.pid,
    });

    const child = inspector.process!;
    await inspector.stop();
    expect(requests()[1].trim()).toBe(`DELETE /api/mcp/launcher/attach/${attachId}`);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("keeps a session token the caller's environment sets", async () => {
    const port = await freePort();
    const token = "e".repeat(32);
    const inspector = await launch({
      port,
      env: { FAKE_RECORD: record, MCPJAM_SESSION_TOKEN: token },
    });
    expect(inspector.url).toBe(`http://localhost:${port}/#token=${token}`);
  });

  it("moves to the next free port when the preferred one is taken", async () => {
    const port = await freePort();
    const squatter = createServer((_req, res) => res.end());
    servers.push(squatter);
    await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", r));

    const inspector = await launch({ port });
    expect(inspector.port).toBeGreaterThan(port);
  });

  it("does not reuse another program on the port, even with reuse", async () => {
    const port = await freePort();
    const squatter = createServer((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    servers.push(squatter);
    await new Promise<void>((r) => squatter.listen(port, "127.0.0.1", r));

    const inspector = await launch({ port, reuse: true });
    expect(inspector.started).toBe(true);
    expect(inspector.port).not.toBe(port);
  });

  it("reuses this user's MCPJam on the preferred port and holds it", async () => {
    const port = await freePort();
    const token = "t".repeat(32);
    const running = createServer((req, res) => {
      res.writeHead(req.headers["x-mcp-session-auth"] === `Bearer ${token}` ? 200 : 401);
      res.end(JSON.stringify({ ok: true }));
    });
    servers.push(running);
    await new Promise<void>((r) => running.listen(port, "127.0.0.1", r));
    const discovery = path.join(home, ".mcpjam", "inspector");
    mkdirSync(discovery, { recursive: true, mode: 0o700 });
    writeFileSync(
      path.join(discovery, `${port}.json`),
      JSON.stringify({ port, pid: process.pid, token, startedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );

    const inspector = await launch({ port, reuse: true });
    expect(inspector.started).toBe(false);
    expect(inspector.process).toBeUndefined();
    expect(inspector.url).toBe(`http://localhost:${port}/#token=${token}`);
    expect(readdirSync(inspectorHoldersDir(port))).toEqual([`${process.pid}.json`]);

    await inspector.stop();
    expect(readdirSync(inspectorHoldersDir(port))).toEqual([]);
  });

  it("starts a shared MCPJam with a watchdog when reuse finds none", async () => {
    const port = await freePort();
    const inspector = await launch({ port, reuse: true });

    expect(inspector.started).toBe(true);
    const env = JSON.parse(readFileSync(envFile(), "utf8"));
    expect(env).toMatchObject({
      holders: inspectorHoldersDir(port),
      orphanCheck: "1",
    });
    expect(readdirSync(inspectorHoldersDir(port))).toEqual([`${process.pid}.json`]);
  });

  it("leaves a shared MCPJam up while another dev command holds it", async () => {
    const port = await freePort();
    const inspector = await launch({ port, reuse: true });
    const other = path.join(inspectorHoldersDir(port), `${process.ppid}.json`);
    writeFileSync(other, JSON.stringify({ pid: process.ppid }));

    const child = inspector.process!;
    await inspector.stop();
    expect(child.exitCode).toBeNull();
    child.kill("SIGKILL");
  });

  it("rejects with MCPJam's output, token redacted, when it exits early", async () => {
    const port = await freePort();
    const failing = launch({ port, env: { FAKE_RECORD: record, FAKE_EXIT: "1" } });
    await expect(failing).rejects.toThrow(/exited before it was ready \(code 3\)/);
    await expect(failing).rejects.toThrow(/token <session token>/);
  });
});

describe("a shared MCPJam's log and lifecycle", () => {
  it("never writes the session token to the shared log, and keeps it owner-only", async () => {
    const port = await freePort();
    const log = path.join(home, ".mcpjam", "inspector", `${port}.log`);
    // A log left by an earlier run keeps its looser mode unless it is reset.
    mkdirSync(path.dirname(log), { recursive: true });
    writeFileSync(log, "from an earlier run\n", { mode: 0o644 });

    const inspector = await launch({ port, reuse: true });
    const token = new URL(inspector.url).hash.match(/token=([^&]+)/)![1];

    const env = JSON.parse(readFileSync(envFile(), "utf8"));
    expect(env.suppressOpen).toBe("1");
    expect(readFileSync(log, "utf8")).not.toContain(token);
    expect(readFileSync(log, "utf8")).toContain("from an earlier run");
    if (process.platform !== "win32") {
      expect(statSync(log).mode & 0o777).toBe(0o600);
    }
  });

  it("lets start.js open an unshared MCPJam itself, and passes --no-open only when asked not to", async () => {
    const port = await freePort();
    await launch({ port, open: true });
    expect(JSON.parse(readFileSync(envFile(), "utf8")).args).not.toContain("--no-open");
  });

  it("passes --no-open to an unshared MCPJam by default", async () => {
    const port = await freePort();
    await launch({ port });
    expect(JSON.parse(readFileSync(envFile(), "utf8")).args).toContain("--no-open");
  });

  it("waits for a tab to undo this launch's server before it stops MCPJam", async () => {
    const port = await freePort();
    const inspector = await launch({
      port,
      env: { FAKE_RECORD: record, FAKE_RELEASE_DELAY_MS: "900" },
      releaseWaitMs: 5_000,
    });
    await inspector.connect({ name: "billing-mcp", url: "http://127.0.0.1:7102/mcp" });

    const child = inspector.process!;
    const startedAt = Date.now();
    await inspector.stop();

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(800);
    expect(requests().filter((line) => line.startsWith("GET")).length).toBeGreaterThan(1);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("gives up waiting after releaseWaitMs, so a missing tab cannot hold stop() forever", async () => {
    const port = await freePort();
    const inspector = await launch({
      port,
      env: { FAKE_RECORD: record, FAKE_RELEASE_DELAY_MS: "60000" },
      releaseWaitMs: 600,
    });
    await inspector.connect({ name: "billing-mcp", url: "http://127.0.0.1:7102/mcp" });

    const startedAt = Date.now();
    await inspector.stop();
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it("does not wait when MCPJam stays up for another dev command", async () => {
    const port = await freePort();
    const inspector = await launch({
      port,
      reuse: true,
      env: { FAKE_RECORD: record, FAKE_RELEASE_DELAY_MS: "60000" },
      releaseWaitMs: 5_000,
    });
    await inspector.connect({ name: "billing-mcp", url: "http://127.0.0.1:7102/mcp" });
    writeFileSync(
      path.join(inspectorHoldersDir(port), `${process.ppid}.json`),
      JSON.stringify({ pid: process.ppid }),
    );

    const startedAt = Date.now();
    await inspector.stop();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    inspector.process!.kill("SIGKILL");
  });

  it("keeps MCPJam up while another launch in this process still holds it", async () => {
    const port = await freePort();
    const first = await launch({ port, reuse: true });
    const second = await launch({ port, reuse: true });
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);

    const child = first.process!;
    await first.stop();
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();

    await second.stop();
    child.kill("SIGKILL");
  });

  // Let child readiness and the losing launch's reuse polling finish before
  // Vitest times out, so a failed launch reports its own startup error.
  it("two dev commands that start together end up on one MCPJam", async () => {
    const port = await freePort();
    const launches = [
      launch({ port, reuse: true, startRaceWaitMs: 3_000 }),
      launch({ port, reuse: true, startRaceWaitMs: 3_000 }),
    ];

    try {
      const [a, b] = await Promise.all(launches);
      expect(a.port).toBe(port);
      expect(b.port).toBe(port);
      expect([a.started, b.started].sort()).toEqual([false, true]);
    } finally {
      await Promise.allSettled(launches);
      for (const inspector of launched) inspector.process?.kill("SIGKILL");
    }
  }, 20_000);

  it("starts a new MCPJam when the one it last saw is gone, instead of trusting a cached token", async () => {
    const port = await freePort();
    const token = "c".repeat(32);
    const discovery = path.join(home, ".mcpjam", "inspector", `${port}.json`);
    mkdirSync(path.dirname(discovery), { recursive: true, mode: 0o700 });
    writeFileSync(
      discovery,
      JSON.stringify({ port, pid: process.pid, token, startedAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
    const gone = createServer((_req, res) => res.end(JSON.stringify({ ok: true })));
    await new Promise<void>((r) => gone.listen(port, "127.0.0.1", r));
    // Prime the 5 minute token cache, then take the MCPJam away.
    await fetchInspectorSessionToken(`http://127.0.0.1:${port}`);
    await new Promise((r) => gone.close(r));
    rmSync(discovery);

    const inspector = await launch({ port, reuse: true });
    expect(inspector.started).toBe(true);
  });

  it("warns once, and still launches, when the holders directory cannot be written", async () => {
    const port = await freePort();
    const dir = inspectorHoldersDir(port);
    mkdirSync(path.dirname(dir), { recursive: true });
    writeFileSync(dir, "a file where the directory should be");

    const warnings: string[] = [];
    const inspector = await launch({
      port,
      reuse: true,
      onWarning: (message) => warnings.push(message),
    });

    expect(inspector.started).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Could not share MCPJam.*not writable/);
  });
});

describe("holder files", () => {
  it("deletes the files of processes that are gone, when holding and when counting", () => {
    const dir = inspectorHoldersDir(6274, home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "111.json"), "{}");
    writeFileSync(path.join(dir, "222.json"), "{}");

    const alive = (pid: number) => pid === 222 || pid === 4242;
    const release = holdInspector(6274, { home, pid: 4242, isAlive: alive })!;
    expect(readdirSync(dir).sort()).toEqual(["222.json", "4242.json"]);

    writeFileSync(path.join(dir, "333.json"), "{}");
    expect(otherInspectorHolders(6274, { home, pid: 4242, isAlive: alive })).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(["222.json", "4242.json"]);
    release();
  });

  it("reports whether the process still holds the port after a release", () => {
    const first = holdInspector(6274, { home, pid: 4242 })!;
    const second = holdInspector(6274, { home, pid: 4242 })!;
    expect(first()).toBe(true);
    expect(second()).toBe(false);
    expect(second()).toBe(false);
  });
});

describe("isPortFree", () => {
  it("treats a listener on ::1 as taking the port", async () => {
    const port = await freePort();
    const server = createServer((_req, res) => res.end());
    servers.push(server);
    const listening = await new Promise<boolean>((resolve) => {
      server.once("error", () => resolve(false));
      server.listen(port, "::1", () => resolve(true));
    });
    // A machine without IPv6 has no such listener to find.
    if (!listening) return;
    expect(await isPortFree(port)).toBe(false);
  });
});
