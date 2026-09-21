import { spawn } from "child_process";
import { existsSync } from "fs";
import { createRequire } from "module";
import { dirname, resolve as resolvePath } from "path";
import { stripVTControlCharacters } from "util";
import { logger } from "./logger.js";

const require = createRequire(import.meta.url);

/**
 * How long to wait before each AUTOMATIC retry after a failed install, in
 * order. Three tries, then the pane's Retry button is the only way back in.
 *
 * Playwright already retries each download five times within one run and
 * locks the cache directory across processes; this ladder is for the failure
 * modes that outlive a single run — a network that is down at launch and back
 * two minutes later — not for the ones Playwright handles itself.
 */
const AUTO_RETRY_DELAYS_MS = [30_000, 120_000, 600_000];

/** How much of the installer's output a failure keeps. */
const OUTPUT_TAIL_BYTES = 4096;

type BrowserSetupReason = "startup" | "render" | "webmcp" | "retry";

type BrowserRenderingSetupLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

type InstallRunner = (onProgress: (percent: number) => void) => Promise<void>;

interface BrowserRenderingSetupOptions {
  reason?: BrowserSetupReason;
  env?: NodeJS.ProcessEnv;
  isInstalled?: () => Promise<boolean>;
  runInstall?: InstallRunner;
  logger?: BrowserRenderingSetupLogger;
}

/**
 * What the Chromium install is doing right now, whichever door started it.
 *
 * The background install at server startup can afford to be silent in the
 * console; the pane cannot. It is hundreds of megabytes, and the alternative to
 * reporting progress is a screen that looks broken for several minutes. It
 * deliberately does NOT run inside a chat turn: a model waiting on a tool call
 * has no way to say what is taking so long.
 *
 * A failure carries the REASON. Playwright prints why it gave up — a 403 from
 * the download host, a full disk, an unwritable cache — right before exiting
 * 1, and "exited with code 1" alone sends nobody anywhere.
 */
export type ChromiumInstallState =
  | { status: "idle" }
  | { status: "installing"; percent?: number }
  | { status: "ready" }
  | {
      status: "failed";
      /** One line, human-readable. */
      error: string;
      /** The installer's last output, for the expandable details block. */
      details?: string;
      /** Epoch ms of the next automatic attempt; absent when there is none. */
      retryAt?: number;
      /** Failed attempts so far, counting this one. */
      attempts: number;
    };

export class ChromiumInstallError extends Error {
  readonly details?: string;
  constructor(message: string, details?: string) {
    super(message);
    this.name = "ChromiumInstallError";
    this.details = details;
  }
}

let explicitInstallState: ChromiumInstallState = { status: "idle" };
/**
 * The ONE install in flight, whichever path started it.
 *
 * Both entry points write the same Playwright browser cache, so two concurrent
 * `playwright install chromium` runs are a corrupted install — and they were
 * reachable: the startup auto-install and a click on the consent screen each
 * kept their own promise and neither could see the other.
 */
let activeInstall: Promise<boolean> | null = null;

/** The most recent failure, republished to anyone who asks while a retry is pending. */
let lastFailure: Extract<ChromiumInstallState, { status: "failed" }> | null =
  null;
let failedAttempts = 0;
let retryTimer: NodeJS.Timeout | null = null;

export function getChromiumInstallState(): ChromiumInstallState {
  return explicitInstallState;
}

function defaultLogger(_env: NodeJS.ProcessEnv): BrowserRenderingSetupLogger {
  return {
    info(message) {
      logger.info(message);
    },
    warn(message) {
      logger.warn(message);
    },
  };
}

/**
 * Whether this process should download Chromium on its own.
 *
 * `versions.electron` rather than the `ELECTRON_APP` env var, for the same
 * reason the session layer checks it: the var says how the app was STARTED,
 * and a dev server started with it set is a plain Node process that still
 * needs a browser. The packaged desktop app IS a Chromium and cannot run the
 * Playwright CLI anyway — `process.execPath` is Electron with the RunAsNode
 * fuse off — so an install there is not wasteful, it is doomed.
 */
