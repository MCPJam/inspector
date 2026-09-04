/**
 * End-to-end: the REAL bundled bridge, the REAL codex binary, and a scripted
 * model.
 *
 * Everything else in this directory tests a piece. This tests the assembly —
 * the bridge spawns `codex app-server`, renders `CODEX_HOME`, drives a turn,
 * translates the items, pauses for approval and answers. It is the only test
 * that would catch a wiring mistake between two components that are each
 * individually correct.
 *
 * ENV-GATED and skipped by default, because it needs a codex binary (~258 MB)
 * that CI has no reason to download:
 *
 *   npx -y @openai/codex@0.149.1 --version   # populate the npx cache
 *   MCPJAM_CODEX_APPSERVER_LIVE=true \
 *   MCPJAM_CODEX_BIN=/path/to/codex \
 *   npx vitest run --project server server/utils/harness/codex-appserver/__tests__/live
 *
 * The MODEL is scripted (`.spike-codex-appserver/probe/fake-responses-server.mjs`),
 * so these assertions are deterministic and cost nothing. What is real is
 * everything between the bridge and the model: the JSON-RPC protocol, the
 * approval round trip, the sandboxed execution and the stream parts.
 *
 * PLATFORM NOTE: approval semantics depend on the sandbox implementation
 * (bubblewrap on Linux, seatbelt on macOS). Run this on Linux — what E2B runs —
 * before certifying Strict-mode behaviour.
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";

const LIVE = process.env.MCPJAM_CODEX_APPSERVER_LIVE === "true";
const CODEX_BIN = process.env.MCPJAM_CODEX_BIN;

type Frame = Record<string, unknown> & { type: string };
type FakeServer = { listen(): Promise<string>; close(): Promise<void> };

/**
 * Lay out the directory the bridge expects, around whatever codex binary the
 * runner supplied.
 *
 * A real directory rather than a test-only env seam in the bridge: this
 * exercises the SAME path resolution production uses
 * (`<bootstrap>/node_modules/@openai/codex/bin/codex.js`), so a change to that
 * layout fails here instead of inside a sandbox.
 */
async function prepareBootstrap(codexBin: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "mcpjam-codex-live-"));
  const codexPackage = join(dir, "node_modules", "@openai", "codex");
  mkdirSync(join(codexPackage, "bin"), { recursive: true });
  writeFileSync(
    join(codexPackage, "bin", "codex.js"),
    `import { spawn } from "node:child_process";
spawn(${JSON.stringify(codexBin)}, process.argv.slice(2), { stdio: "inherit" })
  .on("exit", (code) => process.exit(code ?? 0));
`,
  );
  writeFileSync(
    join(codexPackage, "package.json"),
    JSON.stringify({ name: "@openai/codex", type: "module", version: "0.0.0" }),
  );
  // `ws` is external to the bundle; link the copy this repo already has.
  symlinkSync(
    dirname(require.resolve("ws/package.json")),
    join(dir, "node_modules", "ws"),
    "dir",
  );
  // Loaded HERE, not imported at module scope. The bundle is gitignored and
  // produced by `pretest`, while `describe.skipIf` runs only AFTER module
  // evaluation — so a static import would fail collection on a direct vitest
  // run even though this suite is meant to skip.
  const { CODEX_APPSERVER_BRIDGE_SOURCE } =
    await import("../../bootstrap/generated/codex-appserver-bridge.bundled.js");
  writeFileSync(join(dir, "bridge.mjs"), CODEX_APPSERVER_BRIDGE_SOURCE);
  return dir;
}

async function startFakeModel(script: unknown[]): Promise<FakeServer> {
  const { createFakeResponsesServer } = (await import(
    /* @vite-ignore */ join(
      __dirname,
      "../../../../../../../.spike-codex-appserver/probe/fake-responses-server.mjs",
    )
  )) as {
    createFakeResponsesServer(options: {
      script: unknown[];
      strictToolNames?: boolean;
    }): FakeServer;
  };
  return createFakeResponsesServer({ script, strictToolNames: false });
}

type LiveTurn = {
  frames: Frame[];
  workdir: string;
  cleanup(): Promise<void>;
};

type TurnOptions = {
  script?: unknown[];
  prompt: string;
  approve: boolean;
  permissionMode: string;
};

type LiveSession = {
  workdir: string;
  bridgePid: number;
  /** Drive one turn and resolve with every frame the host saw for it. */
  runTurn(options: TurnOptions): Promise<Frame[]>;
  cleanup(): Promise<void>;
};

/**
 * Every descendant of `pid`, transitively, read straight from procfs.
 *
 * TRANSITIVE ON PURPOSE. The tree here is three deep — bridge, the `codex.js`
 * launcher the bootstrap installs, and the real codex binary under it — so a
 * direct-children walk names only the launcher. Killing that alone leaves a
 * ~258 MB codex orphaned for the rest of the test, and makes "kill Codex out
 * from under the bridge" only half true: the bridge does observe its own child
 * dying, but the process the test is nominally about is still running.
 */
