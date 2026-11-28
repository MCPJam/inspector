/**
 * A small writable MCP server for tests that need a real backing server:
 * tickets with `lookup_ticket`, `close_ticket` and `echo`, and a count of
 * every tool dispatch it receives. A test asserts on the count to prove that
 * a call did, or did not, reach the real server.
 *
 * Over HTTP it runs in this process (`startTicketHttp`). Over stdio it runs as
 * a child (`startTicketStdio`), because that is how a stdio base runs; its
 * dispatches are appended to a log file the helper counts.
 */
import { appendFileSync, mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

export interface TicketDispatch {
  tool: string;
  arguments: Record<string, unknown>;
}

export interface TicketStore {
  tickets: Map<string, { id: string; status: string }>;
  /** One entry per tool call that reached the server, in order. */
  dispatches: TicketDispatch[];
}

export function newTicketStore(): TicketStore {
  return {
    tickets: new Map([
      ["123", { id: "123", status: "open" }],
      ["456", { id: "456", status: "open" }],
    ]),
    dispatches: [],
  };
}

/** Builds the server; `onDispatch` runs before each tool body. */
export function buildTicketServer(
  store: TicketStore,
  onDispatch: (d: TicketDispatch) => void = (d) => void store.dispatches.push(d),
): McpServer {
  const server = new McpServer(
    { name: "ticket-fixture", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const text = (value: unknown) => ({
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }],
  });
  server.registerTool(
    "lookup_ticket",
    { description: "Reads a ticket.", inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } },
    async ({ id }) => {
      onDispatch({ tool: "lookup_ticket", arguments: { id } });
      const ticket = store.tickets.get(id);
      return ticket ? text(ticket) : { ...text(`No ticket ${id}.`), isError: true };
    },
  );
  server.registerTool(
    "close_ticket",
    {
      description: "Closes a ticket.",
      inputSchema: { id: z.string() },
      annotations: { destructiveHint: true, readOnlyHint: false },
    },
    async ({ id }) => {
      onDispatch({ tool: "close_ticket", arguments: { id } });
      const ticket = store.tickets.get(id);
      if (!ticket) return { ...text(`No ticket ${id}.`), isError: true };
      ticket.status = "closed";
      return text(ticket);
    },
  );
  server.registerTool(
    "echo",
    { description: "Echoes the message.", inputSchema: { message: z.string() } },
    async ({ message }) => {
      onDispatch({ tool: "echo", arguments: { message } });
      return text(`echo: ${message}`);
    },
  );
  return server;
}

export interface RunningTicketServer {
  store: TicketStore;
  /** How many tool calls reached the server. */
  dispatchCount(): number;
  close(): Promise<void>;
}

export async function startTicketHttp(): Promise<RunningTicketServer & { url: string }> {
  const store = newTicketStore();
  const handler = createMcpHandler(() => buildTicketServer(store), { legacy: "stateless" });
  const http = serve({ fetch: (request) => handler.fetch(request), port: 0, hostname: "127.0.0.1" });
  await new Promise<void>((resolve) => http.once("listening", () => resolve()));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    store,
    dispatchCount: () => store.dispatches.length,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}

/** The child's entry: serves over stdio and appends one line per dispatch to the log it is given. */
const STDIO_ENTRY = fileURLToPath(new URL("./ticket-server-stdio.ts", import.meta.url));

export function startTicketStdio(): {
  command: string;
  args: string[];
  dispatchCount(): number;
  cleanup(): void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "ticket-fixture-"));
  const log = path.join(dir, "dispatches.log");
  return {
    command: process.execPath,
    args: ["--import", "tsx", STDIO_ENTRY, log],
    dispatchCount: () =>
      existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Used by the stdio entry. */
export function logDispatchTo(file: string) {
  return (d: TicketDispatch) => appendFileSync(file, `${JSON.stringify(d)}\n`);
}
