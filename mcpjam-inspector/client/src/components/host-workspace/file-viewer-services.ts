import type { WidgetHost } from "@mcpjam/widget-react";
import { createFileResourceBridge } from "@/components/plugin-workspace/file-resource-bridge";
import { describePluginError } from "@/lib/plugin-diagnostics";
import {
  PluginDescribedError,
  withPluginDeadline,
} from "@/shared/plugin-operation";
import type { ThreadAppApi, ThreadAppHandle } from "./thread-app-api";
import { logExtensionEvent } from "./extension-log";

/**
 * How long a viewer's file read or watch may take before MCPJam answers it
 * with a described error. OpenAI's App transport gives up on a request after
 * 15 seconds by default; answering first means the App can show why instead
 * of a bare timeout.
 */
export const FILE_VIEWER_REQUEST_DEADLINE_MS = 12_000;

/** Who the viewer belongs to, for its Logs entries. */
export interface FileViewerOwner {
  serverId: string;
  serverName?: string;
}

/** One retained viewer owns its bridge subscriptions, separate from presentation. */
export function createFileViewerServices(
  api: ThreadAppApi,
  handle: ThreadAppHandle,
  lifetime: AbortSignal,
  owner?: FileViewerOwner,
) {
  if (!handle.file) return undefined;
  const fileName = handle.file.name;
  let watching:
    | { controller: AbortController; ready: Promise<void> }
    | undefined;
  let watchError: unknown;
  const requireLive = () => {
    lifetime.throwIfAborted();
    if (watchError) throw watchError;
  };
  // The deadline names the step that ran out and says so in Logs; the App
  // gets the same plain sentence as its error.
  const expired =
    (code: "PLUGIN_FILE_READ_TIMEOUT" | "PLUGIN_FILE_WATCH_TIMEOUT") => () => {
      const message = describePluginError(code) ?? code;
      if (owner)
        logExtensionEvent({
          serverId: owner.serverId,
          ...(owner.serverName ? { serverName: owner.serverName } : {}),
          label: "file-viewer",
          level: "error",
          message: `${fileName}: ${message}`,
          detail: { code },
        });
      return new PluginDescribedError(message, code);
    };
  const bridge = createFileResourceBridge({
    uri: handle.file.resourceUri,
    capabilities: {
      write: handle.fileCapabilities?.write === true,
      subscribe: handle.fileCapabilities?.subscribe === true,
    },
    requireLive,
    send: async (method, params, signal) => {
      if (method === "unsubscribe-resource") {
        watching?.controller.abort();
        watching = undefined;
        watchError = undefined;
        return {};
      }
      requireLive();
      const active = signal ? AbortSignal.any([lifetime, signal]) : lifetime;
      if (method === "write-resource")
        return api.writeFile(handle, params, active);
      if (!watching) {
        const controller = new AbortController();
        const streaming = AbortSignal.any([lifetime, controller.signal]);
        let ready!: () => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<void>((resolve, fail) => {
          ready = resolve;
          reject = fail;
        });
        // Nobody may be waiting when the watch fails later; that failure
        // reaches the App through `watchError` on its next request.
        promise.catch(() => {});
        const current = { controller, ready: promise };
        watching = current;
        void api
          .watchFile(
            handle,
            (uri) => {
              void bridge.resourceUpdated(uri).catch((error) => {
                watchError = error;
                controller.abort();
              });
            },
            streaming,
            ready,
          )
          // A watch that ends before the server admitted it (stopped, or a
          // stream that closed without its ready line) never resolves the
          // subscription on its own; settle it so the App isn't left waiting.
          .then(() =>
            reject(new DOMException("File watch ended", "AbortError")),
          )
          .catch((error) => {
            reject(error);
            if (!streaming.aborted) watchError = error;
          });
      }
      const current = watching;
      try {
        await withPluginDeadline(
          active,
          FILE_VIEWER_REQUEST_DEADLINE_MS,
          expired("PLUGIN_FILE_WATCH_TIMEOUT"),
          () => current.ready,
        );
      } catch (error) {
        // An unadmitted watch is not kept: a later subscribe starts afresh.
        if (watching === current && !lifetime.aborted) {
          current.controller.abort();
          watching = undefined;
        }
        throw error;
      }
      requireLive();
      return {};
    },
  });
  const readResourceV2: NonNullable<
    WidgetHost["services"]["readResourceV2"]
  > = async (params, extra) => {
    requireLive();
    return withPluginDeadline(
      AbortSignal.any([lifetime, extra.signal]),
      FILE_VIEWER_REQUEST_DEADLINE_MS,
      expired("PLUGIN_FILE_READ_TIMEOUT"),
      (bounded) => api.readFile(handle, params, bounded),
    );
  };
  lifetime.addEventListener(
    "abort",
    () => {
      watching?.controller.abort();
      watching = undefined;
    },
    { once: true },
  );
  return { readResourceV2, configureAppBridge: bridge.configureAppBridge };
}