export function shouldAutoInstallChromium(
  env: NodeJS.ProcessEnv = process.env,
  versions: { electron?: string } = process.versions,
): boolean {
  if (versions.electron) return false;
  if (env.NODE_ENV === "test") return false;
  if (env.DOCKER_CONTAINER === "true") return false;
  if (env.VITE_MCPJAM_HOSTED_MODE === "true") return false;
  if (env.MCPJAM_SKIP_BROWSER_RENDERING_SETUP === "1") return false;
  if (env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === "1") return false;
  return true;
}

export async function isChromiumInstalled(): Promise<boolean> {
  try {
    const chromium = await import("playwright")
      .then((m) => m.chromium)
      .catch(async () => (await import("playwright-core")).chromium);
    const executablePath = chromium.executablePath();
    return !!executablePath && existsSync(executablePath);
  } catch {
    return false;
  }
}

/**
 * Resolve Playwright's CLI entry point via its package `bin` contract. We can't
 * `require.resolve("playwright/cli.js")` directly because Playwright's `exports`
 * map doesn't expose `./cli.js`, but `./package.json` is always exported and the
 * `bin` field is a stable public contract — so resolve the package root and join
 * the declared bin path off it.
 */
function resolvePlaywrightCli(): string {
  const pkgJsonPath = require.resolve("playwright/package.json");
  const pkg = require("playwright/package.json") as {
    bin?: string | Record<string, string>;
  };
  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.playwright;
  if (!binRel) {
    throw new Error("Could not resolve the playwright CLI bin entry");
  }
  return resolvePath(dirname(pkgJsonPath), binRel);
}

const PROGRESS_RE = /(\d{1,3})%/g;

/**
 * Reads the installer's output as it arrives, keeping three things apart:
 * the percentage (for the pane), a bounded tail (for a failure's details),
 * and complete non-progress lines (for the server log). The downloader
 * redraws one line with `\r`, so a chunk can carry several percentages and
 * several drafts of the same line; only the newest of each is true.
 */
export class InstallOutputCollector {
  private tail = "";
  private line = "";
  private pendingCR = false;

  constructor(
    private readonly onProgress: (percent: number) => void,
    private readonly onLine: (line: string) => void,
  ) {}

  push(chunk: Buffer | string): void {
    const text = stripVTControlCharacters(chunk.toString());
    const matches = [...text.matchAll(PROGRESS_RE)];
    const last = matches[matches.length - 1]?.[1];
    if (last !== undefined) this.onProgress(Math.min(100, Number(last)));

    for (const char of text) {
      if (this.pendingCR) {
        this.pendingCR = false;
        // `\r\n` is a line ending; a bare `\r` is a redraw, and the line so
        // far is a draft that is about to be replaced.
        if (char !== "\n") this.line = "";
      }
      if (char === "\r") {
        this.pendingCR = true;
      } else if (char === "\n") {
        this.flush();
      } else {
        this.line += char;
      }
    }
  }

  private flush(): void {
    const line = this.line.trimEnd();
    this.line = "";
    if (line.length === 0) return;
    this.tail = (this.tail + line + "\n").slice(-OUTPUT_TAIL_BYTES);
    if (!PROGRESS_RE.test(line)) this.onLine(line);
    PROGRESS_RE.lastIndex = 0;
  }

  /** Everything kept so far, including a final line without a newline. */
  output(): string {
    this.flush();
    return this.tail.trimEnd();
  }
}

/**
 * Turn an exit and the installer's output into the one line the pane shows.
 *
 * Playwright's CLI prints `Failed to install browsers` followed by the error
 * on its own line(s) right before it exits 1, so that next line is the
 * sentence a person can act on. Everything else is in `details`.
 */
