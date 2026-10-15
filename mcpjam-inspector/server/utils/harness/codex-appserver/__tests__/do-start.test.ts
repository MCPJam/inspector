/**
 * `createCodexAppServer().doStart` against a fake sandbox session.
 *
 * Asserts what the adapter actually asks a sandbox to do — the commands, the
 * paths, the bound port and the environment — because every one of those was
 * wrong in a way only a real E2B session (or a local supervised session) would
 * have shown: the bridge was launched from a bootstrap directory resolved
 * against the agent's cwd instead of the framework's default working
 * directory, its state was written into that cwd (the user's checkout,
 * locally), and it bound a random port no provider had leased.
 */
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createCodexAppServer } from "../codex-appserver-harness.js";
import {
  CODEX_APPSERVER_BOOTSTRAP_DIR,
  getCodexAppServerBootstrap,
} from "../codex-appserver-bootstrap.js";
import { LOCAL_UNATTENDED_SANDBOX_POLICY } from "../shared/sandbox-policy.js";

const HOME = "/home/user";
const DEFAULT_DIR = `${HOME}/work`;
/** Deliberately NOT the default working directory: locally this is the
 *  user's checkout, reached as a subdirectory of session-owned state. */
const SESSION_WORK_DIR = `${DEFAULT_DIR}/project`;

type Spawned = { command: string; env: Record<string, string> };

const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const wss of servers.splice(0)) {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(() => resolve(undefined)));
  }
});

async function fakeBridge(): Promise<{
  port: number;
  received: Array<Record<string, unknown>>;
}> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(wss);
  await new Promise((resolve) => wss.once("listening", resolve));
  const received: Array<Record<string, unknown>> = [];
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      try {
        received.push(JSON.parse(String(data)));
      } catch {
        /* not a frame we care about */
      }
    });
  });
  return { port: (wss.address() as { port: number }).port, received };
}

