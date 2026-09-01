// A dependency-free stdio MCP server with one tool, for the P1 gate.
//
// The question P1 asks is narrow: does `codex app-server` make a tool from a
// configured `mcp_servers` entry MODEL-CALLABLE, or does it only complete the
// handshake (the failure openai/codex#19425 describes)? Answering it needs a
// server whose every call is observable, so this one appends each request to
// MCP_PROBE_LOG. A third-party server would answer the same question with more
// moving parts.
import { appendFileSync } from "node:fs";

const LOG = process.env.MCP_PROBE_LOG;
const log = (entry) => {
  if (LOG) appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), ...entry })}\n`);
};

const TOOLS = [
  {
    name: "probe_echo",
    description:
      "Echo a message back. Use this tool whenever you are asked to echo something.",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
  },
];

const send = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    log({ direction: "in", frame });
    handle(frame);
  }
});

function handle(frame) {
  const { id, method, params } = frame;
  if (method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "mcpjam-probe", version: "0.0.0" },
      },
    });
  }
  if (method === "notifications/initialized" || id === undefined) return;
  if (method === "tools/list") {
    return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  }
  if (method === "tools/call") {
    const message = params?.arguments?.message ?? "";
    return send({
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `probe_echo: ${message}` }],
        isError: false,
      },
    });
  }
  if (method === "resources/list") {
    return send({ jsonrpc: "2.0", id, result: { resources: [] } });
  }
  if (method === "prompts/list") {
    return send({ jsonrpc: "2.0", id, result: { prompts: [] } });
  }
  send({
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `method not found: ${method}` },
  });
}