export function summarizeInstallFailure(
  code: number | null,
  signal: NodeJS.Signals | null,
  output: string,
): string {
  const lines = output.split("\n").map((line) => line.trim());
  const marker = lines.findIndex((line) =>
    /^Failed to install browsers/i.test(line),
  );
  if (marker !== -1) {
    const prose = lines
      .slice(marker + 1)
      .filter((line) => line.length > 0 && !/^at /.test(line))
      .map((line) => line.replace(/^Error:\s*/, ""));
    let reason = prose[0];
    if (reason) {
      // "Failed to download X, caused by" ends mid-sentence; the cause is
      // the next line.
      if (/caused by:?$/i.test(reason) && prose[1]) {
        reason = `${reason.replace(/:?$/, "")} ${prose[1]}`;
      }
      // The downloader runs in its own child and prints the underlying
      // socket error before the summary — the part a person can act on.
      const socket = lines
        .map((line) => line.replace(/^Error:\s*/, ""))
        .find((line) =>
          /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EACCES|EPERM|ENOSPC|EHOSTUNREACH|ENETUNREACH|CERT_|self.signed certificate)\b/.test(
            line,
          ),
        );
      if (socket && !reason.includes(socket)) reason = `${reason} (${socket})`;
      return reason.length > 240 ? `${reason.slice(0, 237)}…` : reason;
    }
  }
  return `playwright install chromium exited with ${
    signal ? `signal ${signal}` : `code ${code}`
  }`;
}

/**
 * Run `playwright install chromium` through the published CLI rather than
 * reaching into `playwright-core/lib/server/registry`, which is an internal
 * module Playwright reorganizes between releases. The CLI is a supported entry
 * point and survives version bumps.
 *
 * The ONE installer, for every door. Its output is piped, never inherited:
 * the percentage goes to `onProgress` for the pane, complete lines go to the
 * server log so the console still shows what it used to, and the last few
 * kilobytes ride along on a failure so the pane can say WHY. Settles on
 * `close`, after both streams have drained, because the reason is the last
 * thing Playwright prints and `exit` can fire before it lands.
 */
export async function runPlaywrightChromiumInstall(
  onProgress: (percent: number) => void = () => {},
  log: BrowserRenderingSetupLogger = defaultLogger(process.env),
): Promise<void> {
  const cliPath = resolvePlaywrightCli();
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, "install", "chromium"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collector = new InstallOutputCollector(onProgress, (line) =>
      log.info(`[browser-rendering] ${line}`),
    );
    child.stdout?.on("data", (chunk: Buffer) => collector.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => collector.push(chunk));
    child.on("error", (error) =>
      reject(new ChromiumInstallError(error.message, collector.output())),
    );
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const output = collector.output();
      reject(
        new ChromiumInstallError(
          summarizeInstallFailure(code, signal, output),
          output || undefined,
        ),
      );
    });
  });
}

/** @deprecated Use `runPlaywrightChromiumInstall`; kept for callers that predate the one installer. */
export const installPlaywrightChromium = (): Promise<void> =>
  runPlaywrightChromiumInstall();
/** @deprecated Use `runPlaywrightChromiumInstall`. */
export const installPlaywrightChromiumWithProgress = (
  onProgress: (percent: number) => void,
): Promise<void> => runPlaywrightChromiumInstall(onProgress);

