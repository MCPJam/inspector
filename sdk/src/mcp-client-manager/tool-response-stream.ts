import type {
  JSONRPCMessage,
  MessageExtraInfo,
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/client";

/** The transport owns resumability; a terminal missing response rejects only
 * that request's send promise, which the protocol already observes. */
export function guardToolResponseStreams(inner: Transport): Transport {
  class GuardedTransport implements Transport {
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage, extra?: MessageExtraInfo) => void;
    private pending = new Map<string | number, {
      resolve: () => void;
      reject: (error: Error) => void;
      cleanup: () => void;
    }>();

    constructor() {
      inner.onmessage = (message, extra) => {
        if (!("method" in message) && "id" in message &&
          (typeof message.id === "string" || typeof message.id === "number"))
          this.settle(message.id);
        this.onmessage?.(message, extra);
      };
      inner.onclose = () => {
        for (const id of this.pending.keys()) this.settle(id);
        this.onclose?.();
      };
      inner.onerror = error => this.onerror?.(error);
    }

    private settle(id: string | number, error?: Error) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      pending?.cleanup();
      if (error) pending?.reject(error);
      else pending?.resolve();
    }

    start() { return inner.start(); }
    close() { return inner.close(); }
    get sessionId() { return inner.sessionId; }
    get hasPerRequestStream() { return inner.hasPerRequestStream; }
    setProtocolVersion(version: string) { inner.setProtocolVersion?.(version); }
    setSupportedProtocolVersions(versions: string[]) {
      inner.setSupportedProtocolVersions?.(versions);
    }

    async send(message: JSONRPCMessage, options?: TransportSendOptions) {
      if ("method" in message && message.method === "notifications/cancelled") {
        const id = message.params?.requestId;
        if (typeof id === "string" || typeof id === "number") this.settle(id);
      }
      if (!("method" in message) || message.method !== "tools/call" || !("id" in message))
        return inner.send(message, options);
      const id = message.id;
      const onAbort = () => this.settle(id);
      const completed = new Promise<void>((resolve, reject) => {
        this.pending.set(id, { resolve, reject,
          cleanup: () => options?.requestSignal?.removeEventListener("abort", onAbort) });
      });
      options?.requestSignal?.addEventListener("abort", onAbort, { once: true });
      try {
        await Promise.all([completed, inner.send(message, {
          ...options,
          onRequestStreamEnd: () => {
            const unfinished = this.pending.has(id);
            try { options?.onRequestStreamEnd?.(); }
            finally {
              this.settle(id, unfinished
                ? new Error("Tool response stream ended before a result") : undefined);
            }
          },
        })]);
      } catch (error) {
        this.settle(id);
        throw error;
      }
    }
  }
  return new GuardedTransport();
}
