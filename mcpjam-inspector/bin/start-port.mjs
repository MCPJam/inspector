// How many consecutive ports a launch without --port may try: the same walk
// the desktop app's embedded server makes (`SERVER_PORT_FALLBACK_ATTEMPTS` in
// src/main.ts), so `npx @mcpjam/inspector` starts next to a running desktop
// app or another Inspector instead of refusing to start.
export const DEFAULT_PORT_FALLBACK_ATTEMPTS = 10;

/**
 * The port this launch serves on.
 *
 * An explicit --port is exactly that port or nothing: the user named it, and
 * quietly serving elsewhere would leave whatever they pointed at it talking to
 * another process. The default only names where the walk starts. Every address
 * the launcher derives afterwards (BASE_URL, session namespace, callback
 * origins) comes from the returned port, so none of them can disagree with it.
 *
 * `isPortAvailable` probes and releases, so a small window remains between
 * the probe and the real bind; the server failing to bind still surfaces.
 */
export async function selectStartPort({
  requestedPort,
  explicit,
  isPortAvailable,
  maxAttempts = DEFAULT_PORT_FALLBACK_ATTEMPTS,
}) {
  if (explicit) {
    if (await isPortAvailable(requestedPort)) return requestedPort;
    throw new StartPortUnavailableError(
      `Explicitly requested port ${requestedPort} is not available`,
      "Use a different port with --port <number>, or omit --port to let MCPJam pick a free one",
      requestedPort,
    );
  }

  const lastPort = Math.min(requestedPort + maxAttempts - 1, 65535);
  for (let port = requestedPort; port <= lastPort; port += 1) {
    if (await isPortAvailable(port)) return port;
  }
  throw new StartPortUnavailableError(
    lastPort === requestedPort
      ? `Default port ${requestedPort} is already in use`
      : `Ports ${requestedPort}-${lastPort} are all in use`,
    "Free one of them, or pass --port <number>",
    requestedPort,
  );
}

export class StartPortUnavailableError extends Error {
  constructor(message, hint, port) {
    super(message);
    this.name = "StartPortUnavailableError";
    this.hint = hint;
    this.port = port;
  }
}
