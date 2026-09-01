// Run the WS0 preflight gates (P1-P4) against a real `codex app-server` binary
// and the scripted fake Responses API. No E2B, no model spend, no network.
//
//   node probe/run-gates.mjs --codex /path/to/codex [--gate P2] [--out RESULTS.md]
//
// If --codex is omitted the pinned version is fetched with npx.
//
// Every gate writes its raw frames to artifacts/<gate>.ndjson so a claim in
// RESULTS.md can be checked against the wire rather than taken on trust.
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { createFakeResponsesServer } from "./fake-responses-server.mjs";
import { spawnAppServer, initialize } from "./app-server-client.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = join(HERE, "..", "artifacts");
const PINNED_CODEX = "0.149.1";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

function resolveCodex() {
  const explicit = arg("codex");
  if (explicit) return explicit;
  process.stdout.write(`fetching @openai/codex@${PINNED_CODEX} via npx...\n`);
  const dir = mkdtempSync(join(tmpdir(), "codex-bin-"));
  execFileSync("npx", ["-y", `@openai/codex@${PINNED_CODEX}`, "--version"], {
    stdio: "inherit",
  });
  rmSync(dir, { recursive: true, force: true });
  return "codex";
}

/** A prepared CODEX_HOME: the model provider points at the fake server. */
function writeCodexHome({ baseUrl, mcpServers = {}, extra = "" }) {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  const lines = [
    'model = "gpt-5-nano"',
    'model_provider = "probe"',
    'model_reasoning_summary = "detailed"',
    "",
    "[model_providers.probe]",
    'name = "probe"',
    `base_url = ${JSON.stringify(`${baseUrl}/v1`)}`,
    'env_key = "PROBE_API_KEY"',
    'wire_api = "responses"',
  ];
  for (const [name, config] of Object.entries(mcpServers)) {
    lines.push("", `[mcp_servers.${name}]`);
    lines.push(`command = ${JSON.stringify(config.command)}`);
    lines.push(
      `args = [${config.args.map((a) => JSON.stringify(a)).join(", ")}]`
    );
    if (config.env) {
      lines.push("", `[mcp_servers.${name}.env]`);
      for (const [key, value] of Object.entries(config.env)) {
        lines.push(`${key} = ${JSON.stringify(value)}`);
      }
    }
  }
  if (extra) lines.push("", extra);
  writeFileSync(join(home, "config.toml"), `${lines.join("\n")}\n`);
  return home;
}

/** One scripted turn end-to-end; returns everything observed. */
async function runTurn({
  codexBin,
  script,
  threadParams = {},
  prompt = "Do the thing.",
  mcpServers,
  gate,
  onServerRequest,
  afterTurnStart,
  extraConfig,
}) {
  mkdirSync(ARTIFACTS, { recursive: true });
  const fake = createFakeResponsesServer({
    script,
    logPath: join(ARTIFACTS, `${gate}.http.ndjson`),
    strictToolNames: false,
  });
  const baseUrl = await fake.listen();
  const home = writeCodexHome({ baseUrl, mcpServers, extra: extraConfig });
  const cwd = mkdtempSync(join(tmpdir(), "codex-cwd-"));

  const events = new EventEmitter();
  const notifications = [];
  const serverRequests = [];
  const stderr = [];
  const client = spawnAppServer({
    codexBin,
    codexHome: home,
    cwd,
    env: { PROBE_API_KEY: "probe-placeholder", RUST_LOG: "error" },
    logPath: join(ARTIFACTS, `${gate}.ndjson`),
    onNotification: (frame) => {
      notifications.push(frame);
      events.emit("notification", frame);
    },
    onServerRequest: async (frame) => {
      serverRequests.push(frame);
      events.emit("serverRequest", frame);
      return onServerRequest
        ? await onServerRequest(frame, { notifications })
        : { decision: "decline" };
    },
    onStderr: (chunk) => stderr.push(chunk),
  });

  const result = { notifications, serverRequests, stderr, http: fake.requests };
  try {
    result.initialize = await client.request("initialize", {
      clientInfo: { name: "mcpjam-probe", version: "0.0.0" },
    });
    client.notify("initialized", {});
    const thread = await client.request("thread/start", {
      cwd,
      ...threadParams,
    });
    result.thread = thread;
    const threadId = thread.thread?.id ?? thread.threadId ?? thread.id;
    result.threadId = threadId;

    const completed = new Promise((resolve) => {
      events.on("notification", (frame) => {
        if (frame.method === "turn/completed") resolve(frame.params.turn);
      });
    });
    const turn = await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt }],
    });
    result.turn = turn;
    const turnId = turn.turn?.id ?? turn.turnId;
    if (afterTurnStart) {
      result.after = await afterTurnStart({ client, threadId, turnId, events });
    }
    result.completed = await Promise.race([
      completed,
      new Promise((resolve) =>
        setTimeout(() => resolve({ status: "timeout" }), 45_000)
      ),
    ]);
    result.client = client;
    result.codexHome = home;
    result.cwd = cwd;
  } catch (error) {
    result.error = error;
  } finally {
    if (!result.keepOpen) {
      await client.close();
      await fake.close();
    }
  }
  return result;
}

