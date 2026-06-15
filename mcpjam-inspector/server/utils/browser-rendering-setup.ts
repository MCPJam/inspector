import { existsSync } from "fs";
import { createRequire } from "module";
import { logger } from "./logger.js";

const require = createRequire(import.meta.url);

const INSTALL_RETRY_COOLDOWN_MS = 5 * 60 * 1000;

type BrowserSetupReason = "startup" | "render";

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

type PlaywrightRegistryModule = {
  installBrowsersForNpmInstall: (browsers: string[]) => Promise<unknown>;
};

function loadPlaywrightRegistry(): PlaywrightRegistryModule {
  return require(
    "playwright-core/lib/server/registry/index"
  ) as PlaywrightRegistryModule;
}

export async function installPlaywrightChromium(): Promise<void> {
  const { installBrowsersForNpmInstall } = loadPlaywrightRegistry();
  await installBrowsersForNpmInstall(["chromium"]);
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