function cancelScheduledRetry(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function publishReady(): void {
  cancelScheduledRetry();
  failedAttempts = 0;
  lastFailure = null;
  explicitInstallState = { status: "ready" };
}

/**
 * Record a failure and, while the ladder has rungs left, book the next
 * automatic attempt. The retry runs through the same seams the failed attempt
 * used, so a test can drive it with fake timers and a fake installer.
 */
function publishFailure(
  error: unknown,
  retryWith: BrowserRenderingSetupOptions,
): Extract<ChromiumInstallState, { status: "failed" }> {
  cancelScheduledRetry();
  failedAttempts += 1;
  const message = error instanceof Error ? error.message : String(error);
  const details =
    error instanceof ChromiumInstallError ? error.details : undefined;
  const delay = AUTO_RETRY_DELAYS_MS[failedAttempts - 1];
  const failed: Extract<ChromiumInstallState, { status: "failed" }> = {
    status: "failed",
    error: message,
    ...(details ? { details } : {}),
    ...(delay !== undefined ? { retryAt: Date.now() + delay } : {}),
    attempts: failedAttempts,
  };
  lastFailure = failed;
  explicitInstallState = failed;
  if (delay !== undefined) {
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void ensureLocalChromiumInstalled({ ...retryWith, reason: "retry" });
    }, delay);
    retryTimer.unref?.();
  }
  return failed;
}

/**
 * Start (or join) an explicit Chromium install and report its progress.
 *
 * Idempotent by design: the consent screen polls the state and may click
 * twice, and two concurrent `playwright install` runs writing the same browser
 * cache is a corrupted install.
 *
 * A click is a person asking NOW: it cancels any automatic retry that was
 * booked and starts the ladder over, so the pane never answers a click with
 * "retrying in nine minutes".
 */
export async function startChromiumInstall(
  options: {
    isInstalled?: () => Promise<boolean>;
    runInstall?: InstallRunner;
  } = {},
): Promise<ChromiumInstallState> {
  // Whoever is already installing owns it, including the startup auto-install.
  if (activeInstall) {
    if (explicitInstallState.status === "idle") {
      explicitInstallState = { status: "installing" };
    }
    return explicitInstallState;
  }
  const isInstalled = options.isInstalled ?? isChromiumInstalled;
  const runInstall = options.runInstall ?? runPlaywrightChromiumInstall;

  // Clears the STANDING FAILURE too, not just the ladder: it is what gates
  // every automatic caller above, and this click is the one thing that is
  // allowed to lift it.
  cancelScheduledRetry();
  failedAttempts = 0;
  lastFailure = null;

  // The reservation is made SYNCHRONOUSLY and the "is it already there?" probe
  // happens inside it. Probing first meant two clicks, or a click and the
  // startup path, could both get past the check — `isInstalled()` is a
  // filesystem round trip — and each spawn an installer over one cache.
  let probed: (already: boolean) => void = () => {};
  const probe = new Promise<void>((resolve) => {
    probed = () => resolve();
  });
  explicitInstallState = { status: "installing" };
  activeInstall = (async () => {
    let already = false;
    try {
      already = await isInstalled();
    } catch {
      already = false;
    }
    if (already) {
      // Reported from INSIDE the reservation, so the answer the caller gets
      // back is as fresh as the probe that produced it.
      publishReady();
      probed(true);
      return true;
    }
    probed(false);
    try {
      await runInstall((percent) => {
        explicitInstallState = { status: "installing", percent };
      });
      const ready = await isInstalled();
      if (ready) {
        publishReady();
      } else {
        publishFailure(
          new Error(
            "the install finished but no launchable Chromium was found on this machine",
          ),
          { isInstalled, runInstall },
        );
      }
      return ready;
    } catch (error) {
      publishFailure(error, { isInstalled, runInstall });
      return false;
    }
  })().finally(() => {
    activeInstall = null;
  });

  // Resolves as soon as the probe has answered, so an already-installed
  // machine still reports `ready` on the first call rather than making the
  // consent screen poll for something that was true before it asked.
  await probe;
  return explicitInstallState;
}

/** Test seam: install state is process-wide by design. */
export function resetChromiumInstallStateForTests(): void {
  explicitInstallState = { status: "idle" };
  activeInstall = null;
  cancelScheduledRetry();
  failedAttempts = 0;
  lastFailure = null;
}