const itemsOfType = (notifications, type) =>
  notifications
    .filter((n) => n.method === "item/started" || n.method === "item/completed")
    .map((n) => n.params.item)
    .filter((item) => item?.type === type);

const gates = {
  /** P1 — is a configured mcp_servers tool MODEL-CALLABLE (not just handshaken)? */
  async P1(codexBin) {
    const mcpLog = join(ARTIFACTS, "P1.mcp.ndjson");
    const run = await runTurn({
      codexBin,
      gate: "P1",
      mcpServers: {
        probe: {
          command: process.execPath,
          args: [join(HERE, "tiny-mcp-server.mjs")],
          env: { MCP_PROBE_LOG: mcpLog },
        },
      },
      // UNTRUSTED on purpose: this gate answers two questions at once — is the
      // MCP tool model-callable, and does calling it raise an approval request?
      // The schema has no MCP tool-call approval, and this is where that is
      // confirmed against a live server rather than inferred.
      threadParams: {
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
      },
      prompt: "Echo the word hello using the probe tool.",
      // Codex answers an unknown name with `unsupported call: <name>` as a
      // function_call_output rather than an error, so every candidate naming
      // convention can be probed in ONE run: whichever produces an mcpToolCall
      // item is the real one.
      script: [
        {
          functionCalls: [
            { name: "mcp__probe__probe_echo", arguments: { message: "a" } },
          ],
        },
        {
          functionCalls: [{ name: "probe_echo", arguments: { message: "b" } }],
        },
        {
          functionCalls: [
            {
              name: "mcp__probe",
              arguments: { tool: "probe_echo", arguments: { message: "c" } },
            },
          ],
        },
        {
          functionCalls: [
            { name: "probe.probe_echo", arguments: { message: "d" } },
          ],
        },
        { text: "Echoed." },
      ],
      onServerRequest: async () => ({ decision: "accept" }),
    });
    const declaredTools = (run.http[0]?.body?.tools ?? []).map(
      (t) => t?.name ?? t?.function?.name ?? t?.type
    );
    const mcpCalls = itemsOfType(run.notifications, "mcpToolCall");
    const startup = run.notifications
      .filter((n) => n.method === "mcpServer/startupStatus/updated")
      .map((n) => `${n.params.name}=${n.params.status}`);
    return {
      startup,
      declaredToolCount: declaredTools.length,
      declaredTools,
      mcpToolsDeclared: declaredTools.filter((t) =>
        String(t).includes("probe")
      ),
      mcpToolCallItems: mcpCalls.length,
      mcpToolCallStatus: mcpCalls.map(
        (c) => `${c.server}/${c.tool}:${c.status}`
      ),
      mcpToolCallResult: mcpCalls.find((c) => c.result)?.result,
      approvalRequestsDuringMcpCall: run.serverRequests.map((r) => r.method),
      unsupportedNames: (() => {
        try {
          const http = readFileSync(join(ARTIFACTS, "P1.http.ndjson"), "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l));
          return http
            .flatMap((r) => r.body?.input ?? [])
            .filter((i) => i?.type === "function_call_output")
            .map((i) => String(i.output).slice(0, 80));
        } catch {
          return "no log";
        }
      })(),
      mcpServerSawToolsCall: (() => {
        try {
          return readFileSync(mcpLog, "utf8")
            .split("\n")
            .filter((l) => l.includes('"tools/call"')).length;
        } catch {
          return "no log";
        }
      })(),
      turnStatus: run.completed?.status,
    };
  },

  /** P2 — the authority map: which server request fires, and in what order. */
  async P2(codexBin) {
    const order = [];
    const run = await runTurn({
      codexBin,
      gate: "P2",
      threadParams: {
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
      },
      prompt: "Create a file called probe.txt containing hi.",
      script: [
        {
          functionCalls: [
            { name: "exec_command", arguments: { cmd: "echo hi > probe.txt" } },
          ],
        },
        { text: "Created it." },
      ],
      onServerRequest: async (frame) => {
        order.push(`request:${frame.method}`);
        return { decision: "accept" };
      },
    });
    for (const n of run.notifications) {
      if (n.method === "item/started")
        order.push(`started:${n.params.item.type}`);
      if (n.method === "item/completed")
        order.push(`completed:${n.params.item.type}`);
    }
    const commands = itemsOfType(run.notifications, "commandExecution");
    const declaredTools = (run.http[0]?.body?.tools ?? []).map(
      (t) => t?.name ?? t?.function?.name ?? t?.type
    );
    return {
      declaredTools,
      fileChangeItems: itemsOfType(run.notifications, "fileChange").length,
      serverRequestMethods: run.serverRequests.map((r) => r.method),
      approvalParamKeys: Object.keys(run.serverRequests[0]?.params ?? {}),
      commandActions: commands[0]?.commandActions,
      order: order.slice(0, 14),
      commandStatus: commands.map((c) => c.status),
      turnStatus: run.completed?.status,
      threadStatusFlags: run.notifications
        .filter((n) => n.method === "thread/status/changed")
        .map(
          (n) =>
            `${n.params.status.type}${
              (n.params.status.activeFlags ?? []).join("+")
                ? `(${n.params.status.activeFlags.join("+")})`
                : ""
            }`
        ),
    };
  },

  /** P2b — a DENIED approval must produce no execution. */
  async P2b(codexBin) {
    const run = await runTurn({
      codexBin,
      gate: "P2b",
      threadParams: {
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandbox: "workspace-write",
      },
      prompt: "Create a file called denied.txt.",
      script: [
        {
          functionCalls: [
            {
              name: "exec_command",
              arguments: { cmd: "echo hi > denied.txt" },
            },
          ],
        },
        { text: "I could not create it." },
      ],
      onServerRequest: async () => ({ decision: "decline" }),
    });
    const commands = itemsOfType(run.notifications, "commandExecution");
    let fileExists = false;
    try {
      const { existsSync } = await import("node:fs");
      fileExists = existsSync(join(run.cwd ?? "", "denied.txt"));
    } catch {}
    return {
      serverRequestMethods: run.serverRequests.map((r) => r.method),
      commandStatus: commands.map((c) => c.status),
      fileWasCreated: fileExists,
      turnStatus: run.completed?.status,
    };
  },

  /** P3 — interrupt, and whether a turn survives it cleanly. */
  async P3(codexBin) {
    const run = await runTurn({
      codexBin,
      gate: "P3",
      threadParams: { approvalPolicy: "never", sandbox: "danger-full-access" },
      prompt: "Sleep for a while.",
      script: [
        {
          functionCalls: [
            { name: "exec_command", arguments: { cmd: "sleep 20" } },
          ],
        },
        { text: "Stopped." },
      ],
      afterTurnStart: async ({ client, threadId, turnId, events }) => {
        await new Promise((resolve) => {
          const listener = (frame) => {
            if (
              frame.method === "item/started" &&
              frame.params.item?.type === "commandExecution"
            ) {
              events.off("notification", listener);
              resolve();
            }
          };
          events.on("notification", listener);
          setTimeout(resolve, 8000);
        });
        return client.request("turn/interrupt", { threadId, turnId });
      },
    });
    return {
      interrupted: run.after !== undefined,
      turnStatus: run.completed?.status,
      commandStatus: itemsOfType(run.notifications, "commandExecution").map(
        (c) => c.status
      ),
    };
  },

  /** P4 — endpoint inventory + whether thread/start.config accepts nested tables. */
  async P4(codexBin) {
    const run = await runTurn({
      codexBin,
      gate: "P4",
      threadParams: {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        config: {
          model_reasoning_summary: "concise",
          mcp_servers: {
            viaconfig: {
              command: process.execPath,
              args: [join(HERE, "tiny-mcp-server.mjs")],
            },
          },
        },
      },
      prompt: "Say hello.",
      script: [{ text: "Hello." }],
    });
    return {
      threadStartAcceptedConfig: run.error
        ? `ERROR: ${run.error.message}`
        : "accepted",
      endpointsHit: [...new Set(run.http.map((r) => `${r.method} ${r.path}`))],
      mcpStartupFromConfig: run.notifications
        .filter((n) => n.method === "mcpServer/startupStatus/updated")
        .map((n) => `${n.params.name}=${n.params.status}`),
      configWarnings: run.notifications
        .filter((n) => n.method === "configWarning")
        .map((n) => n.params.summary),
      turnStatus: run.completed?.status,
    };
  },

  /**
   * P5 — the model admission matrix.
   *
   * `codex exec` answers an unknown model family with a silent `tools: []` turn.
   * app-server is louder: it warns "Model metadata for X not found. Defaulting
   * to fallback metadata". This gate records, per candidate model, whether that
   * warning fires and how many tools the model was actually given — which is
   * what `toCodexModel`'s allowlist should be written from, instead of a guess.
   */
  async P5(codexBin) {
    // Every gpt-5-family id in MCPJam's hosted catalog
    // (shared/hosted-model-ids.generated.ts), plus two non-hosted controls.
    const candidates = [
      "gpt-5",
      "gpt-5-chat",
      "gpt-5-codex",
      "gpt-5-mini",
      "gpt-5-nano",
      "gpt-5-pro",
      "gpt-5.1-codex",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini",
      "gpt-5.1-instant",
      "gpt-5.1-thinking",
      "gpt-5.2",
      "gpt-5.2-chat",
      "gpt-5.2-codex",
      "gpt-5.2-pro",
      "gpt-5.3-chat",
      "gpt-5.3-codex",
      "gpt-5.4",
      "gpt-5.4-mini",
      "gpt-5.4-nano",
      "gpt-5.4-pro",
      "gpt-5.5",
      "gpt-5.5-pro",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "o4-mini",
      "gpt-4o",
    ];
    const matrix = {};
    for (const model of candidates) {
      const run = await runTurn({
        codexBin,
        gate: `P5-${model}`,
        threadParams: {
          model,
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        },
        prompt: "Say hello.",
        script: [{ text: "Hello." }],
      });
      const warnings = run.notifications
        .filter((n) => n.method === "warning")
        .map((n) => n.params.message);
      const tools = (run.http[0]?.body?.tools ?? []).map(
        (t) => t?.name ?? t?.type
      );
      matrix[model] = {
        knownToCli: !warnings.some((w) => w.includes("not found")),
        toolCount: tools.length,
        turnStatus: run.completed?.status,
        ...(run.error
          ? { error: String(run.error.message).slice(0, 120) }
          : {}),
      };
    }
    return matrix;
  },

  /** P4b — does thread/start work outside a git repo (exec needed a flag)? */
  async P4b(codexBin) {
    const run = await runTurn({
      codexBin,
      gate: "P4b",
      threadParams: { approvalPolicy: "never", sandbox: "workspace-write" },
      prompt: "Say hello.",
      script: [{ text: "Hello." }],
    });
    return {
      nonGitCwdAccepted: run.error ? `ERROR: ${run.error.message}` : "accepted",
      turnStatus: run.completed?.status,
      warnings: run.notifications
        .filter((n) => n.method === "warning")
        .map((n) => n.params.message),
    };
  },
};

const codexBin = resolveCodex();
const only = arg("gate");
const results = {};
for (const [name, run] of Object.entries(gates)) {
  if (only && only !== name) continue;
  process.stdout.write(`\n=== ${name} ===\n`);
  try {
    results[name] = await run(codexBin);
  } catch (error) {
    results[name] = { error: String(error?.stack ?? error) };
  }
  process.stdout.write(`${JSON.stringify(results[name], null, 2)}\n`);
}
mkdirSync(ARTIFACTS, { recursive: true });
writeFileSync(
  join(ARTIFACTS, "gates.json"),
  `${JSON.stringify(results, null, 2)}\n`
);
process.stdout.write(`\nwrote ${join(ARTIFACTS, "gates.json")}\n`);
