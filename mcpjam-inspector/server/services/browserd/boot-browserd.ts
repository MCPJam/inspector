/**
 * Boot mcpjam-browserd inside a provisioned desktop sandbox.
 *
 * This is the inspector-SERVER side (it drives the sandbox); it is deliberately
 * OUTSIDE `daemon/`, so it is never pulled into the bundled daemon artifact. It
 * mirrors the plugin-box shim boot (`server/utils/computers/plugin-box.ts`):
 * start the daemon in the BACKGROUND with a command that never times out, pass
 * secrets in `envs` (never argv — visible to every process in the box and the
 * vendor command log), block on the one stdout ready-line, and reap the process
 * on any unsuccessful start so a durable computer never accumulates orphaned
 * daemons.
 *
 * What it adds over the shim boot: it mints the per-boot bearer the inspector
 * will use to authenticate its own requests to browserd (browserd self-auths
 * every request because each getHost port is public), and it captures the
 * daemon's `bootId` from the ready-line — the inspector stores it so a command
 * replayed against a different boot is rejected rather than re-run.
 */
import { randomBytes } from "node:crypto";

/** The minimal sandbox surface the boot needs; the debug route adapts a real
 *  E2B box to this, tests provide a fake. */
export interface BrowserdSandbox {
  /**
   * Start a long-lived background process. Resolves once the process is
   * launched (NOT once it exits) with handles to reap it and to await its exit.
   */
  runBackground(
    command: string,
    options: {
      envs: Record<string, string>;
      onStdout: (chunk: string) => void;
    },
  ): Promise<{ kill: () => Promise<unknown>; wait: () => Promise<unknown> }>;
  /**
   * Run a short foreground command and report its exit code.
   *
   * Resolves for a FAILING command too, rather than throwing: the display
   * check below asks `xdpyinfo` a question whose answer is its exit status,
   * and the E2B SDK turns a non-zero exit into a rejection.
   */
  run(
    command: string,
    options?: { envs?: Record<string, string> },
  ): Promise<{ exitCode: number }>;
  /** The public HTTPS host for a sandbox port. */
  getHost(port: number): string;
}

export interface BootBrowserdOptions {
  /** Absolute path to the bundled daemon inside the sandbox. */
  scriptPath: string;
  port: number;
  userDataDir: string;
  /** `--window-size` matched to the X screen geometry, if known. */
  windowSize?: string;
  headless?: boolean;
  readyTimeoutMs?: number;
  /**
   * `ephemeral` boots the daemon with NO persistent profile, so an eval or
   * swarm iteration cannot inherit the previous one's cookies. Defaults to
   * the persistent profile a playground login depends on.
   */
  contextMode?: "persistent" | "ephemeral";
  /** The X display browserd's Chromium draws on. Defaults to `:0`. */
  display?: string;
  /**
   * Make the window cover the display, with no chrome.
   *
   * The static half of the video gate: the encoder grabs the WHOLE display, so
   * "the display IS the page" only holds if the window fills it. Without it the
   * grab is a desktop with a browser somewhere on it, and every click the pane
   * mapped would be off by the window's origin.
   */
  kiosk?: boolean;
  /**
   * The device pixel ratio the box renders at.
   *
   * Sent only when a deployment is trying a candidate — the shipped default is
   * 1 — and applied to the X screen and to Chromium together, or the browser
   * paints past the edge of what is captured.
   */
  deviceScaleFactor?: number;
  /** One-shot profile archive written before browserd starts. */
  profileArchivePath?: string;
}

export interface BrowserdHandle {
  /** The per-boot bearer the inspector presents on every browserd request. */
  bearer: string;
  /** The daemon's boot nonce, echoed on every response (idempotency guard). */
  bootId: string;
  port: number;
  /** `https://<getHost(port)>` — where the inspector reaches browserd. */
  publicOrigin: string;
  /**
   * The wire compatibility number this daemon announced, if it announced one.
   *
   * Absent from a daemon predating V-4a. Recorded with the session so a later
   * lookup can answer "can I talk to it?" without a probe — and so a hash-only
   * difference can be told from an incompatible one.
   */
  protocolVersion?: number;
  /** Reap the daemon. Idempotent and never throws. */
  stop: () => Promise<void>;
}

const DEFAULT_READY_TIMEOUT_MS = 30_000;

/**
 * The X display a desktop box draws on — `:0`, the same one `@e2b/desktop`
 * defaults to, so a box we bootstrap and a box that SDK created look alike.
 */
export const BROWSERD_DISPLAY = ":0";

