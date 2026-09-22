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
 * ## Bound to loopback, authenticated — and NOT a boundary against the agent
 *
 * The listener binds `127.0.0.1` on an OS-assigned port, so nothing outside the
 * box can reach it, and it requires a per-session bearer credential so that an
 * unrelated process in the box cannot drive it by accident.
 *
 * It is NOT a boundary against the agent, and an earlier version of this note
 * claimed it was ("an unauthenticated port would let the model bypass the
 * approval gate"). That was wrong twice over, and both halves are worth stating
 * because the wrong version invites a fix that cannot exist:
 *
 *  1. The credential is READABLE BY THE AGENT, unavoidably. Codex spawns the
 *     MCP server, so the credential must reach that process through config the
 *     agent's own shell can read (`$CODEX_HOME/config.toml`). The sandbox runs
 *     everything as one uid, so no file mode, path, or descriptor hides it from
 *     a shell running as the same user. Moving it out of the workspace changes
 *     nothing.
 *  2. It was never what gates approval. A relayed call is emitted as a
 *     `tool-call` with `providerExecuted: false` and then AWAITS
 *     `turn.requestToolResult` — the host runs the tool, and `HarnessAgent`'s
 *     `toolApproval` fires there, before `execute`. A caller holding the
 *     credential therefore reaches exactly the same gate as the MCP server
 *     does; it cannot resolve a call itself, and every call it starts appears
 *     in the trace as an ordinary host tool call.
 *
 * So what the credential actually buys is defence in depth against everything
 * that is not the agent. What bounds the agent is the host-side approval gate
 * plus the fact that the relay exposes only the tools the user already selected
 * for this turn — the same tools Codex can call through the sanctioned MCP
 * channel anyway, which is the entire reason this relay exists.
 *
 * ## No timeout on a call
 *
 * A host tool can be waiting on a human approval, so the relay must not impose
 * a deadline. What bounds it instead is turn lifetime: {@link cancelAll} fails
 * every in-flight call when the turn aborts, so nothing outlives its turn.
 */
import { createServer, type Server } from "node:http";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";

/** Cap on a `/call` body. See the bounded-read note in the request handler. */
export const MAX_CALL_BODY_BYTES = 8 * 1024 * 1024;

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

    // BOUNDED. The credential keeps a stranger off this socket, but the caller
    // it does admit is a model-driven agent inside the sandbox, so an
    // unbounded `body +=` is a way for a confused (or steered) turn to kill the
    // bridge by exhausting its heap. A tool argument list is kilobytes; the cap
    // is generous enough that no real call meets it and small enough that a
    // runaway one dies immediately.
    let body = "";
    let bodyBytes = 0;
    let aborted = false;
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      if (aborted) return;
      // BYTES, not string length. `setEncoding("utf8")` hands us strings, whose
      // `.length` counts UTF-16 code units — half the story for anything
      // outside the BMP and an undercount for most non-ASCII. A body of 3-byte
      // characters would have reached ~3x this cap before the check fired,
      // which is the opposite of what a byte limit is for.
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      if (bodyBytes + chunkBytes > MAX_CALL_BODY_BYTES) {
        aborted = true;
        reply(413, { error: "request body too large" });
        // Destroy AFTER the response is flushed. Tearing the socket down
        // immediately can abort it before the 413 reaches the caller, which
        // turns a documented refusal into an opaque connection reset — and the
        // point of answering 413 is that the caller learns why.
        res.once("finish", () => req.destroy());
        return;
      }
      bodyBytes += chunkBytes;
      body += chunk;
    });
    req.on("end", () => {
      if (aborted) return;
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
      // Cancel BEFORE awaiting: `server.close()` waits for open connections to
      // finish, and a host tool parked on a human approval keeps its request
      // open indefinitely. Without this, session teardown blocks on a decision
      // that is never coming.
      for (const reject of inFlight) {
        reject(new Error("bridge is shutting down"));
      }
      inFlight.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    cancelAll(reason) {
      for (const reject of inFlight) reject(new Error(reason));
      inFlight.clear();
    },
  };
}
