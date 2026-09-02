import { spawn } from "child_process";
import { existsSync } from "fs";
import { createRequire } from "module";
import { dirname, resolve as resolvePath } from "path";
import { logger } from "./logger.js";

const require = createRequire(import.meta.url);

const INSTALL_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

type BrowserSetupReason = "startup" | "render" | "webmcp";

type BrowserRenderingSetupLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

interface BrowserRenderingSetupOptions {
  reason?: BrowserSetupReason;
  env?: NodeJS.ProcessEnv;
  isInstalled?: () => Promise<boolean>;
  runInstall?: () => Promise<void>;
  logger?: BrowserRenderingSetupLogger;
}

/**
 * What an explicit, user-triggered Chromium install is doing right now.
 *
 * The background install at server startup can afford to be silent; this one
 * cannot. It is hundreds of megabytes started by someone who just clicked
 * "install", and the alternative to reporting progress is a screen that looks
 * broken for several minutes. It deliberately does NOT run inside a chat turn:
 * a model waiting on a tool call has no way to say what is taking so long.
 */
export type ChromiumInstallState =
  | { status: "idle" }
  | { status: "installing"; percent?: number }
  | { status: "ready" }
  | { status: "failed"; error: string };

let explicitInstallState: ChromiumInstallState = { status: "idle" };
let explicitInstallPromise: Promise<boolean> | null = null;

export function getChromiumInstallState(): ChromiumInstallState {
  return explicitInstallState;
}

let installPromise: Promise<boolean> | null = null;
let lastInstallFailureAt = 0;

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

export function shouldAutoInstallChromium(
  env: NodeJS.ProcessEnv = process.env
): boolean {
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
  const binRel =
    typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.playwright;
  if (!binRel) {
    throw new Error("Could not resolve the playwright CLI bin entry");
  }
  return resolvePath(dirname(pkgJsonPath), binRel);
}

/**
 * Run `playwright install chromium` through the published CLI rather than
 * reaching into `playwright-core/lib/server/registry`, which is an internal
 * module Playwright reorganizes between releases. The CLI is a supported entry
 * point, survives version bumps, and inheriting its stdio shows the user the
 * real download progress instead of a single log line.
 */
export async function installPlaywrightChromium(): Promise<void> {
  const cliPath = resolvePlaywrightCli();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, "install", "chromium"], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `playwright install chromium exited with ${
              signal ? `signal ${signal}` : `code ${code}`
            }`
          )
        );
      }
    });
  });
}

/**
 * Run the install with its output PARSED rather than inherited.
 *
 * `installPlaywrightChromium` inherits stdio, which shows progress in the
 * server's own terminal — useless to a browser tab. This reads the same output
 * and reports percentages, at the cost of no longer echoing to the console;
 * both exist because the startup path genuinely wants the console and the
 * user-triggered path genuinely wants the number.
 */
export async function installPlaywrightChromiumWithProgress(
  onProgress: (percent: number) => void,
): Promise<void> {
  const cliPath = resolvePlaywrightCli();
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cliPath, "install", "chromium"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Playwright reports "|████ | 37% of 168.4 MiB". Take the last percentage
    // on each chunk: the downloader redraws one line, so a chunk can carry
    // several and only the newest is true.
    const read = (chunk: Buffer) => {
      const matches = [...chunk.toString().matchAll(/(\d{1,3})%/g)];
      const last = matches[matches.length - 1]?.[1];
      if (last !== undefined) onProgress(Math.min(100, Number(last)));
    };
    child.stdout?.on("data", read);
    child.stderr?.on("data", read);
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(
        new Error(
          `playwright install chromium exited with ${
            signal ? `signal ${signal}` : `code ${code}`
          }`,
        ),
      );
    });
  });
}

/**
 * Start (or join) an explicit Chromium install and report its progress.
 *
 * Idempotent by design: the consent screen polls the state and may click
 * twice, and two concurrent `playwright install` runs writing the same browser
 * cache is a corrupted install.
 */
export async function startChromiumInstall(options: {
  isInstalled?: () => Promise<boolean>;
  runInstall?: (onProgress: (percent: number) => void) => Promise<void>;
} = {}): Promise<ChromiumInstallState> {
  const isInstalled = options.isInstalled ?? isChromiumInstalled;
  if (explicitInstallPromise) return explicitInstallState;
  if (await isInstalled()) {
    explicitInstallState = { status: "ready" };
    return explicitInstallState;
  }

  const runInstall = options.runInstall ?? installPlaywrightChromiumWithProgress;
  explicitInstallState = { status: "installing" };
  explicitInstallPromise = (async () => {
    try {
      await runInstall((percent) => {
        explicitInstallState = { status: "installing", percent };
      });
      const ready = await isInstalled();
      explicitInstallState = ready
        ? { status: "ready" }
        : {
            status: "failed",
            error:
              "the install finished but no launchable Chromium was found on this machine",
          };
      return ready;
    } catch (error) {
      explicitInstallState = {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      return false;
    }
  })().finally(() => {
    explicitInstallPromise = null;
  });

  return explicitInstallState;
}

/** Test seam: install state is process-wide by design. */
export function resetChromiumInstallStateForTests(): void {
  explicitInstallState = { status: "idle" };
  explicitInstallPromise = null;
}

export async function ensureLocalChromiumInstalled(
  options: BrowserRenderingSetupOptions = {}
): Promise<boolean> {
  const env = options.env ?? process.env;
  const log = options.logger ?? defaultLogger(env);
  const isInstalled = options.isInstalled ?? isChromiumInstalled;

  if (!shouldAutoInstallChromium(env)) {
    return false;
  }

  if (await isInstalled()) {
    return true;
  }

  const now = Date.now();
  if (
    lastInstallFailureAt > 0 &&
    now - lastInstallFailureAt < INSTALL_RETRY_COOLDOWN_MS
  ) {
    return false;
  }

  if (!installPromise) {
    const runInstall = options.runInstall ?? installPlaywrightChromium;
    const reason = options.reason ?? "render";

    installPromise = (async () => {
      log.info(
        `[browser-rendering] Chromium missing; setting up Playwright Chromium (${reason})`
      );
      try {
        await runInstall();
        const ready = await isInstalled();
        if (!ready) {
          throw new Error(
            "Playwright Chromium install finished, but no launchable Chromium was found"
          );
        }
        lastInstallFailureAt = 0;
        log.info("[browser-rendering] Playwright Chromium is ready");
        return true;
      } catch (error) {
        lastInstallFailureAt = Date.now();
        log.warn(
          `[browser-rendering] Failed to set up Playwright Chromium: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return false;
      }
    })().finally(() => {
      installPromise = null;
    });
  }

  return installPromise;
}

export function startLocalBrowserRenderingSetupInBackground(): void {
  if (!shouldAutoInstallChromium()) {
    return;
  }

  void ensureLocalChromiumInstalled({ reason: "startup" });
}

export function resetBrowserRenderingSetupForTests(): void {
  installPromise = null;
  lastInstallFailureAt = 0;
}
