import type { MCPClientManager } from "@mcpjam/sdk";

/** One authenticated HTTP stream owns the MCP connection and its subscription. */
export async function streamListedFileUpdates(options: {
  manager: Pick<
    MCPClientManager,
    "onResourceUpdated" | "subscribeResource" | "unsubscribeResource"
  >;
  serverId: string;
  sourceUri: string;
  publicUri: string;
  signal: AbortSignal;
  authorize(): Promise<void>;
  emit(uri: string): Promise<void>;
  ready?(): Promise<void>;
}) {
  const { signal, manager, serverId, sourceUri } = options;
  signal.throwIfAborted();
  await options.authorize();
  signal.throwIfAborted();
  let live = true;
  let failed: unknown;
  let end!: () => void;
  const finished = new Promise<void>((resolve) => {
    end = resolve;
  });
  let delivery = Promise.resolve();
  let delivering = false;
  let dirty = false;
  const stop = () => end();
  signal.addEventListener("abort", stop, { once: true });
  manager.onResourceUpdated(serverId, (notification) => {
    if (!live || signal.aborted || notification.params?.uri !== sourceUri)
      return;
    dirty = true;
    if (delivering) return;
    delivering = true;
    delivery = (async () => {
      while (dirty && live && !signal.aborted) {
        dirty = false;
        await options.authorize();
        signal.throwIfAborted();
        if (live) await options.emit(options.publicUri);
      }
    })()
      .catch((error) => {
        failed = error;
        end();
      })
      .finally(() => {
        delivering = false;
      });
  });
  let subscribed = false;
  try {
    await manager.subscribeResource(serverId, { uri: sourceUri }, { signal });
    subscribed = true;
    signal.throwIfAborted();
    await options.authorize();
    signal.throwIfAborted();
    await options.ready?.();
    await finished;
  } finally {
    live = false;
    signal.removeEventListener("abort", stop);
    // This connection is request-owned and disconnected by the route even when
    // unsubscribe fails. Never retain a callback capable of delivery afterward.
    if (subscribed)
      await manager
        .unsubscribeResource(
          serverId,
          { uri: sourceUri },
          { signal: AbortSignal.timeout(3000) },
        )
        .catch(() => {});
    await delivery;
  }
  if (failed) throw failed;
}
