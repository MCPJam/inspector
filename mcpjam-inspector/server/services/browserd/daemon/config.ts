/**
 * browserd's boot configuration, read from `envs` (the boot recipe passes the
 * per-boot token, port, and profile dir there). Kept separate from the
 * side-effectful entrypoint so the parsing — including the fail-closed rules —
 * is unit-testable.
 */
// `node:*` builtins are the one import class the bundler allows here; the
// artifact runs on a box with nothing but its own bytes.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";

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
  /**
   * Put Chromium in kiosk mode, filling the X display.
   *
   * What the video encoder needs to be true: it grabs the whole display, so
   * "the display IS the page" only holds if the window covers it with no
   * chrome. Off by default — a box booted without it is fine, it simply
   * refuses video (`display_mismatch`) rather than streaming a misaligned
   * picture.
   */
  kiosk: boolean;
  /**
   * Device pixels per CSS pixel for the browser.
   *
   * Applied ONLY to a persistent context. An ephemeral one is an eval or a
   * swarm iteration, where a screenshot on one host has to match a screenshot
   * on another (L5) — so its scale factor stays pinned at 1 whatever this says,
   * and the two never diverge.
   */
  deviceScaleFactor: number;
  /**
   * Where recordings are written, one MP4 per take.
   *
   * A directory rather than a file: the id names the file, and the inspector
   * reads it back over the same E2B files API that put the daemon's own bytes
   * there. Under the user data dir by default so a box with a writable profile
   * has a writable recording dir for free.
   */
  recordDir: string;
  /**
   * The size ffmpeg stops itself at (`-fs`).
   *
   * Below the evidence pipe's 64 MiB upload limit, with room for the fragment
   * being written when the cap lands. A take that hits it is TRUNCATED, not
   * dropped — the fragmented container keeps it playable and the caller says
   * so beside it.
   */
  recordMaxBytes: number;
  /**
   * May this daemon record at all?
   *
   * The operator's kill switch. Off means `/v1/status.features` omits
   * `"record"`, so the inspector never asks — the same announced-capability
   * rule the video encoder follows.
   */
  recordingEnabled: boolean;
  /**
   * Where to write a freshly-minted token, when none was supplied.
   *
   * The prelaunch case: a daemon baked into the image has no inspector to hand
   * it a secret, so it mints its own and leaves it in a file only `user` can
   * read. The inspector reads it back over the E2B files API — the same
   * API-key-authenticated channel that already writes the daemon's own bytes.
   */
  tokenFile?: string;
  /** Did the box start this daemon, or did an inspector replica? */
  startedBy: "prelaunch" | "inspector";
}

export const DEFAULT_BROWSERD_PORT = 8791;
export const DEFAULT_BROWSERD_HOST = "0.0.0.0";
export const DEFAULT_BROWSERD_USER_DATA_DIR = "/home/user/.mcpjam-browserd";

/**
 * The default size cap for one recording.
 *
 * 60 MiB against the evidence pipe's 64 MiB ceiling
 * (`MAX_REPLAY_VIDEO_BYTES`), leaving room for the fragment in flight when
 * `-fs` lands. Chosen on the SAFE side because the failure it prevents —
 * discovering an oversized file at upload time, where the only options left
 * are dropping the evidence or failing the run — is worse than a recording
 * that stops early and says so.
 */
export const DEFAULT_BROWSERD_RECORD_MAX_BYTES = 60 * 1024 * 1024;

/**
 * Parse and validate the environment. Throws (fail closed) rather than falling
 * back to an insecure default when the token is missing: every `getHost` port is
 * public, so a tokenless daemon would be an open browser on the internet.
 */
