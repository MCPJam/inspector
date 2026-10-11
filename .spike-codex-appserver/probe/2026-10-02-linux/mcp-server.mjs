// Dependency-free stdio MCP server for probes (b) and (d).
// Env:
//   MCP_NAME  label written into every log line
//   MCP_LOG   NDJSON file; a {event:"spawned"} line is appended at startup, then
//             every inbound frame and every tool call start/finish.
// Tools:
//   echo({message})               -> immediate
//   slow_echo({message, seconds}) -> replies after `seconds` (the relay-timeout probe)
import { appendFileSync } from "node:fs";

const NAME = process.env.MCP_NAME ?? "unnamed";
const LOG = process.env.MCP_LOG;
const log = (entry) => {
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), name: NAME, pid: process.pid, ...entry })}\n`);
};
log({ event: "spawned", argv: process.argv.slice(1), cwd: process.cwd(), ppid: process.ppid });

const TOOLS = [
  {
    name: "echo",
    description: "Echo a message back immediately.",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
  },
  {
    name: "slow_echo",
    description: "Echo a message back after waiting `seconds` seconds.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" }, seconds: { type: "number" } },
      required: ["message", "seconds"],
      additionalProperties: false,
    },
  },
];

// MCP_ANNOTATE=readonly|destructive adds tool annotations (to probe codex's MCP approval gating)
if (process.env.MCP_ANNOTATE === "readonly") for (const t of TOOLS) t.annotations = { readOnlyHint: true };
if (process.env.MCP_ANNOTATE === "destructive") for (const t of TOOLS) t.annotations = { readOnlyHint: false, destructiveHint: true };

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    log({ event: "in", method: frame.method, id: frame.id, params: frame.method === "tools/call" ? frame.params : undefined });
    handle(frame);
  }
});
process.stdin.on("end", () => {
  log({ event: "stdin-end" });
  process.exit(0);
});
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => (log({ event: "signal", sig }), process.exit(0)));

function handle({ id, method, params }) {
  if (method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: `probe-${NAME}`, version: "0.0.0" },
      },
    });
  }
  if (id === undefined) return; // notifications (initialized, cancelled, ...)
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    const { name, arguments: args = {} } = params ?? {};
    const started = Date.now();
    log({ event: "call-start", tool: name, args });
    const finish = () => {
      log({ event: "call-finish", tool: name, elapsedMs: Date.now() - started });
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `${name}: ${args.message ?? ""} (after ${Date.now() - started} ms)` }], isError: false } });
    };
    if (name === "slow_echo") setTimeout(finish, Math.round(Number(args.seconds ?? 0) * 1000));
    else finish();
    return;
  }
  if (method === "resources/list") return send({ jsonrpc: "2.0", id, result: { resources: [] } });
  if (method === "resources/templates/list") return send({ jsonrpc: "2.0", id, result: { resourceTemplates: [] } });
  if (method === "prompts/list") return send({ jsonrpc: "2.0", id, result: { prompts: [] } });
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}
