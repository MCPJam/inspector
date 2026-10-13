// Stdio MCP server used as the target under test for `mcpjam test`:
//
//   - read_note   — annotated readOnlyHint: true
//   - delete_note — annotated destructiveHint: true
//   - echo        — no annotations at all (an UNKNOWN classification)
//
// Every execution is appended to the file named by POLICY_TARGET_CALLS_FILE
// (one tool name per line), so a test asserts what actually reached the
// server — a denied delete_note leaves no line — rather than what the client
// believed it sent. POLICY_TARGET_CWD_FILE, when set, receives the process
// working directory, so a test can verify an MCP config's `cwd` rule, and
// POLICY_TARGET_PID_FILE the process id, so a test can verify cleanup.
import { appendFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const callsFile = process.env.POLICY_TARGET_CALLS_FILE;
const record = (name) => {
  if (callsFile) appendFileSync(callsFile, `${name}\n`);
};
if (process.env.POLICY_TARGET_CWD_FILE) {
  writeFileSync(process.env.POLICY_TARGET_CWD_FILE, process.cwd());
}
// The PID, so a test can prove the runner stopped this process afterwards.
if (process.env.POLICY_TARGET_PID_FILE) {
  writeFileSync(process.env.POLICY_TARGET_PID_FILE, String(process.pid));
}

const server = new McpServer(
  { name: process.env.POLICY_TARGET_NAME ?? "policy-target", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.registerTool(
  "read_note",
  {
    description: "Read a note by id.",
    inputSchema: z.object({ id: z.string() }),
    annotations: { readOnlyHint: true },
  },
  async ({ id }) => {
    record("read_note");
    return { content: [{ type: "text", text: `note ${id}: buy milk` }] };
  }
);

server.registerTool(
  "delete_note",
  {
    description: "Delete a note by id.",
    inputSchema: z.object({ id: z.string() }),
    annotations: { destructiveHint: true },
  },
  async ({ id }) => {
    record("delete_note");
    return { content: [{ type: "text", text: `deleted ${id}` }] };
  }
);

server.registerTool(
  "echo",
  {
    description: "Echo a message.",
    inputSchema: z.object({ message: z.string() }),
  },
  async ({ message }) => {
    record("echo");
    return { content: [{ type: "text", text: message }] };
  }
);

await server.connect(new StdioServerTransport());