/**
 * `@e2b/desktop`'s own default geometry, for the same parity reason.
 *
 * ALSO THE TEMPLATE'S. The desktop image's start command brings up Xvfb at this
 * size (`templates/desktop/geometry.json` in the backend repo), and this is the
 * fallback used when a box has no X server yet. The two must agree: a browser
 * painting a page larger than the display it is captured from is a picture with
 * its right-hand edge missing, and nothing in either repository would say so.
 * `boot-browserd.test.ts` pins the value on this side; the backend's
 * `desktopTemplateBuild.test.ts` pins it on the other.
 */
export const DISPLAY_GEOMETRY = "1024x768x24";
const DISPLAY_READY_ATTEMPTS = 20;
const DISPLAY_POLL_MS = 500;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function displayIsUp(
  sandbox: BrowserdSandbox,
  display: string,
): Promise<boolean> {
  try {
    const { exitCode } = await sandbox.run(
      `xdpyinfo -display ${display} >/dev/null 2>&1`,
    );
    return exitCode === 0;
  } catch {
    // A command that cannot even run is not a display.
    return false;
  }
}

/**
 * Make sure something is drawing on `display` before the daemon launches a
 * HEADED Chromium at it.
 *
 * The desktop image bakes Xfce, Xvfb and noVNC, but nothing in it STARTS them:
 * that is `@e2b/desktop`'s `Sandbox.create`, via its internal `_start()`. The
 * hosted path never calls that — the computer is provisioned by the backend and
 * this process only ever `connect`s, which the desktop SDK does not override.
 * So a freshly provisioned desktop box has no X server, Playwright refuses to
 * launch headed ("Looks like you launched a headed browser without having a
 * XServer running"), and browserd dies before its ready line — surfacing as
 * `browserd exited before it reported listening (exit status 1)`.
 *
 * Idempotent by construction: a display that is already up (a warm box, a
 * relaunch, a box the desktop SDK did create) short-circuits on the first
 * probe, so this costs one command on the common path.
 *
 * Xfce is best-effort. The browser only needs an X server; the window manager
 * is what makes the noVNC stream look like a desktop rather than a bare root
 * window, and failing the whole boot over cosmetics would be wrong.
 */
export async function ensureDisplay(
  sandbox: BrowserdSandbox,
  display: string = BROWSERD_DISPLAY,
  /**
   * Device pixels per CSS pixel, when this boot is asking for a sharper one.
   *
   * The display and the page are the SAME rectangle: a browser rendering at
   * 1.5× on a 1024×768 screen paints past the edge of what is captured, and the
   * missing strip is on the right-hand side where nothing looks obviously
   * wrong. Only used on the fallback path — a box whose template already
   * brought X up keeps the geometry the template chose.
   */
  deviceScaleFactor = 1,
): Promise<void> {
  if (await displayIsUp(sandbox, display)) return;

  // Xvnc, matching the template, and for the reason the template gives: Xvfb
  // fixes its screen geometry when it starts, so the only way to give a box a
  // different display is to restart X — taking the desktop, the kiosk browser
  // and every open page with it, mid-session, because somebody dragged a
  // panel. A box brought up on this fallback path must be as resizable as one
  // the template started, or a session's viewport policy would work or not
  // depending on how its box happened to boot.
  //
  // FALLING BACK TO Xvfb IF Xvnc IS NOT THERE. An older image has no
  // `tigervnc-standalone-server`, and refusing to bring up a display at all
  // would turn "this box cannot resize" into "this box has no browser". The
  // session's policy negotiation is what notices the difference; this only has
  // to produce a display.
  await sandbox.runBackground(
    `if command -v Xvnc >/dev/null 2>&1; then ` +
      `Xvnc ${display} -geometry ${screenSizeFor({ deviceScaleFactor })} ` +
      `-depth 24 -rfbport ${XVNC_LOOPBACK_PORT} -localhost ` +
      `-SecurityTypes None -AlwaysShared -desktop mcpjam; ` +
      `else ` +
      `Xvfb ${display} -ac -screen 0 ${geometryFor({ deviceScaleFactor })} ` +
      `-retro -dpi 96 -nolisten tcp -nolisten unix; ` +
      `fi`,
    { envs: {}, onStdout: () => {} },
  );

  for (let attempt = 0; attempt < DISPLAY_READY_ATTEMPTS; attempt++) {
    if (await displayIsUp(sandbox, display)) {
      await sandbox
        .runBackground("startxfce4", {
          envs: { DISPLAY: display },
          onStdout: () => {},
        })
        .catch(() => {
          // Cosmetic; see above.
        });
      return;
    }
    await sleep(DISPLAY_POLL_MS);
  }
  throw new Error(
    `no X display on ${display}: the X server did not come up within ${
      (DISPLAY_READY_ATTEMPTS * DISPLAY_POLL_MS) / 1000
    }s`,
  );
}

