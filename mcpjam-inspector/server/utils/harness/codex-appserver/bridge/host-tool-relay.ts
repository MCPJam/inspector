/**
 * The loopback channel between the in-sandbox MCP server Codex spawns and this
 * bridge.
 *
 * ## Why a separate process at all
 *
 * MCPJam's host tools execute on MCPJam's server, not in the box. Claude Code's
 * adapter can register them as an in-process MCP server because its SDK runs
 * inside the bridge. `codex app-server` is a SEPARATE PROCESS, so the only way
 * to make a host tool model-callable is to give Codex an MCP server it can
 * spawn — and that server then needs a way to reach back into the bridge, which
 * is what this is. The shape is the one `@ai-sdk/harness-acp` uses for the same
 * reason.
 *
 * ## Bound to loopback, and still authenticated
 *
 * The listener binds `127.0.0.1` on an OS-assigned port, so nothing outside the
 * box can reach it. It still requires a per-session bearer credential, because
 * "inside the box" includes the agent itself: the model has a shell, and an
 * unauthenticated local port would let it invoke the user's MCP tools directly,
 * bypassing the approval gate that is the whole point of this transport.
 *
 * ## No timeout on a call
 *
 * A host tool can be waiting on a human approval, so the relay must not impose
 * a deadline. What bounds it instead is turn lifetime: {@link cancelAll} fails
 * every in-flight call when the turn aborts, so nothing outlives its turn.
 */
import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";

export type HostToolInvocation = {
  /** The tool name as the HOST declared it (already un-aliased). */
  toolName: string;
  input: unknown;
};

export type HostToolRelay = {
  readonly url: string;
  readonly credential: string;
  close(): Promise<void>;
  /** Fail every in-flight call. */
  cancelAll(reason: string): void;
};

export type HostToolRelayHandlers = {
  /** The tool catalog Codex should publish, as MCP tool descriptors. */
  listTools(): Array<{
    name: string;
    description?: string;
    inputSchema: unknown;
  }>;
  /** Execute one call and resolve with its result. May take minutes. */
  callTool(invocation: HostToolInvocation): Promise<unknown>;
};

/** Constant-time compare over digests, so neither length nor content leaks. */
function credentialMatches(presented: string, expected: string): boolean {
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

export async function startHostToolRelay(
  handlers: HostToolRelayHandlers,
): Promise<HostToolRelay> {
  const credential = randomBytes(32).toString("hex");
  const inFlight = new Set<(error: Error) => void>();

  const server: Server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      const payload = JSON.stringify(body);
      res.writeHead(status, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      });
      res.end(payload);
    };

    const presented = (req.headers["x-mcpjam-relay-credential"] ??
      "") as string;
    if (!presented || !credentialMatches(presented, credential)) {
      // Identical body for absent and wrong, and no hint about which.
      reply(401, { error: "unauthorized" });
      return;
    }

    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/tools") {
      reply(200, { tools: handlers.listTools() });
      return;
    }
    if (req.method !== "POST" || path !== "/call") {
      reply(404, { error: "not found" });
      return;
    }

    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      let invocation: HostToolInvocation;
      try {
        invocation = JSON.parse(body) as HostToolInvocation;
      } catch {
        reply(400, { error: "malformed body" });
        return;
      }
      let rejectInFlight: ((error: Error) => void) | undefined;
      const cancellation = new Promise<never>((_, reject) => {
        rejectInFlight = reject;
        inFlight.add(reject);
      });
      Promise.race([handlers.callTool(invocation), cancellation])
        .then(
          (result) => reply(200, { ok: true, result }),
          (error: unknown) =>
            reply(200, {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
        )
        .finally(() => {
          if (rejectInFlight) inFlight.delete(rejectInFlight);
        });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    credential,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    cancelAll(reason) {
      for (const reject of inFlight) reject(new Error(reason));
      inFlight.clear();
    },
  };
}
