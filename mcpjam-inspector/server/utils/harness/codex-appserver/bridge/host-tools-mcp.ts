/**
 * The stdio MCP server Codex spawns to reach MCPJam's host-executed tools.
 *
 * A SECOND ENTRYPOINT, bundled beside `bridge.mjs` and launched by Codex itself
 * (see the `[mcp_servers.mcpjam]` block in `codex-home.ts`), not imported by
 * the bridge. It owns no decisions: `tools/list` and `tools/call` are proxied
 * to the bridge over the loopback relay, which is where the host's real tool
 * set and the harness's approval gate live.
 *
 * Written against the MCP wire directly rather than through the SDK. The
 * dependency would be one more thing to pin in the bootstrap and keep aligned
 * with the framework's own copy, for a server with two methods.
 *
 * Split into a pure {@link createHostToolMcpServer} core and a thin stdio shell
 * so the proxying can be tested against a real relay without spawning a process
 * and without mocking a transport.
 */
import { appendFileSync } from "node:fs";

/** The MCP protocol version to answer with when the client names none. */
const FALLBACK_PROTOCOL_VERSION = "2025-06-18";

export type JsonRpcFrame = {
  jsonrpc?: string;
  /** `null` is representable on purpose: a peer may SEND it, and the spec's
   *  reply to a malformed request carries `id: null`. It is never correlatable,
   *  which is what `handle` refuses on. */
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
};

export type HostToolMcpServer = {
  /** Handle one inbound frame. Resolves to the reply, or `undefined` for a
   *  notification (which must NOT be answered). */
  handle(frame: JsonRpcFrame): Promise<JsonRpcFrame | undefined>;
};

export function createHostToolMcpServer(options: {
  relayUrl: string | undefined;
  relayCredential: string | undefined;
  fetchImpl?: typeof fetch;
}): HostToolMcpServer {
  const doFetch = options.fetchImpl ?? fetch;

  async function relay(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<unknown> {
    if (!options.relayUrl || !options.relayCredential) {
      throw new Error("host-tool relay is not configured for this session");
    }
    const response = await doFetch(`${options.relayUrl}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        "x-mcpjam-relay-credential": options.relayCredential,
        ...(init?.body ? { "content-type": "application/json" } : {}),
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!response.ok) {
      throw new Error(`relay ${path} failed with ${response.status}`);
    }
    return response.json();
  }

  const errorResult = (message: string) => ({
    content: [{ type: "text", text: message }],
    isError: true,
  });

  return {
    async handle(frame) {
      const { id, method, params } = frame;

      // ID FIRST, before any method is dispatched. Two shapes were wrong here:
      //   - `initialize` answered even with NO id, so a notification got a
      //     response, which a strict peer treats as a protocol violation;
      //   - an explicit `id: null` fell through as if it were correlatable, and
      //     a response carrying `id: null` cannot be matched to anything.
      // Only an ABSENT id makes a notification. `null` is refused because MCP
      // forbids it outright ("the request ID MUST NOT be null") — NOT because
      // of JSON-RPC 2.0, which permits a null id and merely discourages it.
      // The distinction matters to anyone porting this handler to a plain
      // JSON-RPC peer, where rejecting null would be wrong.
      if (id === undefined) return undefined;
      if (id === null) {
        return {
          id: null,
          error: {
            code: -32600,
            message: "Invalid Request: id must not be null",
          },
        };
      }

      if (method === "initialize") {
        return {
          id,
          result: {
            protocolVersion:
              (params?.protocolVersion as string | undefined) ??
              FALLBACK_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "mcpjam", version: "1.0.0" },
          },
        };
      }

      if (method === "tools/list") {
        try {
          const result = (await relay("/tools")) as { tools?: unknown[] };
          return { id, result: { tools: result.tools ?? [] } };
        } catch (error) {
          return {
            id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          };
        }
      }

      if (method === "tools/call") {
        const toolName = String(params?.name ?? "");
        try {
          const result = (await relay("/call", {
            method: "POST",
            body: { toolName, input: params?.arguments ?? {} },
          })) as { ok?: boolean; result?: unknown; error?: string };
          // A host tool FAILURE is a result with `isError`, not a protocol
          // error: the model should see the message and be able to react,
          // which a JSON-RPC error would deny it.
          if (result.ok === false) {
            return {
              id,
              result: errorResult(result.error ?? "host tool failed"),
            };
          }
          return { id, result: toMcpToolResult(result.result) };
        } catch (error) {
          return {
            id,
            result: errorResult(
              error instanceof Error ? error.message : String(error),
            ),
          };
        }
      }

      // Codex probes these at startup. Answering empty beats a "method not
      // found" it would log as a server fault.
      if (method === "resources/list") return { id, result: { resources: [] } };
      if (method === "resources/templates/list") {
        return { id, result: { resourceTemplates: [] } };
      }
      if (method === "prompts/list") return { id, result: { prompts: [] } };

      return {
        id,
        error: { code: -32601, message: `method not found: ${method}` },
      };
    },
  };
}

/** Shape a host tool's return value as MCP content. */
export function toMcpToolResult(result: unknown): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
} {
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] };
  }
  // Already MCP-shaped (the common case — a host tool projected from a real
  // MCP server returns its server's own content) — pass it through untouched
  // so nothing is re-encoded or lost.
  if (
    result &&
    typeof result === "object" &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    return result as { content: Array<{ type: "text"; text: string }> };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result ?? null) }],
    structuredContent: result,
  };
}

/** Read newline-delimited frames from a stream and write replies to another. */
export function pumpJsonLines(input: {
  server: HostToolMcpServer;
  stdin: NodeJS.ReadableStream;
  write(line: string): void;
  onParseError?(line: string, error: unknown): void;
}): void {
  let buffer = "";
  input.stdin.setEncoding("utf8");
  input.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let frame: JsonRpcFrame;
      try {
        frame = JSON.parse(line) as JsonRpcFrame;
      } catch (error) {
        input.onParseError?.(line, error);
        continue;
      }
      void input.server.handle(frame).then((reply) => {
        if (reply)
          input.write(`${JSON.stringify({ jsonrpc: "2.0", ...reply })}\n`);
      });
    }
  });
}

/** Wire the server to this process's stdio. Called when Codex runs the file. */
export function startHostToolMcpServer(): void {
  const debugLog = process.env.MCPJAM_HOST_TOOL_LOG;
  pumpJsonLines({
    server: createHostToolMcpServer({
      relayUrl: process.env.MCPJAM_HOST_TOOL_RELAY_URL,
      relayCredential: process.env.MCPJAM_HOST_TOOL_RELAY_CREDENTIAL,
    }),
    stdin: process.stdin,
    write: (line) => process.stdout.write(line),
    onParseError: (line, error) => {
      if (!debugLog) return;
      try {
        appendFileSync(
          debugLog,
          `${JSON.stringify({ t: Date.now(), line, error: String(error) })}\n`,
        );
      } catch {
        // A broken debug log must never break a turn.
      }
    },
  });
  process.stdin.on("end", () => process.exit(0));
}

// Codex runs this file directly; the bridge imports nothing from it. The guard
// keeps `import` in a test from starting a server on the test runner's stdin.
if (process.env.MCPJAM_HOST_TOOL_MCP_AUTOSTART === "true") {
  startHostToolMcpServer();
}
