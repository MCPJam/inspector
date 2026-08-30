/**
 * browserd's boot configuration, read from `envs` (the boot recipe passes the
 * per-boot token, port, and profile dir there). Kept separate from the
 * side-effectful entrypoint so the parsing — including the fail-closed rules —
 * is unit-testable.
 */

export interface BrowserdConfig {
  token: string;
  port: number;
  host: string;
  userDataDir: string;
  headless: boolean;
  /** `--window-size=W,H` matched to the X screen geometry, if the recipe set it. */
  windowSize?: string;
}

export const DEFAULT_BROWSERD_PORT = 8791;
export const DEFAULT_BROWSERD_HOST = "0.0.0.0";
export const DEFAULT_BROWSERD_USER_DATA_DIR = "/home/user/.mcpjam-browserd";

/**
 * Parse and validate the environment. Throws (fail closed) rather than falling
 * back to an insecure default when the token is missing: every `getHost` port is
 * public, so a tokenless daemon would be an open browser on the internet.
 */
export function readBrowserdConfig(
  env: NodeJS.ProcessEnv = process.env,
): BrowserdConfig {
  const token = env.MCPJAM_BROWSERD_TOKEN ?? "";
  if (token.length === 0) {
    throw new Error(
      "MCPJAM_BROWSERD_TOKEN is required — refusing to start an unauthenticated browser daemon on a public host",
    );
  }

  const rawPort = env.MCPJAM_BROWSERD_PORT;
  const port = rawPort === undefined ? DEFAULT_BROWSERD_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(
      `MCPJAM_BROWSERD_PORT must be a valid port (1-65535), got ${rawPort}`,
    );
  }

  return {
    token,
    port,
    host: env.MCPJAM_BROWSERD_HOST || DEFAULT_BROWSERD_HOST,
    userDataDir:
      env.MCPJAM_BROWSERD_USER_DATA_DIR || DEFAULT_BROWSERD_USER_DATA_DIR,
    headless: env.MCPJAM_BROWSERD_HEADLESS === "true",
    windowSize: env.MCPJAM_BROWSERD_WINDOW_SIZE || undefined,
  };
}

/** Extra Chromium args derived from config (e.g. the window-size pin). */
export function extraArgsFor(config: BrowserdConfig): string[] {
  return config.windowSize ? [`--window-size=${config.windowSize}`] : [];
}

/**
 * The one-line JSON the daemon prints to stdout once it is listening. The boot
 * recipe blocks on this line to learn the daemon is up and to capture its
 * bootId (mirrors the plugin shim's `{event:"listening",...}` ready-line).
 */
export function formatReadyLine(
  host: string,
  port: number,
  bootId: string,
): string {
  return JSON.stringify({ event: "listening", host, port, bootId });
}
