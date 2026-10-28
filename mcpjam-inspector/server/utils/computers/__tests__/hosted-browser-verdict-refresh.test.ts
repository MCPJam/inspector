import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A hosted replica's hosted-browser verdict: answered at boot, refreshed every
 * minute without credentials, and refused once its last answer is too old.
 *
 * `HOSTED_MODE` is read at module load, so each test imports the module fresh
 * after setting the environment.
 */
const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../logger.js", () => ({ logger }));

type RuntimeConfig = typeof import("../runtime-config");

const BOOT = { exposable: true, desktopProvisionable: true };

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Boot answers `boot`; each verdict refresh takes the next queued answer. */
function stubBackend(boot: unknown, refreshes: Array<() => Response>) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith("/internal/v1/computers/runtime-config")) {
      return respond({ enabled: false, hostedBrowser: boot });
    }
    const next = refreshes.shift();
    if (!next) throw new Error("unexpected verdict refresh");
    return next();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function load(hosted: boolean): Promise<RuntimeConfig> {
  vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", hosted ? "true" : "false");
  vi.resetModules();
  const mod = await import("../runtime-config");
  mod.resetComputersRuntimeConfigBootstrapForTests();
  await mod.initComputersRuntimeConfigBootstrap({ sleep: async () => {} });
  return mod;
}

const verdictRefreshCalls = (fetchMock: ReturnType<typeof stubBackend>) =>
  fetchMock.mock.calls.filter(([url]) =>
    String(url).endsWith("/internal/v1/computers/hosted-browser"),
  ).length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-28T00:00:00Z"));
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
  vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
  for (const fn of Object.values(logger)) fn.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("hosted-browser verdict freshness", () => {
  it("launches on a fresh boot answer", async () => {
    stubBackend(BOOT, []);
    const mod = await load(true);

    expect(mod.isHostedBrowserRefused()).toBe(false);
    expect(mod.isHostedDesktopUnavailable()).toBe(false);
    expect(mod.hostedBrowserAdvertisable()).toBe(true);
  });

  it("refuses new launches once the last answer is older than five minutes", async () => {
    stubBackend(BOOT, []);
    const mod = await load(true);

    vi.advanceTimersByTime(mod.HOSTED_BROWSER_VERDICT_MAX_AGE_MS - 1);
    expect(mod.isHostedBrowserRefused()).toBe(false);

    vi.advanceTimersByTime(2);
    expect(mod.isHostedBrowserVerdictStale()).toBe(true);
    // Every launch path reads one of these three.
    expect(mod.isHostedBrowserRefused()).toBe(true);
    expect(mod.isHostedDesktopUnavailable()).toBe(true);
    expect(mod.hostedBrowserAdvertisable()).toBe(false);
  });

  it("a successful refresh renews the answer", async () => {
    const fetchMock = stubBackend(BOOT, [
      () => respond({ ok: true, hostedBrowser: BOOT }),
    ]);
    const mod = await load(true);

    vi.advanceTimersByTime(4 * 60_000);
    await expect(mod.refreshHostedBrowserVerdict()).resolves.toBe("answered");
    vi.advanceTimersByTime(4 * 60_000);

    expect(mod.isHostedBrowserRefused()).toBe(false);
    expect(verdictRefreshCalls(fetchMock)).toBe(1);
  });

  it("a refresh that withdraws the browser takes effect without a redeploy", async () => {
    stubBackend(BOOT, [
      () =>
        respond({
          ok: true,
          hostedBrowser: {
            exposable: false,
            reason: "desktop_template_unset",
            desktopProvisionable: false,
          },
        }),
    ]);
    const mod = await load(true);

    await mod.refreshHostedBrowserVerdict();

    expect(mod.isHostedBrowserRefused()).toBe(true);
    expect(mod.isHostedDesktopUnavailable()).toBe(true);
  });

  it("a failed refresh keeps the last answer until it expires, and reports the outage once", async () => {
    stubBackend(BOOT, [
      () => respond({ ok: false }, 500),
      () => respond({ ok: false }, 500),
      () => respond({ ok: false }, 500),
    ]);
    const mod = await load(true);

    await expect(mod.refreshHostedBrowserVerdict()).resolves.toBe("failed");
    expect(mod.isHostedBrowserRefused()).toBe(false);
    expect(logger.error).not.toHaveBeenCalled();

    vi.advanceTimersByTime(mod.HOSTED_BROWSER_VERDICT_MAX_AGE_MS + 1);
    await mod.refreshHostedBrowserVerdict();
    await mod.refreshHostedBrowserVerdict();

    expect(mod.isHostedBrowserRefused()).toBe(true);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("keeps the boot answer for good on a backend that predates the route", async () => {
    const fetchMock = stubBackend(BOOT, [() => respond({}, 404)]);
    const mod = await load(true);

    await expect(mod.refreshHostedBrowserVerdict()).resolves.toBe(
      "route-missing",
    );
    vi.advanceTimersByTime(60 * 60_000);

    expect(mod.isHostedBrowserVerdictStale()).toBe(false);
    expect(mod.isHostedBrowserRefused()).toBe(false);
    // And it stops asking.
    await expect(mod.refreshHostedBrowserVerdict()).resolves.toBe(
      "route-missing",
    );
    expect(verdictRefreshCalls(fetchMock)).toBe(1);
  });

  it("never goes stale on a local inspector", async () => {
    stubBackend(BOOT, []);
    const mod = await load(false);

    vi.advanceTimersByTime(60 * 60_000);

    expect(mod.isHostedBrowserVerdictStale()).toBe(false);
    expect(mod.isHostedBrowserRefused()).toBe(false);
  });
});

describe("startHostedBrowserVerdictRefresh", () => {
  it("re-asks every minute in hosted mode, once however often it is started", async () => {
    const fetchMock = stubBackend(BOOT, [
      () => respond({ ok: true, hostedBrowser: BOOT }),
      () => respond({ ok: true, hostedBrowser: BOOT }),
    ]);
    const mod = await load(true);

    mod.startHostedBrowserVerdictRefresh();
    mod.startHostedBrowserVerdictRefresh();
    await vi.advanceTimersByTimeAsync(
      2 * mod.HOSTED_BROWSER_VERDICT_REFRESH_MS,
    );

    expect(verdictRefreshCalls(fetchMock)).toBe(2);
    mod.stopHostedBrowserVerdictRefresh();
  });

  it("does nothing on a local inspector", async () => {
    const fetchMock = stubBackend(BOOT, []);
    const mod = await load(false);

    mod.startHostedBrowserVerdictRefresh();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    expect(verdictRefreshCalls(fetchMock)).toBe(0);
  });
});