export function readBrowserdConfig(
  env: NodeJS.ProcessEnv = process.env,
  /**
   * Mint and persist a token. Injected so the fail-closed rules stay testable
   * without a filesystem.
   */
  mintToken: (path: string) => string = defaultMintToken,
): BrowserdConfig {
  const supplied = env.MCPJAM_BROWSERD_TOKEN ?? "";
  const tokenFile = env.MCPJAM_BROWSERD_TOKEN_FILE?.trim() || undefined;
  // A token FILE is the prelaunch path: the box started this daemon and there
  // was no inspector to hand it a secret. Minting one here is not a weakening
  // of the rule below — it is still 32 random bytes, and it still never
  // travels over anything but the E2B files API, which is authenticated with
  // the team's own key.
  const token =
    supplied.length > 0 ? supplied : tokenFile ? mintToken(tokenFile) : "";
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

  const headless = env.MCPJAM_BROWSERD_HEADLESS === "true";

  return {
    token,
    port,
    host: env.MCPJAM_BROWSERD_HOST || DEFAULT_BROWSERD_HOST,
    userDataDir:
      env.MCPJAM_BROWSERD_USER_DATA_DIR || DEFAULT_BROWSERD_USER_DATA_DIR,
    headless,
    windowSize: env.MCPJAM_BROWSERD_WINDOW_SIZE || undefined,
    // Only the exact string opts in. An unset or misspelled value keeps the
    // persistent profile — the mode a human's logins depend on — rather than
    // silently wiping state because a typo read as "ephemeral".
    contextMode:
      env.MCPJAM_BROWSERD_EPHEMERAL === "true" ? "ephemeral" : "persistent",
    // NEVER WITH HEADLESS. Kiosk is what makes "the display IS the page" true
    // for the video encoder, and a headless Chromium draws on no display at
    // all — so the daemon would advertise `h264`, spawn a grab of an empty X
    // screen, and hand every watcher a picture of nothing. The two are
    // contradictory rather than merely unusual, so the one that decides
    // whether there is a picture wins.
    kiosk: env.MCPJAM_BROWSERD_KIOSK === "1" && !headless,
    deviceScaleFactor: readDeviceScaleFactor(env),
    recordDir:
      env.MCPJAM_BROWSERD_RECORD_DIR?.trim() ||
      `${env.MCPJAM_BROWSERD_USER_DATA_DIR || DEFAULT_BROWSERD_USER_DATA_DIR}/recordings`,
    recordMaxBytes: readRecordMaxBytes(env),
    // Only the exact string disables it, matching every other switch here: a
    // typo must not silently cost a run its evidence.
    recordingEnabled: env.MCPJAM_BROWSERD_RECORD !== "0",
    ...(tokenFile ? { tokenFile } : {}),
    // Only a daemon that had to mint its own token was started by the box.
    startedBy: supplied.length === 0 && tokenFile ? "prelaunch" : "inspector",
  };
}

/**
 * How many device pixels per CSS pixel.
 *
 * Anything unparseable, out of range, or non-positive falls back to 1 rather
 * than throwing: this is a sharpness knob, and refusing to boot a browser over
 * a mistyped environment variable trades a slightly soft picture for no
 * picture at all. Bounded above because the encoder's cost is quadratic in it.
 */
function readDeviceScaleFactor(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.MCPJAM_BROWSERD_DPR);
  if (!Number.isFinite(raw) || raw < 1 || raw > 3) return 1;
  return raw;
}

/**
 * The recording size cap, in bytes.
 *
 * LENIENT like `readDeviceScaleFactor`, and for the same reason: this is a
 * bound on evidence, and refusing to boot a browser over a mistyped
 * environment variable trades a shorter recording for no browser at all.
 * Bounded above by the evidence pipe's own limit, because a value past it
 * produces a file nothing can accept.
 */
function readRecordMaxBytes(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.MCPJAM_BROWSERD_RECORD_MAX_BYTES);
  // `< 1`, not `<= 0`: a positive fraction floors to zero, and `-fs 0` tells
  // ffmpeg to stop at the first byte — a switch meant to bound a recording
  // would silently abolish it. A cap under one byte cannot be meant.
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_BROWSERD_RECORD_MAX_BYTES;
  return Math.min(Math.floor(raw), DEFAULT_BROWSERD_RECORD_MAX_BYTES);
}

/**
 * Mint 32 random bytes and leave them where only `user` can read them.
 *
 * 0600, and written before the daemon listens: a token file readable by
 * anything else on the box would be a browser-control credential sitting on
 * disk. The agent's own shell runs on a DIFFERENT box (a different
 * `runtimeKind`), so nothing the model drives can reach this one.
 */
function defaultMintToken(path: string): string {
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, token, { encoding: "utf8", mode: 0o600 });
  // Set explicitly as well as passed to `writeFileSync`: the mode argument is
  // masked by the process umask, and a 022 umask would leave this world-
  // readable — which is the one thing this file must never be.
  chmodSync(path, 0o600);
  return token;
}

/**
 * Extra Chromium args derived from config.
 *
 * KIOSK is what makes "the display IS the page" true for the video encoder:
 * fullscreen with no tab strip, no address bar and no window decoration, at
 * the origin, sized to the display. Chromium's own tab strip is hidden by it,
 * which is why the pane draws its own (the daemon publishes tab changes on the
 * control channel).
 *
 * The DEVICE SCALE FACTOR rides here rather than in the context options
 * because it has to reach the browser PROCESS: a Playwright
 * `deviceScaleFactor` changes what the page thinks it is, while this changes
 * what the compositor actually rasterises — and the encoder grabs the
 * compositor's output, not the page's opinion of itself.
 */
export function extraArgsFor(config: BrowserdConfig): string[] {
  const args: string[] = [];
  if (config.windowSize) args.push(`--window-size=${config.windowSize}`);
  if (config.kiosk) {
    args.push("--kiosk", "--start-fullscreen", "--window-position=0,0");
    if (!config.windowSize) {
      // Without a size the kiosk window still fills the display, but saying so
      // removes a race: Chromium sizes itself from the root window, and on a
      // display that is still coming up that read can land early.
      args.push("--window-size=1024,768");
    }
  }
  if (config.deviceScaleFactor !== 1 && config.contextMode === "persistent") {
    args.push(`--force-device-scale-factor=${config.deviceScaleFactor}`);
  }
  return args;
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
