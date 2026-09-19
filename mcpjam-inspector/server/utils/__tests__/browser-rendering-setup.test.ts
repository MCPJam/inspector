import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChromiumInstallError,
  ensureLocalChromiumInstalled,
  getChromiumInstallState,
  InstallOutputCollector,
  resetBrowserRenderingSetupForTests,
  resetChromiumInstallStateForTests,
  shouldAutoInstallChromium,
  startChromiumInstall,
  summarizeInstallFailure,
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
      shouldAutoInstallChromium(
        {
          NODE_ENV: "development",
          ELECTRON_APP: "true",
        },
        {},
      ),
    ).toBe(true);
  });

  it("does not auto-install inside the desktop app", () => {
    // The packaged app IS a Chromium and cannot run the Playwright CLI —
    // `process.execPath` is Electron with the RunAsNode fuse off — so the
    // install is not merely wasted, it fails. The env var is the wrong
    // signal: a dev server started with it set is still a Node process.
    expect(shouldAutoInstallChromium(localEnv, { electron: "39.0.0" })).toBe(
      false,
    );
    expect(shouldAutoInstallChromium(localEnv, {})).toBe(true);
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

  it("lets a joined install finish rather than stranding the pane", async () => {
    // The consent screen can JOIN a running auto-install instead of starting
    // one. Every terminal path of the shared runner therefore has to publish a
    // state: a join that never sees an answer leaves the pane reading
    // "Downloading Chromium" forever, with no way to ask again.
    const autoInstall = vi.fn<() => Promise<void>>(async () => {});
    const isInstalled = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    const startup = ensureLocalChromiumInstalled({
      env: localEnv,
      isInstalled,
      runInstall: autoInstall,
      logger: silentLogger,
    });
    const joined = await startChromiumInstall({
      isInstalled,
      runInstall: async () => {},
    });
    expect(joined.status).toBe("installing");

    await startup;
    expect(getChromiumInstallState()).toEqual({ status: "ready" });
  });

  it("reports the pending retry rather than leaving a join at `installing`", async () => {
    // The path with no install at all: a recent failure has a retry booked,
    // so the runner returns without running anything, and a joiner still
    // needs an answer — the failure it is waiting behind, countdown included.
    const failing = vi.fn<() => Promise<void>>(async () => {
      throw new Error("network down");
    });
    const isInstalled = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(false);

    await ensureLocalChromiumInstalled({
      env: localEnv,
      isInstalled,
      runInstall: failing,
      logger: silentLogger,
    });

    // Straight back in, while the retry is pending.
    await ensureLocalChromiumInstalled({
      env: localEnv,
      isInstalled,
      runInstall: failing,
      logger: silentLogger,
    });

    expect(failing).toHaveBeenCalledTimes(1);
    const state = getChromiumInstallState();
    expect(state.status).toBe("failed");
    if (state.status === "failed") {
      expect(state.error).toBe("network down");
      expect(state.retryAt).toBeGreaterThan(Date.now());
    }
  });

  it("says it is installing again after an earlier attempt failed", async () => {
    // A retry that follows a failure has to REPLACE the failure, not run
    // behind it. The auto path published every terminal state but never the
    // one that says work is under way, so the pane sat on "install failed"
    // while an installer was actually running — and the consent screen's own
    // call, which joins that run, was handed the stale failure back. The
    // button looked dead.
    let finish!: () => void;
    const running = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const isInstalled = vi.fn<() => Promise<boolean>>().mockResolvedValue(false);

    await ensureLocalChromiumInstalled({
      env: localEnv,
      isInstalled,
      runInstall: async () => {
        throw new Error("network down");
      },
      logger: silentLogger,
    });
    expect(getChromiumInstallState().status).toBe("failed");

    // Past the cooldown, the way a later render attempt would arrive.
    resetBrowserRenderingSetupForTests();
    const retry = ensureLocalChromiumInstalled({
      env: localEnv,
      isInstalled,
      runInstall: () => running,
      logger: silentLogger,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(getChromiumInstallState().status).toBe("installing");
    expect((await startChromiumInstall({ isInstalled })).status).toBe(
      "installing",
    );

    finish();
    await retry;
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

    // Let the reservation settle HERE. It writes `explicitInstallState` and
    // clears `activeInstall` in a `finally`; returning now would land those
    // writes inside whichever test happens to be running by then.
    finish();
    await vi.waitFor(() =>
      expect(getChromiumInstallState().status).not.toBe("installing"),
    );
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

/**
 * "exited with code 1" told nobody anything. Playwright prints the reason
 * right before it exits; the installer has to keep it.
 */
describe("chromium install — the reason survives", () => {
  it("keeps a bounded, plain-text tail and reports the last percentage", () => {
    const progress: number[] = [];
    const lines: string[] = [];
    const collector = new InstallOutputCollector(
      (p) => progress.push(p),
      (l) => lines.push(l),
    );
    collector.push(
      "\u001b[1mDownloading Chromium 1234\u001b[0m from https://x\n",
    );
    // One chunk, several redraws of the progress bar: only the newest is true.
    collector.push("|██  | 12% of 168 MiB\r|████| 37% of 168 MiB\r");
    collector.push("|████████| 100% of 168 MiB\n");
    collector.push("Chromium 1234 downloaded to /cache\n");

    expect(progress).toEqual([37, 100]);
    expect(lines).toEqual([
      "Downloading Chromium 1234 from https://x",
      "Chromium 1234 downloaded to /cache",
    ]);
    expect(collector.output()).toBe(
      [
        "Downloading Chromium 1234 from https://x",
        "|████████| 100% of 168 MiB",
        "Chromium 1234 downloaded to /cache",
      ].join("\n"),
    );
  });

  it("treats CRLF as a line ending, not a redraw", () => {
    const lines: string[] = [];
    const collector = new InstallOutputCollector(
      () => {},
      (l) => lines.push(l),
    );
    collector.push("Failed to install browsers\r\n");
    collector.push("Error: EACCES: permission denied\r");
    collector.push("\n");
    expect(lines).toEqual([
      "Failed to install browsers",
      "Error: EACCES: permission denied",
    ]);
  });

  it("bounds the tail", () => {
    const collector = new InstallOutputCollector(
      () => {},
      () => {},
    );
    for (let i = 0; i < 500; i += 1)
      collector.push(`line ${i} ${"x".repeat(40)}\n`);
    const output = collector.output();
    expect(output.length).toBeLessThanOrEqual(4096);
    expect(output.endsWith("line 499 " + "x".repeat(40))).toBe(true);
  });

  it("uses Playwright's own reason as the one-line error when it printed one", () => {
    const output = [
      "Downloading Chromium 1234 from https://playwright.azureedge.net/…",
      "Failed to install browsers",
      "Error: Download failed: server returned code 403 body '' URL: https://…",
      "    at Object.<anonymous> (registry.js:1:1)",
    ].join("\n");
    expect(summarizeInstallFailure(1, null, output)).toBe(
      "Download failed: server returned code 403 body '' URL: https://…",
    );
    // Playwright's real shape for a dead network: the sentence ends mid-air
    // with "caused by", the cause is the next line, and the socket error the
    // downloader child printed earlier is the part a person can act on.
    const offline = [
      "Downloading Chrome for Testing 151.0.7922.34 (playwright chromium v1234) from http://127.0.0.1:9/x.zip",
      "Error: connect ECONNREFUSED 127.0.0.1:9",
      "    at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1705:16) {",
      "  errno: -61,",
      "}",
      "Failed to install browsers",
      "Error: Failed to download Chrome for Testing 151.0.7922.34 (playwright chromium v1234), caused by",
      "Error: Download failure, code=1",
      "    at ChildProcess.<anonymous> (coreBundle.js:32015:32)",
    ].join("\n");
    expect(summarizeInstallFailure(1, null, offline)).toBe(
      "Failed to download Chrome for Testing 151.0.7922.34 (playwright chromium v1234), caused by Download failure, code=1 (connect ECONNREFUSED 127.0.0.1:9)",
    );
    expect(summarizeInstallFailure(1, null, "")).toBe(
      "playwright install chromium exited with code 1",
    );
    expect(summarizeInstallFailure(null, "SIGKILL", "")).toBe(
      "playwright install chromium exited with signal SIGKILL",
    );
  });

  it("publishes the reason and the details on a failure", async () => {
    const isInstalled = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(false);
    await ensureLocalChromiumInstalled({
      env: localEnv,
      isInstalled,
      runInstall: async () => {
        throw new ChromiumInstallError(
          "Download failed: server returned code 403",
          "Downloading Chromium\nFailed to install browsers\nDownload failed: server returned code 403",
        );
      },
      logger: silentLogger,
    });
    expect(getChromiumInstallState()).toMatchObject({
      status: "failed",
      error: "Download failed: server returned code 403",
      details: expect.stringContaining("Failed to install browsers"),
      attempts: 1,
    });
    expect(silentLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Download failed: server returned code 403"),
    );
  });
});

/**
 * "The inspector will try again shortly" used to be a lie: nothing retried.
 * Now it books the next attempt and says when.
 */
describe("chromium install — automatic retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const failingInstall = () =>
    vi.fn<() => Promise<void>>(async () => {
      throw new Error("network down");
    });

  it("books the next attempt at 30s, 2m and 10m, then stops", async () => {
    const runInstall = failingInstall();
    const isInstalled = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(false);
    const start = Date.now();

    await ensureLocalChromiumInstalled({
      env: localEnv,
      isInstalled,
      runInstall,
      logger: silentLogger,
    });
    expect(getChromiumInstallState()).toMatchObject({
      status: "failed",
      attempts: 1,
      retryAt: start + 30_000,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(runInstall).toHaveBeenCalledTimes(2);
    expect(getChromiumInstallState()).toMatchObject({
      status: "failed",
      attempts: 2,
      retryAt: start + 30_000 + 120_000,
    });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(runInstall).toHaveBeenCalledTimes(3);
    expect(getChromiumInstallState()).toMatchObject({
      status: "failed",
      attempts: 3,
      retryAt: start + 30_000 + 120_000 + 600_000,
    });

    await vi.advanceTimersByTimeAsync(600_000);
    expect(runInstall).toHaveBeenCalledTimes(4);
    const exhausted = getChromiumInstallState();
    expect(exhausted).toMatchObject({ status: "failed", attempts: 4 });
    expect((exhausted as { retryAt?: number }).retryAt).toBeUndefined();

    // Nothing else is booked.
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(runInstall).toHaveBeenCalledTimes(4);
  });

  it("keeps refusing after the ladder is spent, until someone asks", async () => {
    const runInstall = failingInstall();
    const isInstalled = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(false);
    const attempt = () =>
      ensureLocalChromiumInstalled({
        env: localEnv,
        isInstalled,
        runInstall,
        logger: silentLogger,
      });

    await attempt();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(runInstall).toHaveBeenCalledTimes(4);

    // The cap is spent and nothing is booked, so there is no timer left to
    // suppress anything. A widget render and a WebMCP session both ask now.
    await attempt();
    await ensureLocalChromiumInstalled({
      env: localEnv,
      isInstalled,
      runInstall,
      logger: silentLogger,
      reason: "webmcp",
    });
    expect(runInstall).toHaveBeenCalledTimes(4);
    // They are told why, rather than silently getting nothing.
    expect(getChromiumInstallState()).toMatchObject({
      status: "failed",
      error: "network down",
      attempts: 4,
    });

    // "Retry now" is the one thing that lifts it: the installer runs a fifth
    // time. `isInstalled` stays false for the probe inside the reservation —
    // answering true there would report `ready` without installing anything,
    // which is a different path than the one under test.
    runInstall.mockResolvedValueOnce(undefined);
    isInstalled.mockResolvedValueOnce(false).mockResolvedValue(true);
    await startChromiumInstall({ isInstalled, runInstall });
    await vi.waitFor(() =>
      expect(getChromiumInstallState()).toEqual({ status: "ready" }),
    );
    expect(runInstall).toHaveBeenCalledTimes(5);
  });

  it("lets a Chromium installed by hand clear a spent cap", async () => {
    const runInstall = failingInstall();
    const isInstalled = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(false);
    const attempt = () =>
      ensureLocalChromiumInstalled({
        env: localEnv,
        isInstalled,
        runInstall,
        logger: silentLogger,
      });

    await attempt();
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(120_000);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(runInstall).toHaveBeenCalledTimes(4);

    // Someone ran `npx playwright install chromium` themselves. The probe
    // runs BEFORE the suppression gate for exactly this reason: a cap that
    // outlived the problem it was capping would be a bug of its own.
    isInstalled.mockResolvedValue(true);
    await expect(attempt()).resolves.toBe(true);
    expect(getChromiumInstallState()).toEqual({ status: "ready" });
    expect(runInstall).toHaveBeenCalledTimes(4);
  });

  it("a retry that succeeds clears the ladder", async () => {
    const runInstall = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValue(undefined);
    const isInstalled = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    await ensureLocalChromiumInstalled({
      env: localEnv,
      isInstalled,
      runInstall,
      logger: silentLogger,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(getChromiumInstallState()).toEqual({ status: "ready" });

    // A later failure starts the ladder from the first rung again.
    resetChromiumInstallStateForTests();
    const again = failingInstall();
    await ensureLocalChromiumInstalled({
      env: localEnv,
      isInstalled: async () => false,
      runInstall: again,
      logger: silentLogger,
    });
    expect(getChromiumInstallState()).toMatchObject({
      attempts: 1,
      retryAt: Date.now() + 30_000,
    });
  });

  it("a click cancels the booked retry and starts now", async () => {
    const auto = failingInstall();
    const isInstalled = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValue(false);
    await ensureLocalChromiumInstalled({
      env: localEnv,
      isInstalled,
      runInstall: auto,
      logger: silentLogger,
    });

    const explicit = vi.fn<() => Promise<void>>(async () => {});
    const state = await startChromiumInstall({
      isInstalled: vi
        .fn<() => Promise<boolean>>()
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true),
      runInstall: explicit,
    });
    expect(state.status).toBe("installing");
    await vi.waitFor(() =>
      expect(getChromiumInstallState()).toEqual({ status: "ready" }),
    );
    expect(explicit).toHaveBeenCalledTimes(1);

    // The automatic attempt that was booked never runs.
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(auto).toHaveBeenCalledTimes(1);
  });

  it("a click that fails books its own retry", async () => {
    const runInstall = failingInstall();
    await startChromiumInstall({
      isInstalled: async () => false,
      runInstall,
    });
    await vi.waitFor(() =>
      expect(getChromiumInstallState().status).toBe("failed"),
    );
    const state = getChromiumInstallState();
    expect(state).toMatchObject({ attempts: 1 });
    const retryAt = (state as { retryAt?: number }).retryAt ?? 0;
    expect(retryAt).toBeGreaterThan(Date.now());
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runInstall).toHaveBeenCalledTimes(2);
  });
});
