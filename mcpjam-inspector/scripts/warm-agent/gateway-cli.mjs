// The host owns the sandbox attachment and both leases. A persistent native
// CLI sees only the broker's placeholder environment, on an internal QA chat.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { attachBrokerPreparedSandbox } from "../../server/utils/computers/attach-sandbox.ts";
import { runGatewayBaseline } from "./gateway-baseline.ts";

const entry = fileURLToPath(new URL("./native-cli.mjs", import.meta.url));
let bundle;
async function workerSource() {
  bundle ??= build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  }).then((r) => r.outputFiles[0].text);
  return bundle;
}

export async function openGatewayCli(request, config) {
  const source = await workerSource();
  const path = "/tmp/mcpjam-cli-" + randomUUID() + ".mjs";
  if (!["claude-code", "codex"].includes(request.harnessId))
    throw Error("Use the native CLI from the development template.");
  const servers = {};
  for (const [name, server] of Object.entries(config.servers ?? {})) {
    // The CLI baseline measures only a synthetic, credential-free fixture.
    // Per-turn MCP or customer credentials must never be copied into a parked CLI.
    const url = new URL(server.url);
    if (
      server.type !== "http" ||
      Object.keys(server).some((k) => k !== "type" && k !== "url") ||
      url.href !== process.env.HARN24_QA_FIXTURE_URL ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw Error("Select the credential-free qualification fixture.");
    servers[name] = { type: "http", url: url.href };
  }
  const settings = {
    model: config.model,
    effort: config.effort,
    toolName: config.toolName,
    systemPrompt: config.systemPrompt,
    sandbox: config.sandbox,
    approvalPolicy: config.approvalPolicy,
    tools: config.tools,
    servers,
  };
  let modelRoute;
  let box,
    handle,
    sandboxId,
    partial = "",
    waiting,
    closed = false;
  const cancel = () =>
    waiting?.reject(Error("The native benchmark process exited."));
  function stdout(chunk) {
    partial += chunk;
    if (partial.length > 16_384) {
      cancel();
      return;
    }
    let pos;
    while ((pos = partial.indexOf("\n")) !== -1) {
      const line = partial.slice(0, pos);
      partial = partial.slice(pos + 1);
      try {
        waiting?.resolve(JSON.parse(line));
      } catch {
        cancel();
      }
    }
  }
  async function command(input, timeoutMs) {
    if (waiting) throw Error("A native benchmark message is already running.");
    const signal = AbortSignal.timeout(timeoutMs);
    const response = new Promise((resolve, reject) => {
      waiting = { resolve, reject };
    });
    const abort = () =>
      waiting?.reject(Error("Native benchmark deadline reached."));
    signal.addEventListener("abort", abort, { once: true });
    try {
      const [, result] = await Promise.all([
        handle.sendStdin(JSON.stringify(input) + "\n", { signal }),
        response,
      ]);
      return result;
    } finally {
      signal.removeEventListener("abort", abort);
      waiting = undefined;
    }
  }
  async function close() {
    if (closed) return;
    closed = true;
    if (!handle) return;
    try {
      await handle.sendStdin(JSON.stringify({ op: "close" }) + "\n", {
        signal: AbortSignal.timeout(2000),
      });
      await Promise.race([
        handle.wait(),
        delay(5000).then(() => {
          throw Error("CLI shutdown deadline reached.");
        }),
      ]);
    } catch {
      // Only the captured PID belongs to this qualification session.
      await handle.kill();
    } finally {
      await box.files.remove(path);
    }
  }
  async function turn(input) {
    if (closed) throw Error("The native benchmark session is closed.");
    const authorizedRequest = config.getBearer
      ? { ...request, bearer: await config.getBearer() }
      : request;
    return runGatewayBaseline(authorizedRequest, async (lease) => {
      if (handle && sandboxId !== lease.sandboxId)
        throw Error("The matched CLI sandbox was replaced.");
      const route = JSON.stringify(lease.environment);
      if (handle && route !== modelRoute)
        throw Error(
          "The native CLI model route changed between matched messages.",
        );
      if (!handle) {
        modelRoute = route;
        sandboxId = lease.sandboxId;
        box = await attachBrokerPreparedSandbox(sandboxId, {
          signal: lease.signal,
        });
        await box.files.write(path, source);
        handle = await box.commands.run("node " + path, {
          background: true,
          stdin: true,
          timeoutMs: 18 * 60_000,
          envs: lease.environment,
          onStdout: stdout,
        });
        void handle.wait().then(cancel, cancel);
        const ack = await command(
          { ...settings, op: "start", client: request.harnessId },
          35_000,
        );
        if (ack.ready !== true) throw Error("The native CLI did not start.");
      }
      const id = randomUUID();
      const submittedAt = Date.now();
      const result = await command(
        {
          op: "send",
          id,
          prompt: input.prompt,
          workload: input.workload,
          toolName: settings.toolName,
        },
        185_000,
      ).catch((error) => {
        throw Object.assign(error, { submittedAt });
      });
      if (result.id !== id)
        throw Error("The CLI sample belongs to another submission.");
      return { ...result, sandboxId };
    }).catch(async (error) => {
      await close();
      throw error;
    });
  }
  return { turn, close };
}
