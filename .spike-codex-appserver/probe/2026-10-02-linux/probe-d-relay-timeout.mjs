// Probe (d): MCP tool_timeout_sec behaviour for a relay-style MCP server.
//
// The fake model calls a namespaced MCP tool by emitting a Responses
// `function_call` item carrying `namespace: "mcp__relay"` + `name: "<tool>"`
// (the shape codex declares it with: a `namespace` tool containing functions).
//
// Cases (argv selects; default all):
//   callform       echo via {namespace, name} — is the tool model-callable at all from a fake provider?
//   t5-sleep15     tool_timeout_sec = 5,    tool sleeps 15 s  -> expect timeout
//   t3600-sleep70  tool_timeout_sec = 3600, tool sleeps 70 s  -> expect completion
//   t0-instant     tool_timeout_sec = 0 (what codex-home.ts renders today), immediate tool
//   t0-sleep2      tool_timeout_sec = 0, tool sleeps 2 s
//   default-sleep70 tool_timeout_sec omitted, tool sleeps 70 s -> what is the default?
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { createFake, freshDirs, renderConfig, startAppServer, items, callOutputs, writeJson, HERE } from "./lib.mjs";

const MCP = join(HERE, "mcp-server.mjs");

async function runCase(name, { toolTimeoutSec, tool = "slow_echo", seconds = 0, turnTimeoutMs = 240_000, serverExtra = {}, annotate, approvalPolicy = "never", decision = { decision: "accept", action: "accept" } }) {
  const d = freshDirs(`d-${name}`);
  const mcpLog = join(d.root, "mcp.ndjson");
  writeFileSync(mcpLog, "");
  const fake = createFake({
    script: [
      { functionCalls: [{ namespace: "mcp__relay", name: tool, callId: "call_relay", arguments: tool === "echo" ? { message: "hi" } : { message: "hi", seconds } }] },
      { text: "done" },
    ],
    logPath: join(d.root, "http.ndjson"),
  });
  const origin = await fake.listen();
  const server = { command: process.execPath, args: [MCP], ...serverExtra, env: { MCP_NAME: "relay", MCP_LOG: mcpLog, ...(annotate ? { MCP_ANNOTATE: annotate } : {}) } };
  if (toolTimeoutSec !== undefined) server.tool_timeout_sec = toolTimeoutSec;
  writeFileSync(join(d.codexHome, "config.toml"), renderConfig({ baseUrl: `${origin}/v1`, mcpServers: { relay: server } }));
  const app = startAppServer({ codexHome: d.codexHome, cwd: d.cwd, home: d.home, env: { TMPDIR: d.tmp }, logPath: join(d.root, "rpc.ndjson") });
  const srv = [];
  app.onServerRequest(async (f) => (srv.push({ method: f.method, params: f.params }), decision));
  const r = { case: name, approvalPolicy, serverExtra, annotate: annotate ?? null, toolTimeoutSec: toolTimeoutSec ?? "(omitted)", tool, seconds };
  const t0 = Date.now();
  try {
    await app.init();
    const t = await app.startThreadAndTurn({
      threadParams: { cwd: d.cwd, approvalPolicy, approvalsReviewer: "user", sandbox: "read-only" },
      prompt: "Call the relay tool.",
      timeoutMs: turnTimeoutMs,
    });
    r.turnStatus = t.completed.status;
    r.turnError = t.completed.error ?? null;
  } catch (e) {
    r.error = e.message.slice(0, 500);
  } finally {
    r.wallMs = Date.now() - t0;
    await app.close();
    await fake.close();
  }
  const mcpItems = items(app.notifications, "mcpToolCall");
  const started = items(app.notifications, "mcpToolCall", "item/started");
  r.mcpToolCall = mcpItems.map((i) => ({ server: i.server, tool: i.tool, status: i.status, durationMs: i.durationMs, error: i.error, result: JSON.stringify(i.result ?? null).slice(0, 300) }));
  r.mcpToolCallStartedCount = started.length;
  r.serverRequests = srv.map((s) => ({ method: s.method, params: JSON.stringify(s.params).slice(0, 700) }));
  r.modelSaw = callOutputs(fake.requests).call_relay ?? null;
  if (r.modelSaw && typeof r.modelSaw !== "string") r.modelSaw = JSON.stringify(r.modelSaw);
  r.mcpServerLog = readFileSync(mcpLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => ["call-start", "call-finish", "signal", "stdin-end"].includes(e.event) || (e.event === "in" && /cancel/.test(e.method ?? "")))
    .map((e) => ({ dt: e.t - t0, event: e.event, method: e.method, elapsedMs: e.elapsedMs }));
  // notifications/cancelled frames codex sent to the server, if any
  r.cancelNotifications = readFileSync(mcpLog, "utf8").split("\n").filter((l) => l.includes("notifications/cancelled")).length;
  r.warnings = app.notifications.filter((n) => ["warning", "configWarning", "error"].includes(n.method)).map((n) => `${n.method}: ${JSON.stringify(n.params).slice(0, 300)}`).filter((w) => !/Model metadata|bubblewrap/.test(w));
  r.startup = app.notifications.filter((n) => n.method === "mcpServer/startupStatus/updated").map((n) => `${n.params.name}=${n.params.status}`);
  writeJson(join(HERE, "results", `d-${name}.json`), r);
  console.log(`\n===== ${name}\n${JSON.stringify(r, null, 1)}`);
  return r;
}