function descendantsOf(pid: number): number[] {
  const byParent = new Map<number, number[]>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      // Field 4 is the ppid, but field 2 (comm) is an arbitrary string in
      // parentheses that may itself contain spaces or ')' — so parse after the
      // LAST ')' rather than splitting the whole line.
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const ppid = Number(fields[1]);
      byParent.set(ppid, [...(byParent.get(ppid) ?? []), Number(entry)]);
    } catch {
      /* the process exited while we were reading it */
    }
  }
  const out: number[] = [];
  const queue = [pid];
  while (queue.length) {
    for (const child of byParent.get(queue.shift()!) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** SIGKILL a whole subtree, deepest first so nothing is reparented away. */
function killTree(pid: number): void {
  for (const child of descendantsOf(pid).reverse()) {
    try {
      process.kill(child, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Bring up the real bridge and hold the socket open across turns. */
async function startLiveSession(script: unknown[]): Promise<LiveSession> {
  const fake = await startFakeModel(script);
  const baseUrl = await fake.listen();
  const bootstrapDir = await prepareBootstrap(CODEX_BIN!);
  const workdir = mkdtempSync(join(tmpdir(), "mcpjam-codex-live-work-"));
  const token = "live-test-token";
  let bridge: ChildProcess | undefined;
  let socket: WebSocket | undefined;

  const cleanup = async () => {
    socket?.close();
    // The whole subtree: killing the bridge alone leaves the codex binary to
    // notice its stdin closed and exit on its own, which is incidental rather
    // than guaranteed, and leaves the box holding it in the meantime.
    if (bridge?.pid) killTree(bridge.pid);
    bridge?.kill("SIGKILL");
    await fake.close();
  };

  try {
    const readyPort = await new Promise<number>((resolve, reject) => {
      bridge = spawn(
        process.execPath,
        [
          join(bootstrapDir, "bridge.mjs"),
          "--workdir",
          workdir,
          "--bridge-state-dir",
          join(workdir, ".bridge"),
          "--session-data-dir",
          join(workdir, ".session"),
          "--bootstrap-dir",
          bootstrapDir,
        ],
        {
          env: {
            ...process.env,
            BRIDGE_CHANNEL_TOKEN: token,
            BRIDGE_WS_PORT: "0",
            CODEX_API_KEY: "live-placeholder",
            OPENAI_BASE_URL: `${baseUrl}/v1`,
            MCPJAM_CODEX_APPSERVER_BRIDGE_AUTOSTART: "true",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const timer = setTimeout(
        () => reject(new Error("bridge never announced a port")),
        60_000,
      );
      bridge.stdout?.setEncoding("utf8");
      bridge.stdout?.on("data", (chunk: string) => {
        for (const line of chunk.split("\n")) {
          if (!line.trim()) continue;
          try {
            const frame = JSON.parse(line) as { type?: string; port?: number };
            if (frame.type === "bridge-ready" && frame.port) {
              clearTimeout(timer);
              resolve(frame.port);
            }
          } catch {
            /* not a frame */
          }
        }
      });
    });

    socket = new WebSocket(
      `ws://127.0.0.1:${readyPort}/?agent_bridge_token=${token}`,
    );
    await new Promise((resolve, reject) => {
      socket!.once("open", resolve);
      socket!.once("error", reject);
    });

    return {
      workdir,
      bridgePid: bridge!.pid!,
      cleanup,
      runTurn(options: TurnOptions) {
        const frames: Frame[] = [];
        const settled = new Promise<Frame[]>((resolve) => {
          const onMessage = (raw: unknown) => {
            const frame = JSON.parse(String(raw)) as Frame;
            frames.push(frame);
            if (frame.type === "tool-approval-request") {
              socket!.send(
                JSON.stringify({
                  type: "tool-approval-response",
                  approvalId: frame.approvalId,
                  approved: options.approve,
                }),
              );
            }
            // `error` as a terminator too: a turn that fails before it starts
            // never reaches `finish`, and a test asserting recovery has to see
            // that rather than time out on it.
            if (frame.type === "finish" || frame.type === "error") {
              socket!.off("message", onMessage);
              resolve(frames);
            }
          };
          socket!.on("message", onMessage);
        });
        socket!.send(
          JSON.stringify({
            type: "start",
            prompt: options.prompt,
            tools: [],
            permissionMode: options.permissionMode,
          }),
        );
        return settled;
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Run one scripted turn through the real bridge and collect every host frame. */
async function runLiveTurn(options: {
  script: unknown[];
  prompt: string;
  approve: boolean;
  permissionMode: string;
}): Promise<LiveTurn> {
  const session = await startLiveSession(options.script);
  try {
    const frames = await session.runTurn(options);
    return { frames, workdir: session.workdir, cleanup: session.cleanup };
  } catch (error) {
    await session.cleanup();
    throw error;
  }
}

describe.skipIf(!LIVE || !CODEX_BIN)("codex app-server, end to end", () => {
  it("runs a turn, pauses for approval, and reports the command", async () => {
    const turn = await runLiveTurn({
      script: [
        {
          functionCalls: [
            {
              name: "exec_command",
              arguments: { cmd: "echo live > live.txt" },
            },
          ],
        },
        { text: "Wrote live.txt." },
      ],
      prompt: "Create live.txt containing the word live.",
      approve: true,
      // The mode that maps to Codex's `untrusted` policy, which is what makes
      // it ask at all.
      permissionMode: "allow-reads",
    });
    try {
      const types = turn.frames.map((frame) => frame.type);
      expect(types).toContain("tool-call");
      expect(types).toContain("tool-approval-request");
      expect(types).toContain("tool-result");
      expect(types).toContain("finish");

      // The ordering guarantee, on the real wire this time: the approval
      // follows the tool call it refers to, because the framework throws
      // otherwise and Codex sends the approval first.
      expect(types.indexOf("tool-call")).toBeLessThan(
        types.indexOf("tool-approval-request"),
      );

      const call = turn.frames.find((frame) => frame.type === "tool-call")!;
      expect(call.toolName).toBe("bash");
      expect(call.nativeName).toBe("exec_command");

      const result = turn.frames.find((frame) => frame.type === "tool-result")!;
      expect((result.result as { status?: string }).status).toBe("completed");

      // ...and the command really ran.
      expect(existsSync(join(turn.workdir, "live.txt"))).toBe(true);

      const finish = turn.frames.find((frame) => frame.type === "finish")!;
      expect((finish.finishReason as { unified?: string }).unified).toBe(
        "stop",
      );
      expect(
        (finish.totalUsage as { inputTokens?: { total?: number } }).inputTokens
          ?.total,
      ).toBeGreaterThan(0);
    } finally {
      await turn.cleanup();
    }
  }, 180_000);

  it("runs NOTHING when the approval is denied", async () => {
    /*
     * The single-authority invariant, on the real wire: deny means zero
     * execution, not a warning and not a retry. This is the property the whole
     * transport exists for — an approval the runtime can route around is worse
     * than no approval at all, because the user believes they gated something.
     */
    const turn = await runLiveTurn({
      script: [
        {
          functionCalls: [
            {
              name: "exec_command",
              arguments: { cmd: "echo denied > denied.txt" },
            },
          ],
        },
        { text: "I was not allowed to create it." },
      ],
      prompt: "Create denied.txt.",
      approve: false,
      permissionMode: "allow-reads",
    });
    try {
      const result = turn.frames.find((frame) => frame.type === "tool-result")!;
      expect(result).toBeDefined();
      expect((result.result as { status?: string }).status).toBe("declined");
      expect(result.isError).toBe(true);
      // The file the command would have written does not exist.
      expect(existsSync(join(turn.workdir, "denied.txt"))).toBe(false);
      // ...and the turn still completes cleanly rather than erroring out.
      expect(turn.frames.map((frame) => frame.type)).toContain("finish");
    } finally {
      await turn.cleanup();
    }
  }, 180_000);

  it("rebuilds the runtime after Codex dies, instead of reusing a dead client", async () => {
    /*
     * THE REGRESSION. `ensureRuntime` returned early on `if (client)`, and
     * nothing invalidated that client when its process died — so one Codex
     * crash poisoned the session: every later turn with the same configuration
     * rejected instantly on `thread/start`, forever, with no way back short of
     * destroying the session.
     *
     * Only reproducible through the real assembly, because the bug lives in
     * the seam between a client that knows it is dead and a bridge that never
     * asked.
     */
    const session = await startLiveSession([
      { text: "First." },
      { text: "Second." },
    ]);
    try {
      const first = await session.runTurn({
        prompt: "Say something.",
        approve: true,
        permissionMode: "allow-all",
      });
      expect(first.map((frame) => frame.type)).toContain("finish");

      // Kill Codex out from under the bridge — the WHOLE subtree, because the
      // bridge's own child is only the `codex.js` launcher and the real binary
      // sits under it. The launcher's death is what the adapter observes as an
      // exit; taking the binary with it is what makes the scenario honest.
      const subtree = descendantsOf(session.bridgePid);
      expect(subtree.length).toBeGreaterThan(1);
      killTree(session.bridgePid);
      await vi.waitFor(
        () => {
          expect(descendantsOf(session.bridgePid)).toHaveLength(0);
        },
        { timeout: 15_000 },
      );

      // Same configuration, so the fingerprint matches and the old code would
      // have reused the corpse.
      const second = await session.runTurn({
        prompt: "Say something else.",
        approve: true,
        permissionMode: "allow-all",
      });
      const types = second.map((frame) => frame.type);
      expect(types).not.toContain("error");
      expect(types).toContain("finish");
      // ...and it really is a NEW process, not a resurrected handle.
      expect(descendantsOf(session.bridgePid).length).toBeGreaterThan(0);
    } finally {
      await session.cleanup();
    }
  }, 180_000);
});
