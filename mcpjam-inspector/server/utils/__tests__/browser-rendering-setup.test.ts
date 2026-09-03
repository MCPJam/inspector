import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureLocalChromiumInstalled,
  getChromiumInstallState,
  resetBrowserRenderingSetupForTests,
  resetChromiumInstallStateForTests,
  shouldAutoInstallChromium,
  startChromiumInstall,
} from "../browser-rendering-setup";

const localEnv = {
  NODE_ENV: "production",
} as NodeJS.ProcessEnv;

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
};

beforeEach(() => {
  resetBrowserRenderingSetupForTests();
  resetChromiumInstallStateForTests();
  silentLogger.info.mockClear();
  silentLogger.warn.mockClear();
});

describe("browser rendering setup", () => {
  it("does not auto-install in hosted, Docker, test, or opt-out environments", () => {
    expect(shouldAutoInstallChromium({ NODE_ENV: "test" })).toBe(false);
    expect(shouldAutoInstallChromium({ DOCKER_CONTAINER: "true" })).toBe(false);
    expect(shouldAutoInstallChromium({ VITE_MCPJAM_HOSTED_MODE: "true" })).toBe(
      false
    );
    expect(
      shouldAutoInstallChromium({
        MCPJAM_SKIP_BROWSER_RENDERING_SETUP: "1",
      })
    ).toBe(false);
    expect(
      shouldAutoInstallChromium({ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" })
    ).toBe(false);
    expect(shouldAutoInstallChromium(localEnv)).toBe(true);
    expect(
      shouldAutoInstallChromium({
        NODE_ENV: "development",
        ELECTRON_APP: "true",
      })
    ).toBe(true);
  });

  it("installs Chromium once when local rendering is missing it", async () => {
    const isInstalled = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const runInstall = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    await expect(
      ensureLocalChromiumInstalled({
        env: localEnv,
        isInstalled,
        runInstall,
        logger: silentLogger,
      })
    ).resolves.toBe(true);

    expect(runInstall).toHaveBeenCalledTimes(1);
    expect(isInstalled).toHaveBeenCalledTimes(2);
  });

  it("shares one install across concurrent render attempts", async () => {
    let finishInstall!: () => void;
    const installStarted = new Promise<void>((resolve) => {
      finishInstall = resolve;
    });
    const runInstall = vi.fn<() => Promise<void>>(() => installStarted);
    // The second caller now JOINS synchronously — the reservation is made
    // before the probe — so there is one probe before the install and one
    // after it, not one per caller.
    const isInstalled = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    const first = ensureLocalChromiumInstalled({
      env: localEnv,
      isInstalled,
      runInstall,
      logger: silentLogger,
    });
    const second = ensureLocalChromiumInstalled({
      env: localEnv,
      isInstalled,
      runInstall,
      logger: silentLogger,
    });

    finishInstall();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(runInstall).toHaveBeenCalledTimes(1);
  });
});

/**
 * Both entry points write ONE Playwright browser cache, so two installers over
 * it is a corrupted install. They used to keep separate promises and could not
 * see each other.
 */
describe("chromium install — one lock, both doors", () => {
  it("does not start a second installer while the startup one is running", async () => {
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const autoInstall = vi.fn<() => Promise<void>>(() => running);
    const explicitInstall = vi.fn<() => Promise<void>>(async () => {});
    const isInstalled = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);

    const startup = ensureLocalChromiumInstalled({
      env: localEnv,
      isInstalled,
      runInstall: autoInstall,
      logger: silentLogger,
    });
    // The user reaches the consent screen mid-download and clicks Install.
    const state = await startChromiumInstall({
      isInstalled,
      runInstall: explicitInstall,
    });

    expect(state.status).toBe("installing");
    expect(explicitInstall).not.toHaveBeenCalled();

    finish();
    await startup;
    expect(autoInstall).toHaveBeenCalledTimes(1);
  });

  it("does not start a second installer for a double click", async () => {
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const runInstall = vi.fn<() => Promise<void>>(() => running);
    // Slow enough that the second click lands while the first is still
    // deciding — the exact window the probe-then-reserve order left open.
    const isInstalled = vi.fn(
      async () => new Promise<boolean>((r) => setTimeout(() => r(false), 5)),
    );

    const [first, second] = await Promise.all([
      startChromiumInstall({ isInstalled, runInstall }),
      startChromiumInstall({ isInstalled, runInstall }),
    ]);

    expect(first.status).toBe("installing");
    expect(second.status).toBe("installing");
    expect(runInstall).toHaveBeenCalledTimes(1);
    finish();
  });

  it("answers `ready` from a probe made inside the reservation", async () => {
    const runInstall = vi.fn<() => Promise<void>>(async () => {});
    const state = await startChromiumInstall({
      isInstalled: async () => true,
      runInstall,
    });

    expect(state).toEqual({ status: "ready" });
    expect(getChromiumInstallState()).toEqual({ status: "ready" });
    expect(runInstall).not.toHaveBeenCalled();
  });
});
