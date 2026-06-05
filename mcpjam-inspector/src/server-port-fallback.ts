import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";

export type HonoFetch = (
  request: Request,
  ...args: unknown[]
) => Response | Promise<Response>;

export interface HonoAppLike {
  fetch: HonoFetch;
}

export interface PortListenResult {
  server: ServerType;
  port: number;
}

export interface TryListenOptions {
  /**
   * Override the underlying `serve` implementation. Used by tests to inject
   * deterministic success/failure behavior without binding real sockets.
   */
  serveImpl?: typeof serve;
  /**
   * Optional callback invoked with `(port, error)` each time a port attempt
   * fails. Useful for logging in production callers without bloating the
   * helper's surface.
   */
  onAttemptFailed?: (port: number, error: NodeJS.ErrnoException) => void;
}

/**
 * Attempt to bind a Hono server to `startPort`, falling back to `startPort + 1`,
 * `startPort + 2`, ..., up to `maxAttempts` total. Returns the first successful
 * bind. If all attempts fail, throws an AggregateError-shaped Error whose message
 * lists every port tried.
 *
 * Bind failures are detected via the `error` event on the returned server (the
 * common case is `EADDRINUSE` from a stale orphan process). Non-EADDRINUSE
 * errors are still treated as attempt failures so we keep trying other ports.
 *
 * The successful server has its bind-time `error` listener removed before
 * returning so the caller can attach their own.
 */
export async function tryListenWithFallback(
  honoApp: HonoAppLike,
  hostname: string,
  startPort: number,
  maxAttempts: number,
  options: TryListenOptions = {},
): Promise<PortListenResult> {
  const serveFn = options.serveImpl ?? serve;
  const errors: Array<{ port: number; error: NodeJS.ErrnoException }> = [];

  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    try {
      const server = await listenOnce(serveFn, honoApp, hostname, port);
      return { server, port };
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      errors.push({ port, error });
      options.onAttemptFailed?.(port, error);
    }
  }

  const tried = errors
    .map(({ port, error }) => `${port} (${error.code ?? error.message})`)
    .join(", ");
  throw new Error(
    `Failed to bind server after ${maxAttempts} attempts starting at port ${startPort}. Tried: ${tried}`,
  );
}

function listenOnce(
  serveFn: typeof serve,
  honoApp: HonoAppLike,
  hostname: string,
  port: number,
): Promise<ServerType> {
  return new Promise<ServerType>((resolve, reject) => {
    let settled = false;

    let server: ServerType;
    try {
      server = serveFn(
        {
          fetch: honoApp.fetch as Parameters<typeof serve>[0]["fetch"],
          port,
          hostname,
        },
        () => {
          if (settled) return;
          settled = true;
          server.removeListener("error", onError);
          resolve(server);
        },
      );
    } catch (err) {
      // Some failure modes (e.g. synchronous validation inside serve) surface
      // as a thrown error instead of an error event.
      reject(err);
      return;
    }

    const onError = (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      try {
        server.close?.();
      } catch {
        // best-effort cleanup; the listen failed so close may also throw
      }
      reject(err);
    };

    server.on("error", onError);
  });
}
