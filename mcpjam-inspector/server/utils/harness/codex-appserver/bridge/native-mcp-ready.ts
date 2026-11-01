import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod/v4";
import type { NativeMcpRuntime } from "./native-mcp-refresh.js";

const inventory = z.object({
  data: z.array(
    z.object({
      name: z.string(),
      runtimeStatus: z.string().nullish(),
      toolsError: z.unknown().optional(),
      tools: z.record(z.string(), z.unknown()).nullish(),
    }),
  ),
});

/** Do not start the model against an MCP catalog that is still initializing. */
export async function waitForNativeMcpServers(args: {
  runtime: NativeMcpRuntime;
  threadId?: string;
  serverNames: string[];
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