export async function ensureLocalChromiumInstalled(
  options: BrowserRenderingSetupOptions = {},
): Promise<boolean> {
  const env = options.env ?? process.env;
  const log = options.logger ?? defaultLogger(env);
  const isInstalled = options.isInstalled ?? isChromiumInstalled;

  const reason = options.reason ?? "render";

  // A retry continues an attempt that already got past this gate — or past
  // consent, when a click started it — so it is not asked again.
  if (reason !== "retry" && !shouldAutoInstallChromium(env)) {
    return false;
  }

  // Joins whatever is already running, including a user-triggered install
  // started from the consent screen.
  if (activeInstall) return activeInstall;

  const runInstall = options.runInstall ?? runPlaywrightChromiumInstall;

  // Reserved SYNCHRONOUSLY, with the "is it there already?" probe and the
  // pending-retry check moved inside. Both are awaits, and a second caller
  // getting past them starts a second `playwright install` over the same
  // browser cache.
  activeInstall = (async () => {
    // Every terminal path of this runner publishes a state, because the
    // consent screen can JOIN this install rather than start one — and a join
    // that never sees an answer leaves the pane reading "Downloading
    // Chromium" forever, with no way to ask again.
    if (await isInstalled()) {
      publishReady();
      return true;
    }

    if (lastFailure && reason !== "retry") {
      // A failure stands. Report THAT rather than starting a fresh attempt
      // nobody asked for — whether an automatic retry is still booked (the
      // state carries its countdown) or the ladder is spent.
      //
      // Gated on the FAILURE, not on the pending timer. Gating on the timer
      // meant the cap evaporated the moment it was reached: with nothing
      // booked, every later render or WebMCP request walked straight past
      // this and spawned its own installer, so a machine that could never
      // download Chromium ran one per request forever. Once the ladder is
      // spent only an explicit "Retry now" clears this, which is the whole
      // point of a cap.
      explicitInstallState = lastFailure;
      return false;
    }

    log.info(
      `[browser-rendering] Chromium missing; setting up Playwright Chromium (${reason})`,
    );
    // An install is genuinely starting NOW, so say so — this is the last of
    // the runner's states to be published and the one it was missing. Without
    // it, a retry that follows an earlier failure runs with the pane still
    // reading "install failed": the button appears dead, because the consent
    // screen's own call joins this run and is handed back the stale failure.
    explicitInstallState = { status: "installing" };
    const retryWith: BrowserRenderingSetupOptions = {
      env,
      isInstalled,
      runInstall,
      logger: log,
    };
    try {
      await runInstall((percent) => {
        explicitInstallState = { status: "installing", percent };
      });
      const ready = await isInstalled();
      if (!ready) {
        throw new Error(
          "Playwright Chromium install finished, but no launchable Chromium was found",
        );
      }
      // One install, one reported state: a consent screen that JOINED this run
      // rather than starting it still has to see it finish.
      publishReady();
      log.info("[browser-rendering] Playwright Chromium is ready");
      return true;
    } catch (error) {
      // Taken from the publisher's return rather than re-read from the
      // module state and cast back: the cast was a lie the compiler could not
      // check, and it narrowed to `installing` here anyway.
      const failed = publishFailure(error, retryWith);
      const when = failed.retryAt
        ? `; retrying in ${Math.round((failed.retryAt - Date.now()) / 1000)}s`
        : "; no more automatic retries";
      // The installer's own lines were already echoed as they arrived, so the
      // warning carries the one-line reason and the plan, not the transcript.
      log.warn(
        `[browser-rendering] Failed to set up Playwright Chromium (attempt ${failed.attempts}): ${failed.error}${when}`,
      );
      return false;
    }
  })().finally(() => {
    activeInstall = null;
  });

  return activeInstall;
}

export function startLocalBrowserRenderingSetupInBackground(): void {
  if (!shouldAutoInstallChromium()) {
    return;
  }

  void ensureLocalChromiumInstalled({ reason: "startup" });
}

export function resetBrowserRenderingSetupForTests(): void {
  activeInstall = null;
  cancelScheduledRetry();
  failedAttempts = 0;
  lastFailure = null;
}
