import type {
  MCPClientManager,
  MCPServerConfig,
} from "../mcp-client-manager/index.js";
import {
  withEphemeralClient,
  type WithEphemeralClientOptions,
} from "../operations.js";
import { withAbortSignalFetch } from "../abort-signal.js";

/** Cancellation closes the connection and drains the interrupted checks. */
export async function withTasksClient<T>(
  config: MCPServerConfig,
  fn: (manager: MCPClientManager, serverId: string) => Promise<T>,
  options: WithEphemeralClientOptions
): Promise<T> {
  const signal = options.signal;
  if (!signal) return withEphemeralClient(config, fn, options);
  let work: Promise<T> | undefined;
  const pending = new Set<Promise<Response>>();
  const abortableFetch = withAbortSignalFetch(
    config.baseFetch ?? fetch,
    signal
  );
  const trackedFetch: typeof fetch = (input, init) => {
    const request = abortableFetch(input, init);
    pending.add(request);
    const settled = () => {
      pending.delete(request);
    };
    void request.then(settled, settled);
    return request;
  };
  try {
    return await withEphemeralClient(
      {
        ...config,
        baseFetch: trackedFetch,
      },
      (manager, serverId) => {
        signal.throwIfAborted();
        work = fn(manager, serverId);
        return work;
      },
      options
    );
  } finally {
    // The lifecycle helper already reports cancellation and closes the client.
    // Drain its callback too, so no check continues into the next group.
    if (signal.aborted) {
      if (work) await Promise.allSettled([work]);
      await Promise.allSettled([...pending]);
    }
  }
}