// Timeout cases run with default_tools_approval_mode = "approve" so the call is not refused under
// approvalPolicy "never" (see the gating matrix: gate-*).
const APPROVE = { default_tools_approval_mode: "approve" };
const cases = {
  // -- gating matrix: does the call reach the server at all? (echo = immediate)
  callform: () => runCase("callform", { tool: "echo" }),
  "gate-never-readonly-annot": () => runCase("gate-never-readonly-annot", { tool: "echo", annotate: "readonly" }),
  "gate-never-mode-approve": () => runCase("gate-never-mode-approve", { tool: "echo", serverExtra: { default_tools_approval_mode: "approve" } }),
  "gate-never-mode-auto": () => runCase("gate-never-mode-auto", { tool: "echo", serverExtra: { default_tools_approval_mode: "auto" } }),
  "gate-never-mode-writes": () => runCase("gate-never-mode-writes", { tool: "echo", serverExtra: { default_tools_approval_mode: "writes" } }),
  "gate-never-mode-prompt-readonly": () => runCase("gate-never-mode-prompt-readonly", { tool: "echo", annotate: "readonly", serverExtra: { default_tools_approval_mode: "prompt" } }),
  "gate-untrusted-accept": () => runCase("gate-untrusted-accept", { tool: "echo", approvalPolicy: "untrusted" }),
  "gate-untrusted-decline": () => runCase("gate-untrusted-decline", { tool: "echo", approvalPolicy: "untrusted", decision: { decision: "decline", action: "decline" } }),
  "gate-onrequest-accept": () => runCase("gate-onrequest-accept", { tool: "echo", approvalPolicy: "on-request" }),
  "gate-untrusted-mode-approve": () => runCase("gate-untrusted-mode-approve", { tool: "echo", approvalPolicy: "untrusted", serverExtra: { default_tools_approval_mode: "approve" } }),
  // -- timeouts
  "t5-sleep15": () => runCase("t5-sleep15", { toolTimeoutSec: 5, seconds: 15, serverExtra: APPROVE }),
  "t3600-sleep70": () => runCase("t3600-sleep70", { toolTimeoutSec: 3600, seconds: 70, serverExtra: APPROVE }),
  "t0-instant": () => runCase("t0-instant", { toolTimeoutSec: 0, tool: "echo", serverExtra: APPROVE }),
  "t0-sleep2": () => runCase("t0-sleep2", { toolTimeoutSec: 0, seconds: 2, serverExtra: APPROVE }),
  "default-sleep70": () => runCase("default-sleep70", { seconds: 70, serverExtra: APPROVE }),
  // where does the DEFAULT tool timeout cut in? (tool sleeps 900 s; codex's own timeout ends it first, if any)
  "default-find": () => runCase("default-find", { seconds: 900, serverExtra: APPROVE, turnTimeoutMs: 1_000_000 }),
};
const want = process.argv.slice(2);
for (const [n, fn] of Object.entries(cases)) if (!want.length || want.includes(n)) await fn();
