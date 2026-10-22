import { createServer } from "node:net";
import { computeInstanceEnv } from "./runtime-profile.mjs";

export const DEFAULT_PORT = 6274;

// How many consecutive ports a launch without --port may try, so
// `npx @mcpjam/inspector` starts next to a running desktop app or another
// Inspector. The desktop app's embedded server imports this for its own walk.
export const DEFAULT_PORT_FALLBACK_ATTEMPTS = 10;

/**
 * Whether `port` can be bound on 127.0.0.1, the address the packaged server
 * binds outside Docker. Binds and releases at once.
 */
export function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

/**
 * The port this launch serves on.
 *
 * An explicit --port is exactly that port or nothing: the user named it, and
 * quietly serving elsewhere would leave whatever they pointed at it talking to
 * another process. The default only names where the walk starts.
 *
 * `isPortAvailable` probes and releases, so a small window remains between
 * the probe and the real bind; the server failing to bind still surfaces.
 */
export async function selectStartPort({
  requestedPort,
  explicit,
  isPortAvailable: probe = isPortAvailable,
  maxAttempts = DEFAULT_PORT_FALLBACK_ATTEMPTS,
}) {
  if (explicit) {
    if (await probe(requestedPort)) return requestedPort;
    throw new StartPortUnavailableError(
      `Explicitly requested port ${requestedPort} is not available`,
      "Use a different port with --port <number>, or omit --port to let MCPJam pick a free one",
    );
  }

  const lastPort = requestedPort + maxAttempts - 1;
  for (let port = requestedPort; port <= lastPort; port += 1) {
    if (await probe(port)) return port;
  }
  throw new StartPortUnavailableError(
    `Ports ${requestedPort}-${lastPort} are all in use`,
    "Free one of them, or pass --port <number>",
  );
}

export class StartPortUnavailableError extends Error {
  constructor(message, hint) {
    super(message);
    this.name = "StartPortUnavailableError";
    this.hint = hint;
  }
}

/**
 * Picks the launch port and derives every address that follows it, so none
 * of them can disagree with the port actually chosen. A PORT in `envVars`
 * (from --port or `-e PORT=`) makes the port explicit.
 *
 * The packaged server serves the app itself, so the browser port IS the
 * server port: it names this instance's session namespace, and the public
 * callback origins (CLI login, Slack/Discord linking) follow it. A configured
 * NON-loopback origin is a deliberate public deployment and is kept; a
 * loopback one from another port never survives.
 */
export async function resolveStartPortEnv({
  envVars,
  profile,
  isPortAvailable: probe = isPortAvailable,
}) {
  const requestedValue = envVars.PORT || String(DEFAULT_PORT);
  const requestedPort = Number(requestedValue);
  if (
    !/^\d+$/.test(requestedValue) ||
    requestedPort < 1 ||
    requestedPort > 65535
  ) {
    throw new Error(`Invalid port: ${requestedValue}`);
  }

  const port = await selectStartPort({
    requestedPort,
    explicit: envVars.PORT !== undefined,
    isPortAvailable: probe,
  });

  // Default: localhost in development, 127.0.0.1 in production
  const host =
    profile.HOST || (profile.ENVIRONMENT === "dev" ? "localhost" : "127.0.0.1");
  const instanceEnv = computeInstanceEnv({
    ports: { server: port },
    browserPort: port,
    host,
    profile,
  });
  return {
    requestedPort,
    port,
    env: {
      PORT: String(port),
      SERVER_PORT: String(port),
      BASE_URL: `http://${host}:${port}`,
      MCPJAM_BROWSER_PORT: instanceEnv.MCPJAM_BROWSER_PORT,
      CLI_AUTH_PUBLIC_ORIGIN: instanceEnv.CLI_AUTH_PUBLIC_ORIGIN,
      SLACK_LINK_PUBLIC_ORIGIN: instanceEnv.SLACK_LINK_PUBLIC_ORIGIN,
      DISCORD_LINK_PUBLIC_ORIGIN: instanceEnv.DISCORD_LINK_PUBLIC_ORIGIN,
    },
  };
}
