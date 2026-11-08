/**
 * The hosted Claude Code bridge, run for real against a scripted agent SDK.
 *
 * A background agent's report is a turn the CLI starts itself, so its `result`
 * answers no message the bridge sent (`origin.kind` is `task-notification`),
 * and the vendor bridge skips such a result. Once the drain holds the turn open
 * for that report, its result must end the turn: skipped, nothing else ends it
 * before the drain's cap, ten minutes later.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createHostedClaudeCodeHarness } from "../claude-code-typed-errors.js";

const require = createRequire(import.meta.url);

/** The installed package that `entry` resolves into. */
function packageRoot(name: string, entry: string): string {
  let dir = dirname(require.resolve(entry));
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest) && JSON.parse(readFileSync(manifest, "utf8")).name === name) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error(`No package root for ${name}`);
    dir = up;
  }
}

// What the CLI streams for a prompt that starts a background agent, answers,
// and then reports the agent's result in a turn of its own.
const SCRIPTED_SDK = `
export function query({ prompt }) {
  let stop;
  const stopped = new Promise((resolve) => (stop = resolve));
  const input = prompt[Symbol.asyncIterator]();
  async function* messages() {
    const uuid = (await input.next()).value?.uuid;
    yield { type: "system", subtype: "init", session_id: "s1" };
    yield { type: "command_lifecycle", command_uuid: uuid, state: "started" };
    yield { type: "system", subtype: "task_started", task_id: "a1", task_type: "local_agent", is_backgrounded: true, tool_use_id: "toolu_a1", description: "plan" };
    yield { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a1", task_type: "local_agent", description: "plan" }] };
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "I started the plan." }] } };
    yield { type: "result", subtype: "success", is_error: false, result: "I started the plan.", user_message_uuid: uuid };
    yield { type: "command_lifecycle", command_uuid: uuid, state: "completed" };
    yield { type: "system", subtype: "task_notification", task_id: "a1", tool_use_id: "toolu_a1", status: "completed", summary: "PLAN" };
    yield { type: "system", subtype: "background_tasks_changed", tasks: [] };
    yield { type: "system", subtype: "init", session_id: "s1" };
    yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: "Here is the plan." }] } };
    yield { type: "result", subtype: "success", is_error: false, result: "Here is the plan.", user_message_uuid: "cli-notification", origin: { kind: "task-notification" } };
    await stopped;
  }
  const gen = messages();
  return Object.assign(gen, {
    interrupt: async () => stop(),
    stopTask: async () => {},
    return: async (value) => { stop(); return { done: true, value }; },
  });
}
`;

let child: ChildProcess | undefined;
let socket: WebSocket | undefined;
let dir: string | undefined;
afterEach(async () => {
  socket?.terminate();
  child?.kill("SIGKILL");
  if (dir) await rm(dir, { recursive: true, force: true });
  child = socket = dir = undefined;
});

/** Start the patched bridge on the scripted SDK; resolves its port. */
async function startBridge(): Promise<number> {
  const bootstrap = await createHostedClaudeCodeHarness().getBootstrap?.();
  const bridge = bootstrap?.files.find((file) => file.path.endsWith("/bridge.mjs"))?.content;
  if (!bridge) throw new Error("The hosted bootstrap has no bridge");
  dir = await mkdtemp(join(tmpdir(), "claude-followup-"));
  const modules = join(dir, "node_modules");
  const sdk = join(modules, "@anthropic-ai", "claude-agent-sdk");
  await mkdir(sdk, { recursive: true });
  await mkdir(join(modules, "@modelcontextprotocol"), { recursive: true });
  await symlink(packageRoot("ws", "ws"), join(modules, "ws"));
  await symlink(packageRoot("zod", "zod"), join(modules, "zod"));
  await symlink(
    packageRoot("@modelcontextprotocol/sdk", "@modelcontextprotocol/sdk/server/mcp.js"),
    join(modules, "@modelcontextprotocol", "sdk"),
  );
  await writeFile(
    join(sdk, "package.json"),
    JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", type: "module", exports: { ".": "./sdk.mjs" } }),
  );
  await writeFile(join(sdk, "sdk.mjs"), SCRIPTED_SDK);
  await writeFile(join(dir, "bridge.mjs"), bridge);
  const state = join(dir, "state");
  child = spawn(
    process.execPath,
    [join(dir, "bridge.mjs"), "--workdir", dir, "--bridge-state-dir", state],
    { env: { ...process.env, BRIDGE_WS_PORT: "0", BRIDGE_CHANNEL_TOKEN: "test-token" }, stdio: "ignore" },
  );
  for (let attempt = 0; attempt < 200; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    try {
      const { port } = JSON.parse(await readFile(join(state, "bridge-meta.json"), "utf8"));
      if (port > 0) return port;
    } catch {
      // Not written yet: the bridge is still binding its port.
    }
  }
  throw new Error("The bridge never reported its port");
}

describe.runIf(process.platform !== "win32")("a background agent's follow-up on the hosted bridge", () => {
  it("ends the turn with its result instead of waiting for the drain's cap", async () => {
    const port = await startBridge();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?agent_bridge_token=test-token`);
    socket = ws;
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const events: Array<{ type: string; delta?: string; rawValue?: { reason?: string } }> = [];
    const outcome = new Promise<string>((resolve) => {
      ws.on("message", (raw) => {
        const event = JSON.parse(String(raw));
        events.push(event);
        if (event.type === "finish" || event.type === "error") resolve(event.type);
      });
      setTimeout(() => resolve("still open after 10 s"), 10_000).unref();
    });
    ws.send(JSON.stringify({ type: "start", prompt: "plan it" }));

    expect(await outcome).toBe("finish");
    const deltas = events.filter((event) => event.type === "text-delta").map((event) => event.delta);
    expect(deltas).toEqual(["I started the plan.", "Here is the plan."]);
    expect(events.some((event) => event.rawValue?.reason === "follow-up")).toBe(true);
  }, 30_000);
});
