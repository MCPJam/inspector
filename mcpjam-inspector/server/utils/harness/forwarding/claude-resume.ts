import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { z } from "zod";
import type { HarnessV1 } from "@ai-sdk/harness";
import { withBridgeToken } from "@ai-sdk/harness/utils";
import { MAX_SEALED_PLAINTEXT_BYTES } from "../harness-proxy-limits.js";
import type { HarnessMcpJson } from "../mcp-config.js";

const bridgeState = z.object({
  data: z.object({
    bridge: z.object({
      port: z.number().int().positive(),
      token: z.string().min(1),
    }),
    mcpjamForwardingPolicy: z.string().min(1),
  }),
});
const response = z.object({
  type: z.literal("mcpjam-mcp-refreshed"),
  id: z.string(),
  ok: z.boolean(),
});
const marker = "mcpjamRefreshNativeMcp";

function withoutRespawn<T extends object>(sandbox: T): T {
  return new Proxy(sandbox, {
    get(target, property) {
      if (property === "spawn")
        return () => {
          throw new Error(
            "The paused Claude process is unavailable. Start a new turn.",
          );
        };
      const value = Reflect.get(target, property);
      if (property === "restricted" && typeof value === "function")
        return () => withoutRespawn(value.call(target));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Refresh the paused query without changing its prompt, replay cursor or tools. */
export function patchClaudeForwardingResume(source: string): string {
  if (source.includes(`var ${marker};`)) return source;
  const turn = "async function runTurn(start, turn) {";
  const control = '      case "abort":';
  const queryEnd = "  gracefulAbort = () => {";
  const cleanup = "    gracefulAbort = void 0;";
  if (
    ![turn, control, queryEnd, cleanup].every((needle) =>
      source.includes(needle),
    )
  )
    throw new Error(
      "Claude bridge does not support forwarding configuration refresh.",
    );
  return source
    .replace(turn, `var ${marker};\n${turn}`)
    .replace(
      control,
      `      case "mcpjam-refresh-mcp": {
        let ok = false;
        try {
          if (typeof msg.id !== "string" || msg.id.length > 64 || !${marker}) throw new Error("Unavailable");
          await ${marker}(msg.servers);
          ok = true;
        } catch {
          // The host receives a refusal; do not leak configuration or resume.
          ok = false;
        }
        sendControl(ws, { type: "mcpjam-mcp-refreshed", id: msg.id, ok });
        return;
      }
${control}`,
    )
    .replace(
      queryEnd,
      `  const refreshNativeMcp = async (servers) => {
    const keys = Object.keys(start.mcpServers ?? {}).sort();
    if (!servers || typeof servers !== "object" || Array.isArray(servers) ||
        JSON.stringify(Object.keys(servers).sort()) !== JSON.stringify(keys)) throw new Error("Server set changed");
    const refreshed = { ...mcpServers };
    for (const key of keys) {
      const entry = servers[key];
      const prior = start.mcpServers[key];
      if (entry?.type !== "http" || entry.url !== prior.url ||
          !entry.headers || Object.keys(entry.headers).length !== 2 ||
          entry.headers.Connection !== "close" ||
          typeof entry.headers["X-MCPJam-Forwarding-Context"] !== "string" ||
          entry.headers["X-MCPJam-Forwarding-Context"].length > ${2 * MAX_SEALED_PLAINTEXT_BYTES}) throw new Error("Invalid forwarding configuration");
      refreshed[key] = { ...prior, headers: entry.headers };
    }
    const result = await q.setMcpServers(refreshed);
    if (Object.keys(result.errors ?? {}).length) throw new Error("MCP refresh failed");
    Object.assign(mcpServers, refreshed);
  };
  ${marker} = refreshNativeMcp;
${queryEnd}`,
    )
    .replace(
      cleanup,
      `${cleanup}\n    if (${marker} === refreshNativeMcp) ${marker} = void 0;`,
    );
}

/** A side socket never sends start/resume and therefore never owns the stream. */
export async function refreshClaudeForwarding(args: {
  endpoint: { url: string; headers?: Readonly<Record<string, string>> };
  token: string;
  servers: HarnessMcpJson["mcpServers"];
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<void> {
  args.signal?.throwIfAborted();
  const endpoint = withBridgeToken({
    endpoint: args.endpoint,
    token: args.token,
  });
  const id = randomUUID();
  const payload = JSON.stringify({
    type: "mcpjam-refresh-mcp",
    id,
    servers: args.servers,
  });
  if (Buffer.byteLength(payload) > 1024 * 1024)
    throw new Error("Forwarding configuration exceeds the refresh limit.");
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(endpoint.url, { headers: endpoint.headers });
    let settled = false;
    let sent = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      args.signal?.removeEventListener("abort", abort);
      socket.terminate();
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new Error("Forwarding refresh was cancelled."));
    const timer = setTimeout(
      () => finish(new Error("Claude did not confirm the forwarding refresh.")),
      args.timeoutMs ?? 15_000,
    );
    args.signal?.addEventListener("abort", abort, { once: true });
    socket.once("error", () =>
      finish(new Error("Claude forwarding refresh connection failed.")),
    );
    socket.once("close", () =>
      finish(
        new Error("Claude closed before confirming the forwarding refresh."),
      ),
    );
    socket.on("message", (data) => {
      let value: unknown;
      try {
        value = JSON.parse(data.toString());
      } catch {
        finish(
          new Error("Claude returned an invalid forwarding refresh response."),
        );
        return;
      }
      if (
        !sent &&
        value &&
        typeof value === "object" &&
        "type" in value &&
        value.type === "bridge-hello"
      ) {
        sent = true;
        socket.send(payload);
        return;
      }
      if (!sent) return;
      const ack = response.safeParse(value);
      if (!ack.success || ack.data.id !== id) return;
      finish(
        ack.data.ok
          ? undefined
          : new Error("Claude refused the forwarding refresh."),
      );
    });
  });
}

export function withClaudeForwardingResume<T extends HarnessV1>(
  harness: T,
  servers: HarnessMcpJson["mcpServers"],
  policyDigest: string,
): T {
  return new Proxy(harness, {
    get(target, key) {
      if (key === "getBootstrap" && target.getBootstrap)
        return async (...args: Parameters<NonNullable<T["getBootstrap"]>>) => {
          const bootstrap = await target.getBootstrap!(...args);
          return {
            ...bootstrap,
            files: bootstrap.files.map((file) =>
              file.path.endsWith("/bridge.mjs")
                ? {
                    ...file,
                    content: patchClaudeForwardingResume(file.content),
                  }
                : file,
            ),
          };
        };
      if (key === "doStart")
        return async (options: Parameters<T["doStart"]>[0]) => {
          if (options.continueFrom) {
            const {
              data: { bridge, mcpjamForwardingPolicy },
            } = bridgeState.parse(options.continueFrom);
            if (mcpjamForwardingPolicy !== policyDigest)
              throw new Error("The pending turn's tool policy has changed.");
            if (!("getPortEndpoint" in options.sandboxSession))
              throw new Error(
                "Claude forwarding refresh needs a bridge endpoint.",
              );
            const endpoint = await options.sandboxSession.getPortEndpoint({
              port: bridge.port,
              protocol: "ws",
            });
            await refreshClaudeForwarding({
              endpoint,
              token: bridge.token,
              servers,
              signal: options.abortSignal,
            });
            // A lost paused bridge must never cause the adapter to rerun its turn.
            const sandboxSession = withoutRespawn(options.sandboxSession);
            return target.doStart({ ...options, sandboxSession });
          }
          return target.doStart(options);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
