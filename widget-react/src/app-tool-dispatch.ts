import { callViewWebmcpTool } from "@mcpjam/sdk/widget-runtime";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { AppToolsRegistryState } from "./app-tools-registry";

/** Dispatch exactly once using the source selected at discovery. */
export async function dispatchAppToolCall(
  entry: NonNullable<ReturnType<AppToolsRegistryState["resolve"]>>,
  args: Record<string, unknown>,
  options?: {
    signal?: AbortSignal;
    /** Stop waiting without cancelling the dispatched wire request. */
    waitSignal?: AbortSignal;
    /** Observe the dispatched operation, even when its waiter is cancelled. */
    onSettled?: (outcome: PromiseSettledResult<CallToolResult>) => void;
  },
) {
  const signal =
    options?.signal && options.waitSignal
      ? AbortSignal.any([options.signal, options.waitSignal])
      : options?.signal ?? options?.waitSignal;
  signal?.throwIfAborted();
  let call: Promise<CallToolResult>;
  try {
    call =
      entry.instance.toolSource === "webmcp"
        ? callViewWebmcpTool(entry.bridge, entry.rawName, args, {
            signal: options?.signal,
          })
        : entry.bridge.callTool({ name: entry.rawName, arguments: args });
  } catch (reason) {
    options?.onSettled?.({ status: "rejected", reason });
    throw reason;
  }
  const completed = call.then(
    (value) => {
      options?.onSettled?.({ status: "fulfilled", value });
      return value;
    },
    (reason) => {
      options?.onSettled?.({ status: "rejected", reason });
      throw reason;
    },
  );
  if (!signal) return completed;
  return new Promise<CallToolResult>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(
        signal.reason ?? new Error("The app closed before the tool finished. Open the app and try again."),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    completed
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
