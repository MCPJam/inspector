#!/usr/bin/env node
/**
 * A minimal stdio MCP server for the plugin-shim tests: newline-delimited
 * JSON-RPC on stdin/stdout, chatter on stderr.
 *
 * It is a real child process rather than a mock so the tests exercise the
 * shim's actual framing, correlation and process handling. Its behaviour is
 * steered by tool arguments (delays, crashes, silence) instead of by modes,
 * so one process can serve every scenario in a single test.
 *
 * `FAKE_MCP_SPLIT_WRITES=1` makes every response leave stdout in two writes,
 * cut at a sweeping offset so successive calls land the chunk boundary inside a
 * key, a value, the closing brace and just before the newline in turn.
 */
import process from "node:process";

const splitWrites = process.env.FAKE_MCP_SPLIT_WRITES === "1";

if (process.env.FAKE_MCP_IGNORE_SIGTERM === "1") {
  // Stands in for a child that refuses to shut down politely, so the shim's
  // SIGKILL escalation and its process cap are exercised for real. The ref'd
  // timer matters as much as the signal handler: closing stdin alone drains
  // this process's event loop, and a child that exits on its own would make
  // the escalation look effective when it never ran.
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 60_000);
}

let buffer = "";
/** Tool calls parked until the server's own request gets an answer. */
const awaitingHostReply = new Map();

process.stderr.write("fake-stdio-mcp-server: ready\n");

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (line.trim().length === 0) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      process.stderr.write("fake-stdio-mcp-server: unparseable input\n");
    }
  }
});

let writeCount = 0;

function write(message) {
  const text = `${JSON.stringify(message)}\n`;
  if (splitWrites === false) {
    process.stdout.write(text);
    return;
  }
  writeCount += 1;
  const cut = 1 + ((writeCount * 7) % (text.length - 1));
  process.stdout.write(text.slice(0, cut));
  setTimeout(() => process.stdout.write(text.slice(cut)), 5);
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function textResult(id, text) {
  respond(id, { content: [{ type: "text", text }] });
}

function handle(message) {
  if (typeof message.method !== "string") {
    const parked = awaitingHostReply.get(String(message.id));
    if (parked !== undefined) {
      awaitingHostReply.delete(String(message.id));
      textResult(
        parked,
        `host answered with ${message.error?.code ?? "a result"}`
      );
    }
    return;
  }

  if (message.id === undefined || message.id === null) {
    process.stderr.write(
      `fake-stdio-mcp-server: notification ${message.method}\n`
    );
    return;
  }

  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-stdio-mcp-server", version: "0.0.0" },
      _meta: { pid: process.pid },
    });
    return;
  }

  if (message.method === "tools/list") {
    respond(message.id, {
      tools: [
        { name: "echo", inputSchema: { type: "object" } },
        { name: "slow", inputSchema: { type: "object" } },
        { name: "boom", inputSchema: { type: "object" } },
        { name: "hang", inputSchema: { type: "object" } },
        { name: "provoke", inputSchema: { type: "object" } },
        { name: "env-keys", inputSchema: { type: "object" } },
        { name: "farewell", inputSchema: { type: "object" } },
      ],
    });
    return;
  }

  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};

    if (name === "boom") {
      process.stderr.write("fake-stdio-mcp-server: exiting mid-request\n");
      process.exit(3);
    }
    if (name === "farewell") {
      // Answer and die in the same tick, without the split-write helper: the
      // response and the process exit race each other to the shim.
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { content: [{ type: "text", text: "farewell" }] },
        })}\n`
      );
      process.exit(0);
    }
    if (name === "hang") {
      process.stderr.write("fake-stdio-mcp-server: swallowing a request\n");
      return;
    }
    if (name === "slow") {
      setTimeout(
        () => textResult(message.id, `slow:${args.text ?? ""}`),
        args.delayMs ?? 40
      );
      return;
    }
    if (name === "env-keys") {
      const prefix = String(args.prefix ?? "");
      const keys = Object.keys(process.env)
        .filter((key) => key.startsWith(prefix))
        .sort();
      textResult(message.id, JSON.stringify(keys));
      return;
    }
    if (name === "provoke") {
      // A server-to-client request. The shim must answer it on stdin instead
      // of leaving this call parked forever.
      const requestId = `srv-${message.id}`;
      awaitingHostReply.set(requestId, message.id);
      write({
        jsonrpc: "2.0",
        id: requestId,
        method: "sampling/createMessage",
        params: {},
      });
      return;
    }
    textResult(message.id, `echo:${args.text ?? ""}:${process.pid}`);
    return;
  }

  write({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: `unknown method ${message.method}` },
  });
}
