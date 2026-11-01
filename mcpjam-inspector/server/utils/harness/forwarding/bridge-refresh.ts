import type { HarnessV1 } from "@ai-sdk/harness";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { z } from "zod";
import { withBridgeToken } from "@ai-sdk/harness/utils";
import type { HarnessMcpJson } from "../mcp-config.js";
const response = z.object({
  type: z.literal("mcpjam-mcp-refreshed"),
  id: z.string(),
  ok: z.boolean(),
});

/** A side socket never sends start/resume and therefore never owns the stream. */
export async function refreshForwardingBridge(args: {
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
      () =>
        finish(
          new Error("The runtime did not confirm the forwarding refresh."),
        ),
      args.timeoutMs ?? 15_000,
    );
    args.signal?.addEventListener("abort", abort, { once: true });
    socket.once("error", () =>
      finish(new Error("Forwarding refresh connection failed.")),
    );
    socket.once("close", () =>
      finish(
        new Error(
          "The runtime closed before confirming the forwarding refresh.",
        ),
      ),
    );
    socket.on("message", (data) => {
      let value: unknown;
      try {
        value = JSON.parse(data.toString());
      } catch {
        finish(
          new Error(
            "The runtime returned an invalid forwarding refresh response.",
          ),
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
          : new Error("The runtime refused the forwarding refresh."),
      );
    });
  });
}

const bridgeState = z.object({
  data: z.object({
    bridge: z.object({
      port: z.number().int().positive(),
      token: z.string().min(1),
    }),
    mcpjamForwardingPolicy: z.string().min(1),
  }),
});
function withoutRespawn<T extends object>(sandbox: T): T {
  return new Proxy(sandbox, {
    get(target, property) {
      if (property === "spawn")
        return () => {
          throw new Error(
            "The paused harness process is unavailable. Start a new turn.",
          );
        };
      const value = Reflect.get(target, property);
      if (property === "restricted" && typeof value === "function")
        return () => withoutRespawn(value.call(target));
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function withForwardingResume<T extends HarnessV1>(
  harness: T,
  servers: HarnessMcpJson["mcpServers"],
  policyDigest: string,
  patchBootstrap?: (source: string) => string,
): T {
  return new Proxy(harness, {
    get(target, key) {
      if (key === "getBootstrap" && target.getBootstrap && patchBootstrap)
        return async (...args: Parameters<NonNullable<T["getBootstrap"]>>) => {
          const bootstrap = await target.getBootstrap!(...args);
          return {
            ...bootstrap,
            files: bootstrap.files.map((file) =>
              file.path.endsWith("/bridge.mjs")
                ? {
                    ...file,
                    content: patchBootstrap(file.content),
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
              throw new Error("Forwarding refresh needs a bridge endpoint.");
            const endpoint = await options.sandboxSession.getPortEndpoint({
              port: bridge.port,
              protocol: "ws",
            });
            await refreshForwardingBridge({
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
