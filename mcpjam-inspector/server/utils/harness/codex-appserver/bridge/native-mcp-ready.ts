import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod/v4";
import type { NativeMcpRuntime } from "./native-mcp-refresh.js";
import { RELAY_MCP_SERVER_NAME } from "../shared/tool-names.js";

const inventory = z.object({
  nextCursor: z.string().nullish(),
  data: z.array(
    z.object({
      name: z.string(),
      runtimeStatus: z.string().nullish(),
      toolsError: z.unknown().optional(),
      tools: z.record(z.string(), z.unknown()).nullish(),
    }),
  ),
});

/** Codex also discovers the retained host-tool relay asynchronously. */
export async function waitForMcpStartup(
  args: Parameters<typeof waitForNativeMcpServers>[0] & { threadId: string },
) {
  await waitForNativeMcpServers({
    ...args,
    serverNames: [RELAY_MCP_SERVER_NAME, ...args.serverNames],
  });
}

/** Do not start the model against an MCP catalog that is still initializing. */
export async function waitForNativeMcpServers(args: {
  runtime: NativeMcpRuntime;
  threadId?: string;
  serverNames: string[];
  removedServerNames?: string[];
  signal?: AbortSignal;
  timeoutMs?: number;
  reload?: boolean;
}) {
  const signal = AbortSignal.any([
    ...(args.signal ? [args.signal] : []),
    AbortSignal.timeout(args.timeoutMs ?? 30_000),
  ]);
  let onAbort = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Native MCP startup interrupted"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    await Promise.race([
      aborted,
      (async () => {
        if (args.reload)
          await args.runtime.request("config/mcpServer/reload", {});
        if (!args.threadId) return;
        const removed = new Set(args.removedServerNames);
        while (removed.size) {
          let cursor: string | undefined;
          let stillPresent = false;
          do {
            signal.throwIfAborted();
            const page = inventory.parse(await args.runtime.request("mcpServerStatus/list", {
              threadId: args.threadId, detail: "toolsAndAuthOnly", ...(cursor ? { cursor } : {}),
            }));
            stillPresent = page.data.some(server => removed.has(server.name));
            cursor = page.nextCursor ?? undefined;
          } while (!stillPresent && cursor);
          if (!stillPresent) break;
          await delay(100, undefined, { signal });
        }
        for (const serverName of args.serverNames) {
          while (true) {
            signal.throwIfAborted();
            const result = inventory.parse(
              await args.runtime.request("mcpServerStatus/list", {
                threadId: args.threadId,
                serverName,
                detail: "toolsAndAuthOnly",
              }),
            );
            const server = result.data.find((row) => row.name === serverName);
            if (server?.toolsError != null)
              throw new Error("MCP inventory failed");
            if (server?.runtimeStatus === "connected" && server.tools) break;
            await delay(100, undefined, { signal });
          }
        }
      })(),
    ]);
  } catch {
    // The caller retires the runtime and rejects outstanding control requests.
    throw new Error("The configured native MCP servers did not become ready.");
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