/**
 * The X screen geometry for a boot.
 *
 * Scaled by the device scale factor, because the display and the page are the
 * SAME rectangle: a browser rendering at 1.5× on a 1024×768 screen paints past
 * the edge of what is captured, and the missing strip is on the right-hand side
 * where nothing looks obviously wrong.
 */
/**
 * The loopback port Xvnc's own RFB listener binds to.
 *
 * Mirrors `templates/desktop/build.ts` in the backend repository, and exists
 * for the same reason: Xvnc IS a VNC server and cannot be run without one.
 * NOTHING connects to it. It is bound to `-localhost`, so it adds no listener
 * anything outside the sandbox can reach, and the authenticated desktop viewer
 * keeps going through the x11vnc + noVNC path the image already bakes.
 */
export const XVNC_LOOPBACK_PORT = 5999;

/** `WxH` at this scale — what Xvnc's `-geometry` takes, without the depth. */
function screenSizeFor(options: { deviceScaleFactor?: number }): string {
  const [width, height] = geometryFor(options).split("x");
  return `${width}x${height}`;
}

function geometryFor(options: { deviceScaleFactor?: number }): string {
  const dpr = options.deviceScaleFactor ?? 1;
  if (dpr === 1) return DISPLAY_GEOMETRY;
  const [width, height, depth] = DISPLAY_GEOMETRY.split("x").map(Number);
  return `${Math.round((width ?? 1024) * dpr)}x${Math.round(
    (height ?? 768) * dpr,
  )}x${depth ?? 24}`;
}

interface BrowserdReadyLine {
  port: number;
  bootId: string;
  /**
   * The daemon's wire compatibility number, when it printed one.
   *
   * VALIDATED WHEN PRESENT, OPTIONAL WHEN ABSENT. A daemon baked into an older
   * image prints the pre-V-4a line, and refusing that would turn a boot into a
   * hard failure over a field nothing needs to boot. Absent means "unknown",
   * which the reuse ladder treats as "cannot prove compatibility" — a relaunch
   * — rather than as a match.
   */
  protocolVersion?: number;
}

function parseReadyLine(line: string): BrowserdReadyLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  if (record.event !== "listening") return null;
  if (typeof record.port !== "number") return null;
  if (typeof record.bootId !== "string" || record.bootId.length === 0)
    return null;
  const protocolVersion = record.protocolVersion;
  if (
    protocolVersion !== undefined &&
    (typeof protocolVersion !== "number" ||
      !Number.isSafeInteger(protocolVersion) ||
      protocolVersion < 1)
  ) {
    // A field that IS there and is nonsense is a daemon we do not understand.
    // Refusing the line is the loud failure; treating it as absent would let a
    // garbled build be adopted as a compatible one.
    return null;
  }
  return {
    port: record.port,
    bootId: record.bootId,
    ...(typeof protocolVersion === "number" ? { protocolVersion } : {}),
  };
}

