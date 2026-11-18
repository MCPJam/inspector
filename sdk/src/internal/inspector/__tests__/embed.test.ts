import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { embedInspector, type EmbeddedInspector } from "../embed.js";
import { choosePort, isPortFree } from "../ports.js";
import { holdInspector, inspectorHoldersDir, otherInspectorHolders } from "../holders.js";
import { clearInspectorSessionTokenCache } from "../session-token.js";
import { inspectorAttachId } from "../attach-client.js";

/**
 * A stand-in for `bin/start.js`: listens on `--port`, confirms its own
 * session token, records attach requests, and writes its environment where
 * the test can read it.
 */
const FAKE_START = `
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const token = process.env.MCPJAM_SESSION_TOKEN;
const record = process.env.FAKE_RECORD;
writeFileSync(record + ".env.json", JSON.stringify({
  holders: process.env.MCPJAM_INSPECTOR_HOLDERS_DIR ?? null,
  orphanCheck: process.env.MCPJAM_INSPECTOR_DISABLE_ORPHAN_CHECK ?? null,
  tab: process.env.MCP_INITIAL_TAB ?? null,
}));
if (process.env.FAKE_EXIT) { console.error("port " + port + " is broken, token " + token); process.exit(3); }
createServer((req, res) => {
  const authed = req.headers["x-mcp-session-auth"] === "Bearer " + token;
  if (!authed) { res.writeHead(401); res.end(); return; }
  if (req.url === "/api/session-token") { res.end(JSON.stringify({ ok: true })); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    appendFileSync(record + ".requests", req.method + " " + req.url + " " + body + "\\n");
    res.writeHead(req.method === "POST" ? 202 : 200, { "Content-Type": "application/json" });
    const parsed = body ? JSON.parse(body) : {};
    res.end(JSON.stringify({ attachId: parsed.attachId, status: "pending", serverName: parsed.server?.name }));
  });
}).listen(port, "127.0.0.1");
`;

let home: string;
let previousHome: string | undefined;
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

function requests(): string[] {
  const file = `${record}.requests`;
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), "mcpjam-embed-"));
  previousHome = process.env.HOME;
  process.env.HOME = home;
  script = path.join(home, "fake-start.mjs");
  record = path.join(home, "record");
  writeFileSync(script, FAKE_START);
  clearInspectorSessionTokenCache();
});

afterEach(async () => {
  await Promise.all(launched.splice(0).map((inspector) => inspector.stop()));
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  process.env.HOME = previousHome;
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
  it("is stable for one process, port and server", () => {
    expect(inspectorAttachId(1, 6274, "a")).toBe(inspectorAttachId(1, 6274, "a"));
    expect(inspectorAttachId(1, 6274, "a")).not.toBe(inspectorAttachId(2, 6274, "a"));
    expect(inspectorAttachId(1, 6274, "a")).not.toBe(inspectorAttachId(1, 6275, "a"));
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
    const attachId = inspectorAttachId(process.pid, port, "billing-mcp");
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
    const env = JSON.parse(readFileSync(`${record}.env.json`, "utf8"));
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
