/**
 * browserd's boot configuration, read from `envs` (the boot recipe passes the
 * per-boot token, port, and profile dir there). Kept separate from the
 * side-effectful entrypoint so the parsing — including the fail-closed rules —
 * is unit-testable.
 */
// `node:*` builtins are the one import class the bundler allows here; the
// artifact runs on a box with nothing but its own bytes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";


export interface BrowserdConfig {
  token: string;
  port: number;
  host: string;
  userDataDir: string;
  headless: boolean;
  /** `--window-size=W,H` matched to the X screen geometry, if the recipe set it. */
  windowSize?: string;
  /**
   * `ephemeral` launches a throwaway browser with NO persistent profile
   * (evals/swarms: fresh state per iteration, so one iteration's cookies can
   * never decide the next one's verdict). `persistent` keeps the profile dir,
   * which is what makes a playground login survive between turns.
   *
   * The singleton lock (L8) is a property of the persistent profile DIRECTORY,
   * so it simply does not apply in ephemeral mode — nothing is shared to lock.
   */
  contextMode: "persistent" | "ephemeral";
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
    // Only the exact string opts in. An unset or misspelled value keeps the
    // persistent profile — the mode a human's logins depend on — rather than
    // silently wiping state because a typo read as "ephemeral".
    contextMode:
      env.MCPJAM_BROWSERD_EPHEMERAL === "true" ? "ephemeral" : "persistent",
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
  /**
   * The wire compatibility number the boot recipe records with the session.
   *
   * Optional in the SIGNATURE, not in practice: a caller that omits it prints
   * the line a pre-V-4a daemon printed, which is exactly what a test asserting
   * backwards compatibility needs to build.
   */
  protocolVersion?: number,
): string {
  return JSON.stringify({
    event: "listening",
    host,
    port,
    bootId,
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
  });
}

/**
 * The sha256 of the running bundle, read once at boot.
 *
 * Of `process.argv[1]` — the artifact this process was started from — because
 * the daemon is a single bundled file and nothing else about it identifies the
 * bytes. Best-effort: a daemon that cannot read its own file still runs, it
 * simply cannot offer an upgrade decision, and the caller treats a missing
 * hash exactly as it treats a backend too old to store one.
 */
export function readBundleHash(
  argv: readonly string[] = process.argv,
  hashFile: (path: string) => string | undefined = defaultHashFile,
): string | undefined {
  const entry = argv[1];
  if (!entry) return undefined;
  try {
    return hashFile(entry);
  } catch {
    return undefined;
  }
}

function defaultHashFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