function buildEnv(
  bearer: string,
  options: BootBrowserdOptions,
): Record<string, string> {
  const env: Record<string, string> = {
    MCPJAM_BROWSERD_TOKEN: bearer,
    MCPJAM_BROWSERD_PORT: String(options.port),
    MCPJAM_BROWSERD_USER_DATA_DIR: options.userDataDir,
    // Chromium is launched HEADED here and finds its X server through this
    // variable alone: E2B command shells do not inherit the image's Dockerfile
    // `ENV`, so an image-level `DISPLAY` would not reach the daemon.
    DISPLAY: options.display ?? BROWSERD_DISPLAY,
    // Kiosk is what makes "the display IS the page" true for the video
    // encoder, and it is the static half of the daemon's own h264 gate.
    ...(options.kiosk ? { MCPJAM_BROWSERD_KIOSK: "1" } : {}),
    // Sent only when a deployment is trying a candidate: the shipped default
    // is 1, and a value the daemon does not receive is one it cannot
    // misinterpret.
    ...(options.deviceScaleFactor !== undefined &&
    options.deviceScaleFactor !== 1
      ? { MCPJAM_BROWSERD_DPR: String(options.deviceScaleFactor) }
      : {}),
    // Forwarded verbatim: the daemon owns the feature names, so an inspector
    // never has to be redeployed for a daemon to gain or drop a flag.
    ...(process.env.MCPJAM_BROWSERD_FEATURES
      ? { MCPJAM_BROWSERD_FEATURES: process.env.MCPJAM_BROWSERD_FEATURES }
      : {}),
    ...(process.env.MCPJAM_BROWSERD_DISABLE_FEATURES
      ? {
          MCPJAM_BROWSERD_DISABLE_FEATURES:
            process.env.MCPJAM_BROWSERD_DISABLE_FEATURES,
        }
      : {}),
    // The shape scrub defaults on; only its kill switch travels, so a rollback
    // disables it on both sides.
    ...(process.env.MCPJAM_BROWSER_SHAPE_REDACTION === "0"
      ? { MCPJAM_BROWSER_SHAPE_REDACTION: "0" }
      : {}),
  };
  if (options.windowSize) env.MCPJAM_BROWSERD_WINDOW_SIZE = options.windowSize;
  if (options.headless) env.MCPJAM_BROWSERD_HEADLESS = "true";
  if (options.contextMode === "ephemeral") {
    env.MCPJAM_BROWSERD_EPHEMERAL = "true";
  }
  if (options.profileArchivePath) {
    env.MCPJAM_BROWSERD_PROFILE_ARCHIVE = options.profileArchivePath;
  }
  return env;
}

/**
 * Start browserd in `sandbox` and resolve once it reports listening. Rejects —
 * after reaping the process — if the daemon exits before listening or does not
 * report within `readyTimeoutMs`. The kill/finish choreography mirrors the shim
 * boot exactly: the ready line can arrive on `onStdout` before the run promise
 * resolves, so success is detected there and the run promise only reaps on a
 * FAILED start (`failed`, not `settled`).
 */
export function bootBrowserd(
  sandbox: BrowserdSandbox,
  options: BootBrowserdOptions,
): Promise<BrowserdHandle> {
  const bearer = randomBytes(32).toString("hex");
  const env = buildEnv(bearer, options);
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;

  return new Promise<BrowserdHandle>((resolve, reject) => {
    let settled = false;
    let failed = false;
    let carry = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started: { kill: () => Promise<unknown> } | undefined;

    const kill = async (): Promise<void> => {
      try {
        await started?.kill();
      } catch {
        // Already gone or the box is unreachable — nothing further to do.
      }
    };

    const finish = (outcome: BrowserdReadyLine | Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (outcome instanceof Error) {
        failed = true;
        void kill(); // never leave an orphan daemon in a durable computer
        reject(outcome);
        return;
      }
      resolve({
        bearer,
        bootId: outcome.bootId,
        port: outcome.port,
        publicOrigin: `https://${sandbox.getHost(outcome.port)}`,
        ...(outcome.protocolVersion !== undefined
          ? { protocolVersion: outcome.protocolVersion }
          : {}),
        stop: kill,
      });
    };

    // Chained rather than awaited before this promise is built: the boot's
    // ready-line choreography (and its timeout) must own every failure path,
    // including "the box never got an X server".
    void ensureDisplay(sandbox, options.display, options.deviceScaleFactor)
      .then(() =>
        sandbox.runBackground(`node ${JSON.stringify(options.scriptPath)}`, {
          envs: env,
          onStdout: (chunk) => {
            if (settled) return;
            carry += chunk;
            let index: number;
            while ((index = carry.indexOf("\n")) >= 0) {
              const line = carry.slice(0, index);
              carry = carry.slice(index + 1);
              const ready = parseReadyLine(line);
              if (ready) finish(ready);
            }
          },
        }),
      )
      .then((command) => {
        started = command;
        // The deadline may have fired before the handle existed; reap here.
        // Gated on `failed`, not `settled` — a success commonly settles from
        // onStdout before this resolves.
        if (failed) {
          void kill();
          return;
        }
        void command
          .wait()
          .then(() =>
            finish(new Error("browserd exited before it reported listening")),
          )
          .catch((error) =>
            finish(
              new Error(
                `browserd exited before it reported listening (${
                  error instanceof Error ? error.message : "unknown"
                })`,
              ),
            ),
          );
      })
      .catch((error) =>
        finish(error instanceof Error ? error : new Error(String(error))),
      );

    timer = setTimeout(
      () =>
        finish(
          new Error(
            `browserd did not report listening within ${readyTimeoutMs}ms`,
          ),
        ),
      readyTimeoutMs,
    );
    // A synchronous ready line settles before the timer exists; clear it.
    if (settled) clearTimeout(timer);
  });
}
