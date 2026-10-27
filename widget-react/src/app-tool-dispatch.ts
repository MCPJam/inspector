import { callViewWebmcpTool } from "@mcpjam/sdk/widget-runtime";
import type { AppToolsRegistryState } from "./app-tools-registry";

/** Dispatch exactly once using the source selected at discovery. */
export async function dispatchAppToolCall(
  entry: NonNullable<ReturnType<AppToolsRegistryState["resolve"]>>,
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) {
  options?.signal?.throwIfAborted();
  const call =
    entry.instance.toolSource === "webmcp"
      ? callViewWebmcpTool(entry.bridge, entry.rawName, args, options)
      : entry.bridge.callTool({ name: entry.rawName, arguments: args });
  const signal = options?.signal;
  if (!signal) return call;
  return new Promise<Awaited<typeof call>>((resolve, reject) => {
    const abort = () =>
      reject(
        signal.reason ?? new Error("App iframe was torn down mid-dispatch"),
      );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    call
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
