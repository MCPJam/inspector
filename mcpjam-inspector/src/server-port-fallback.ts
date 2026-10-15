import net from "net";

export interface ProbeFreePortOptions {
  /**
   * Optional callback invoked with `(port, error)` each time a probe attempt
   * fails. Useful for logging in production callers without bloating the
   * helper's surface.
   */
  onAttemptFailed?: (port: number, error: NodeJS.ErrnoException) => void;
  /**
   * Override the underlying net implementation. Tests inject a deterministic
   * stand-in via this hook; production callers should never pass it.
   */
  createServerImpl?: typeof net.createServer;
}

/**
 * The port probing starts from: `SERVER_PORT` when the environment names a
 * valid one, else `fallback`.
 *
 * `scripts/electron-dev.mjs` sets it to the free port it already pointed the
 * renderer's `/api` proxy at, so main and renderer agree on which embedded
 * server the window talks to. A packaged app honours an operator's
 * `SERVER_PORT` the same way. Anything else (unset, empty, not a port) keeps
 * the long-standing default.
 */
export function resolveServerStartPort(
  env: NodeJS.ProcessEnv,
  fallback: number,
): number {
  const raw = env.SERVER_PORT?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return fallback;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : fallback;
}

/**
 * Set by `scripts/electron-dev.mjs` when the renderer's `/api` proxy already
 * targets SERVER_PORT exactly.
 */
export const SERVER_PORT_PINNED_ENV = "MCPJAM_SERVER_PORT_PINNED";

/**
 * How many consecutive ports main may try. When the launcher pinned the
 * renderer to SERVER_PORT, exactly one: binding the next port instead would
 * leave the window calling whichever process owns SERVER_PORT, i.e. another
 * Inspector. Failing loudly (the recovery dialog) is the only safe outcome.
 * Otherwise the long-standing fallback walk applies.
 */
export function resolveServerPortAttempts(
  env: NodeJS.ProcessEnv,
  fallbackAttempts: number,
): number {
  return env[SERVER_PORT_PINNED_ENV] === "1" ? 1 : fallbackAttempts;
}

/**
 * Probe `startPort`, `startPort + 1`, ..., up to `maxAttempts` total, looking
 * for one that is free to bind on `hostname`. Returns the first port that
 * binds successfully (immediately closing the probe server before returning).
 *
 * This intentionally probes with a bare `net` server instead of binding the
 * real Hono app. The reason: `server/config.ts` reads `SERVER_PORT` from
 * `process.env` at module-load time, so the picked port must be known
 * BEFORE `createHonoApp()` runs. The probe gives us that port without paying
 * the cost of constructing a partial Hono app per attempt — and avoids
 * leaving CORS/origin allowlists out of sync with the bound port (see PR
 * #2418 review).
 *
 * A small TOCTOU window remains between probe-close and the real
 * `serve(...)`. Callers should still handle the rare race by surfacing the
 * failure to the user (this is what the recovery dialog in `main.ts` is for).
 */
export async function probeFreePort(
  hostname: string,
  startPort: number,
  maxAttempts: number,
  options: ProbeFreePortOptions = {},
): Promise<number> {
  const createServer = options.createServerImpl ?? net.createServer;
  const errors: Array<{ port: number; error: NodeJS.ErrnoException }> = [];

  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    try {
      await probeOnce(createServer, hostname, port);
      return port;
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
    `No free port available after ${maxAttempts} attempts starting at port ${startPort}. Tried: ${tried}`,
  );
}

function probeOnce(
  createServer: typeof net.createServer,
  hostname: string,
  port: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const server = createServer();

    const onError = (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      try {
        server.close();
      } catch {
        // best-effort cleanup
      }
      reject(err);
    };

    server.once("error", onError);
    server.listen(port, hostname, () => {
      if (settled) return;
      settled = true;
      server.removeListener("error", onError);
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolve();
      });
    });
  });
}
