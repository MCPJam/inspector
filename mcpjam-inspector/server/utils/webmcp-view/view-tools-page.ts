import { WEBMCP_APP_CONTRACT } from "@mcpjam/sdk/widget-runtime";

interface Relay {
  configure(enabled: boolean): void;
  reset(): void;
  host(message: unknown): boolean;
  view(message: unknown): boolean;
}
declare function createWebmcpRelay(options: {
  send: (message: unknown) => void;
  post: (message: unknown) => void;
  live: () => boolean;
}): Relay;

export interface ViewToolsPageApi {
  list(viewId: string, requestId: string): Promise<unknown>;
  call(
    viewId: string,
    requestId: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown>;
  cancel(viewId: string, requestId: string): void;
}
declare global {
  interface Window {
    __mcpjamViewTools: ViewToolsPageApi;
  }
}

/** The same relay as the sandbox proxy, with a local promise as its host. */
export function createViewToolsPage() {
  const mounts = new Map<
    string,
    {
      relay: Relay;
      pending: Map<
        string,
        { resolve: (value: unknown) => void; reject: (error: Error) => void }
      >;
    }
  >();
  function request(
    viewId: string,
    requestId: string,
    method: string,
    params?: object,
  ) {
    const mount = mounts.get(viewId);
    if (!mount)
      return Promise.reject(new Error("View replaced; list view tools again"));
    return new Promise<unknown>((resolve, reject) => {
      mount.pending.set(requestId, { resolve, reject });
      mount.relay.host({ jsonrpc: "2.0", id: requestId, method, params });
    });
  }
  window.__mcpjamViewTools = {
    list: (viewId, requestId) =>
      request(viewId, requestId, WEBMCP_APP_CONTRACT.list),
    call: (viewId, requestId, name, args) =>
      request(viewId, requestId, WEBMCP_APP_CONTRACT.call, {
        name,
        arguments: args,
      }),
    cancel(viewId, requestId) {
      const mount = mounts.get(viewId);
      mount?.relay.host({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId },
      });
      mount?.pending.get(requestId)?.reject(new Error("View tool cancelled"));
      mount?.pending.delete(requestId);
    },
  };
  return {
    attach(viewId: string, iframe: HTMLIFrameElement) {
      const pending = new Map<
        string,
        { resolve: (value: unknown) => void; reject: (error: Error) => void }
      >();
      const relay = createWebmcpRelay({
        send: (message) => iframe.contentWindow?.postMessage(message, "*"),
        live: () => iframe.isConnected,
        post(message) {
          if (
            !message ||
            typeof message !== "object" ||
            !("id" in message) ||
            typeof message.id !== "string"
          )
            return;
          const waiter = pending.get(message.id);
          if (!waiter) return;
          pending.delete(message.id);
          if ("error" in message)
            waiter.reject(new Error("View tool request failed"));
          else waiter.resolve("result" in message ? message.result : undefined);
        },
      });
      relay.configure(true);
      mounts.set(viewId, { relay, pending });
      const receive = (event: MessageEvent) => {
        if (event.source === iframe.contentWindow) relay.view(event.data);
      };
      window.addEventListener("message", receive);
      return () => {
        relay.reset();
        window.removeEventListener("message", receive);
        if (mounts.get(viewId)?.relay === relay) mounts.delete(viewId);
      };
    },
  };
}
