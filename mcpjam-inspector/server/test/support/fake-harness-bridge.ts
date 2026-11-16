/**
 * A real harness adapter, driven to the point where it writes a turn's skills:
 * its `doStart` against a fake box, then its `doPromptTurn`. The bridge is a
 * WebSocket server in this process, and the box records what the adapter
 * writes, runs and spawns.
 *
 * The stable adapters write skills at PROMPT time, re-synced every turn, so
 * reaching the write takes a live session: a `bridge-meta.json` read that
 * reports the bridge ready, and a spawn that returns an inert process. Skills
 * land before the adapter sends its start message, so the fake bridge never
 * answers anything beyond the greeting some adapters wait for.
 */
import { WebSocketServer } from "ws";
import { BOX_HOME } from "./fake-skill-box.js";

export type BoxWrite = { path: string; content: string };
export type BridgeSpawn = { command: string; env?: Record<string, string> };

/** An adapter's `skills` param, supporting files included. */
export type PromptSkills = Array<{
  name: string;
  description: string;
  content: string;
  files?: Array<{ path: string; content: string }>;
}>;

/** The part of a harness these drives use. */
export interface DrivenHarness {
  harnessId: string;
  doStart: (opts: unknown) => Promise<{
    doPromptTurn: (opts: unknown) => Promise<{ done: Promise<unknown> }>;
    doDestroy: () => Promise<unknown>;
  }>;
}

/** Adapters whose connect waits for the bridge's `bridge-hello`; Codex opens
 *  the socket and moves on. */
const GREETING_BRIDGES = new Set(["claude-code", "opencode"]);

/**
 * The sandbox session surface MCPJam's `e2b-sandbox-provider` exposes.
 * `bridge-meta.json` always reads as "waiting", so the adapter's readiness
 * poll resolves at once, and `getPortEndpoint` points its bridge WebSocket at
 * the test server.
 */
function fakeBridgeBox(bridgeType: string, port: number) {
  const writes: BoxWrite[] = [];
  const commands: string[] = [];
  const spawns: BridgeSpawn[] = [];
  const restricted = {
    run: async ({ command }: { command: string }) => {
      commands.push(command);
      // The adapters resolve the box's real $HOME before choosing a skills root.
      if (command.includes("$HOME")) {
        return { exitCode: 0, stdout: BOX_HOME, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    readTextFile: async ({ path }: { path: string }) =>
      path.endsWith("/bridge-meta.json")
        ? JSON.stringify({ type: bridgeType, state: "waiting", port })
        : null,
    writeTextFile: async (write: BoxWrite) => {
      writes.push(write);
    },
    // An inert bridge process: the real bridge is the test's WebSocket server,
    // so the handle only has to satisfy stream readers and teardown.
    spawn: async ({ command, env }: BridgeSpawn) => {
      spawns.push({ command, ...(env ? { env } : {}) });
      return {
        stdout: new ReadableStream<Uint8Array>({ start() {} }),
        stderr: new ReadableStream<Uint8Array>({ start() {} }),
        kill: async () => {},
        wait: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      };
    },
  };
  return {
    writes,
    commands,
    spawns,
    session: {
      id: "sandbox-1",
      defaultWorkingDirectory: `${BOX_HOME}/work`,
      ports: [port],
      restricted: () => restricted,
      getPortEndpoint: async () => ({ url: `ws://127.0.0.1:${port}` }),
    },
  };
}

/**
 * Drive the adapter's real `doStart` to a live session, then its real
 * `doPromptTurn`, the point where the stable adapters write skills, and
 * capture everything that reached the box. The turn itself is never answered.
 */
export async function promptWithSkills(
  harness: DrivenHarness,
  skills: PromptSkills,
): Promise<{
  writes: BoxWrite[];
  commands: string[];
  spawns: BridgeSpawn[];
  error: unknown;
}> {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => wss.once("listening", resolve));
  const port = (wss.address() as { port: number }).port;
  wss.on("connection", (socket) => {
    if (GREETING_BRIDGES.has(harness.harnessId)) {
      socket.send(JSON.stringify({ type: "bridge-hello" }));
    }
  });

  const box = fakeBridgeBox(harness.harnessId, port);
  let session: Awaited<ReturnType<DrivenHarness["doStart"]>> | undefined;
  let error: unknown;
  try {
    session = await harness.doStart({
      sessionId: "session-1",
      sessionWorkDir: `${BOX_HOME}/work`,
      sandboxSession: box.session,
      permissionMode: "allow-all",
    });
    const control = await session.doPromptTurn({
      prompt: "hello",
      tools: [],
      skills,
      emit: () => {},
    });
    // The fake bridge never finishes the turn; teardown rejects `done`.
    control.done.catch(() => {});
  } catch (err) {
    error = err;
  } finally {
    try {
      await session?.doDestroy();
    } catch {
      /* teardown only */
    }
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(() => resolve(undefined)));
  }
  return {
    writes: box.writes,
    commands: box.commands,
    spawns: box.spawns,
    error,
  };
}

/** Skill-content writes under a skills folder, excluding the shared writer's
 *  own `.ai-sdk-harness-skills.json` sync manifest (an adapter implementation
 *  detail, not a delivered skill). */
export function skillWrites(
  writes: BoxWrite[],
  skillsBaseDir: string,
): BoxWrite[] {
  return writes.filter(
    (w) =>
      w.path.startsWith(`${skillsBaseDir}/`) &&
      !w.path.includes("/.ai-sdk-harness-skills.json"),
  );
}