function fakeSession(opts: { port: number; ports?: number[] }) {
  const runs: Array<{ command: string; workingDirectory?: string }> = [];
  const spawns: Spawned[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const restricted = {
    run: async (call: { command: string; workingDirectory?: string }) => {
      runs.push(call);
      if (call.command.includes("$HOME")) {
        return { exitCode: 0, stdout: HOME, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    readTextFile: async ({ path }: { path: string }) =>
      path.endsWith("/bridge-meta.json")
        ? JSON.stringify({ type: "codex", state: "waiting", port: opts.port })
        : null,
    writeTextFile: async (write: { path: string; content: string }) => {
      writes.push(write);
    },
    spawn: async (call: { command: string; env?: Record<string, string> }) => {
      spawns.push({ command: call.command, env: { ...(call.env ?? {}) } });
      return {
        stdout: new ReadableStream<Uint8Array>({ start() {} }),
        stderr: new ReadableStream<Uint8Array>({ start() {} }),
        kill: async () => {},
        wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      };
    },
  };
  return {
    runs,
    spawns,
    writes,
    session: {
      id: "sandbox-1",
      defaultWorkingDirectory: DEFAULT_DIR,
      ports: opts.ports ?? [opts.port],
      restricted: () => restricted,
      getPortEndpoint: async ({ port }: { port: number }) => ({
        url: `ws://127.0.0.1:${port}`,
      }),
    },
  };
}

const q = (path: string) => `'${path}'`;

describe("codex app-server doStart", () => {
  it("launches the bridge from the framework's bootstrap dir with session state outside the agent's cwd", async () => {
    const bridge = await fakeBridge();
    const box = fakeSession({ port: bridge.port });
    const harness = createCodexAppServer({
      auth: { CODEX_API_KEY: "placeholder", OPENAI_BASE_URL: "http://gw" },
    });
    const session = await harness.doStart({
      sessionId: "session-1",
      sessionWorkDir: SESSION_WORK_DIR,
      sandboxSession: box.session,
      permissionMode: "allow-edits",
    } as never);

    const bootstrapDir = `${DEFAULT_DIR}/${CODEX_APPSERVER_BOOTSTRAP_DIR}`;
    const sessionDataDir = `${DEFAULT_DIR}/.agent-runs/session-1`;
    const bridgeStateDir = `${sessionDataDir}/bridge`;

    expect(box.spawns).toHaveLength(1);
    expect(box.spawns[0]!.command).toBe(
      `node ${q(`${bootstrapDir}/bridge.mjs`)}` +
        ` --workdir ${q(SESSION_WORK_DIR)}` +
        ` --bridge-state-dir ${q(bridgeStateDir)}` +
        ` --session-data-dir ${q(sessionDataDir)}` +
        ` --bootstrap-dir ${q(bootstrapDir)}`,
    );
    // The LEASED port, not 0.
    expect(box.spawns[0]!.env.BRIDGE_WS_PORT).toBe(String(bridge.port));
    expect(box.spawns[0]!.env.CODEX_API_KEY).toBe("placeholder");
    expect(box.spawns[0]!.env.OPENAI_BASE_URL).toBe("http://gw");

    expect(box.runs.map((r) => r.command)).toContain(
      `mkdir -p ${q(SESSION_WORK_DIR)} ${q(bridgeStateDir)} ${q(sessionDataDir)}`,
    );
    // Nothing the adapter writes or creates lands in the agent's cwd: locally
    // that is the user's checkout.
    for (const write of box.writes) {
      expect(write.path.startsWith(`${SESSION_WORK_DIR}/`), write.path).toBe(false);
    }
    expect(
      JSON.stringify([box.runs, box.spawns]).includes(
        `${SESSION_WORK_DIR}/.harness-bootstrap`,
      ),
    ).toBe(false);

    await session.doDestroy();
  });

  it("refuses an approval continuation whose bridge is gone instead of re-driving the thread", async () => {
    // A port nothing listens on: the attach rung fails, and there is no
    // replayable log. A rerun here would let a fresh Codex proposal inherit
    // the stored "approved" by id.
    const probe = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => probe.once("listening", resolve));
    const deadPort = (probe.address() as { port: number }).port;
    await new Promise((resolve) => probe.close(() => resolve(undefined)));

    const box = fakeSession({ port: deadPort });
    const harness = createCodexAppServer({
      auth: { CODEX_API_KEY: "placeholder", OPENAI_BASE_URL: "http://gw" },
      startupTimeoutMs: 1_000,
    });
    await expect(
      harness.doStart({
        sessionId: "session-1",
        sessionWorkDir: SESSION_WORK_DIR,
        sandboxSession: box.session,
        permissionMode: "allow-reads",
        continueFrom: {
          data: {
            threadId: "thread-1",
            bridge: { port: deadPort, token: "stale-token", lastSeenEventId: 3 },
          },
        },
      } as never),
    ).rejects.toThrow(/no longer running/);
    expect(box.spawns).toHaveLength(0);
  });

  it("refuses a session with no leased port rather than binding a random one", async () => {
    const box = fakeSession({ port: 1, ports: [] });
    await expect(
      createCodexAppServer().doStart({
        sessionId: "s",
        sessionWorkDir: SESSION_WORK_DIR,
        sandboxSession: box.session,
      } as never),
    ).rejects.toThrow(/leased/);
    expect(box.spawns).toHaveLength(0);
  });

  it("sends the default model and the explicit sandbox policy on start", async () => {
    const bridge = await fakeBridge();
    const box = fakeSession({ port: bridge.port });
    const session = await createCodexAppServer({
      sandboxPolicy: LOCAL_UNATTENDED_SANDBOX_POLICY,
    }).doStart({
      sessionId: "s2",
      sessionWorkDir: SESSION_WORK_DIR,
      sandboxSession: box.session,
      permissionMode: "allow-all",
    } as never);
    const control = await session.doPromptTurn({
      prompt: "hi",
      tools: [],
      skills: [],
      emit: () => {},
    } as never);
    Promise.resolve(control.done).catch(() => {});
    await expect
      .poll(() => bridge.received.find((m) => m.type === "start"))
      .toBeDefined();
    const start = bridge.received.find((m) => m.type === "start")!;
    expect(start.model).toBe("gpt-5.5");
    expect(start.permissionMode).toBe("allow-all");
    expect(start.sandboxPolicy).toEqual({
      type: "workspaceWrite",
      writableRoots: [],
      networkAccess: false,
      excludeSlashTmp: true,
      excludeTmpdirEnvVar: false,
    });
    await session.doDestroy();
  });

  it("omits the sandbox policy for hosted turns", async () => {
    const bridge = await fakeBridge();
    const box = fakeSession({ port: bridge.port });
    const session = await createCodexAppServer({ model: "gpt-5.4" }).doStart({
      sessionId: "s3",
      sessionWorkDir: SESSION_WORK_DIR,
      sandboxSession: box.session,
      permissionMode: "allow-all",
    } as never);
    const control = await session.doPromptTurn({
      prompt: "hi",
      tools: [],
      skills: [],
      emit: () => {},
    } as never);
    Promise.resolve(control.done).catch(() => {});
    await expect
      .poll(() => bridge.received.find((m) => m.type === "start"))
      .toBeDefined();
    const start = bridge.received.find((m) => m.type === "start")!;
    expect(start.model).toBe("gpt-5.4");
    expect(start).not.toHaveProperty("sandboxPolicy");
    await session.doDestroy();
  });
});

describe("codex app-server bootstrap recipe", () => {
  it("runs commands relative to the bootstrap dir, as the framework executes them", () => {
    // `applyBootstrapRecipe` sets `workingDirectory` to the resolved bootstrap
    // dir, so a command that names the bootstrap dir again points at a nested
    // directory that does not exist.
    const recipe = getCodexAppServerBootstrap();
    expect(recipe.commands.map((c) => c.command)).toEqual([
      "pnpm install --frozen-lockfile --store-dir .pnpm-store",
      "node node_modules/@openai/codex/bin/codex.js --version",
    ]);
    for (const { command } of recipe.commands) {
      expect(command).not.toContain(CODEX_APPSERVER_BOOTSTRAP_DIR);
    }
  });

  it("ships the committed lockfile the frozen install needs", () => {
    const recipe = getCodexAppServerBootstrap();
    const names = recipe.files.map((f) =>
      f.path.slice(CODEX_APPSERVER_BOOTSTRAP_DIR.length + 1),
    );
    expect(names.sort()).toEqual(
      ["bridge.mjs", "host-tools-mcp.mjs", "package.json", "pnpm-lock.yaml"].sort(),
    );
    const lock = recipe.files.find((f) => f.path.endsWith("/pnpm-lock.yaml"))!
      .content;
    const pkg = JSON.parse(
      recipe.files.find((f) => f.path.endsWith("/package.json"))!.content,
    ) as { dependencies: Record<string, string> };
    // The lockfile describes exactly the pinned manifest.
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      const key = name.startsWith("@") ? `'${name}'` : name;
      expect(lock).toContain(`${key}:\n        specifier: ${version}`);
    }
    // And carries registry integrity for every platform binary package.
    for (const platform of [
      "darwin-arm64",
      "darwin-x64",
      "linux-x64",
      "linux-arm64",
      "win32-x64",
    ]) {
      expect(lock).toMatch(
        new RegExp(
          `'@openai/codex@${pkg.dependencies["@openai/codex"]}-${platform}':\\n    resolution: \\{integrity: sha512-`,
        ),
      );
    }
  });
});
