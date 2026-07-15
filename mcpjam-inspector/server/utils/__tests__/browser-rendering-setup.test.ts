import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureLocalChromiumInstalled,
  resetBrowserRenderingSetupForTests,
  shouldAutoInstallChromium,
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
    const isInstalled = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
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
