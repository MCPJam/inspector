import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const init = vi.fn();
const replayIntegration = vi.fn(() => ({ name: "Replay" }));
const browserTracingIntegration = vi.fn(() => ({ name: "BrowserTracing" }));
const getClient = vi.fn();

vi.mock("@sentry/react", () => ({
  init,
  replayIntegration,
  browserTracingIntegration,
  getClient,
}));

/** Stand in for the Replay integration instance the client hands back. */
function stubReplay(recording: boolean) {
  const replay = {
    start: vi.fn(),
    stop: vi.fn(),
    getReplayId: vi.fn(() => (recording ? "replay-id" : undefined)),
  };
  getClient.mockReturnValue({ getIntegrationByName: () => replay });
  return replay;
}

describe("client sentry init", () => {
  beforeEach(() => {
    vi.stubGlobal("__APP_VERSION__", "2.34.0-test");
    vi.stubGlobal("__BUILD_SURFACE__", "npm");
    init.mockClear();
    replayIntegration.mockClear();
    browserTracingIntegration.mockClear();
    getClient.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("tags self_hosted and stamps the bundle version as the release", async () => {
    const { resolveClientSentryConfig } = await import("../sentry");
    const config = resolveClientSentryConfig();

    expect(config.release).toBe("2.34.0-test");
    expect(config.initialScope).toEqual({
      tags: { deployment: "self_hosted" },
    });
    expect(config.sendDefaultPii).toBe(false);
  });

  it("reports the build surface as dist so artifacts resolve per build", async () => {
    // The release alone is the bare app version, which the web, npm and
    // desktop builds all share. Without `dist` here, Sentry symbolicates this
    // bundle's events against whichever of those uploaded last.
    const { resolveClientSentryConfig } = await import("../sentry");

    expect(resolveClientSentryConfig().dist).toBe("npm");
  });

  it("tags hosted when the bundle is built for hosted mode", async () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.resetModules();
    const { resolveClientSentryConfig } = await import("../sentry");

    expect(resolveClientSentryConfig().initialScope.tags.deployment).toBe(
      "hosted",
    );
  });

  it("derives environment from the Vite build mode, not NODE_ENV", async () => {
    const { resolveClientSentryConfig } = await import("../sentry");
    // Asserted against the literal the dev/test bundle must produce, NOT
    // against `import.meta.env.PROD ? ... : ...` — mirroring the
    // implementation expression would make this pass no matter what the
    // implementation did.
    expect(import.meta.env.PROD).toBe(false);
    expect(resolveClientSentryConfig().environment).toBe("dev");
  });

  it("does not record replays on a self-hosted web build", async () => {
    // Sentry Replay records DOM+text like rrweb. Same boundary as PostHog:
    // hosted + packaged desktop only.
    const { initSentry, resolveClientSentryConfig } = await import("../sentry");

    expect(resolveClientSentryConfig().replaysSessionSampleRate).toBe(0);
    expect(resolveClientSentryConfig().replaysOnErrorSampleRate).toBe(0);

    initSentry();
    const config = init.mock.calls[0][0];
    // The integration must not even LOAD — zero rates alone would still ship
    // the recorder and open its buffers.
    expect(replayIntegration).not.toHaveBeenCalled();
    expect(browserTracingIntegration).toHaveBeenCalled();
    expect(config.integrations).toHaveLength(1);
  });

  it("records replays and wires both integrations on hosted", async () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.resetModules();
    const { initSentry } = await import("../sentry");

    initSentry();
    const config = init.mock.calls[0][0];
    expect(config.replaysSessionSampleRate).toBe(0.1);
    expect(config.replaysOnErrorSampleRate).toBe(1.0);
    expect(replayIntegration).toHaveBeenCalled();
    expect(config.integrations).toHaveLength(2);
  });

  it("never starts a replay for a session that LOADS on /results/", async () => {
    // The runtime guard cannot rescue this case: `replay.stop()` FLUSHES the
    // buffered segment, and that segment is the token-bearing page. The only
    // safe answer is to never construct the recorder for this session.
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubGlobal("location", {
      hostname: "app.mcpjam.com",
      origin: "https://app.mcpjam.com",
      pathname: "/results/super-secret-token",
    });
    vi.resetModules();
    const { initSentry } = await import("../sentry");

    initSentry();
    const config = init.mock.calls[0][0];
    expect(replayIntegration).not.toHaveBeenCalled();
    expect(config.replaysSessionSampleRate).toBe(0);
    expect(config.integrations).toHaveLength(1);
  });
});

describe("syncSentryReplayForPath", () => {
  beforeEach(() => {
    vi.stubGlobal("__APP_VERSION__", "2.34.0-test");
    vi.stubGlobal("__BUILD_SURFACE__", "npm");
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    getClient.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("stops an active replay on the way into /results/ and resumes it on the way out", async () => {
    const { syncSentryReplayForPath } = await import("../sentry");
    const replay = stubReplay(true);

    syncSentryReplayForPath("/results/secret-token");
    expect(replay.stop).toHaveBeenCalledTimes(1);
    expect(replay.start).not.toHaveBeenCalled();

    syncSentryReplayForPath("/servers");
    expect(replay.start).toHaveBeenCalledTimes(1);
  });

  it("keeps the resume armed across /results/ → /results/ navigation", async () => {
    // `stop()` clears the replay id, so re-reading it on the second
    // credential path would disarm the resume and the eventual exit would
    // never restart the recording.
    const { syncSentryReplayForPath } = await import("../sentry");
    const replay = stubReplay(true);
    replay.stop.mockImplementation(() =>
      replay.getReplayId.mockReturnValue(undefined),
    );

    syncSentryReplayForPath("/results/token-a");
    syncSentryReplayForPath("/results/token-b");
    syncSentryReplayForPath("/servers");

    expect(replay.stop).toHaveBeenCalledTimes(2);
    expect(replay.start).toHaveBeenCalledTimes(1);
  });

  it("does not resume a replay that was never running", async () => {
    // `start()` bypasses `replaysSessionSampleRate`, so resuming what this
    // guard did not stop would record 100% of the sessions that ever touched
    // a results link.
    const { syncSentryReplayForPath } = await import("../sentry");
    const replay = stubReplay(false);

    syncSentryReplayForPath("/results/secret-token");
    syncSentryReplayForPath("/servers");

    expect(replay.stop).toHaveBeenCalledTimes(1);
    expect(replay.start).not.toHaveBeenCalled();
  });

  it("never starts a replay on an ordinary navigation", async () => {
    const { syncSentryReplayForPath } = await import("../sentry");
    const replay = stubReplay(true);

    syncSentryReplayForPath("/servers");
    syncSentryReplayForPath("/tools");

    expect(replay.start).not.toHaveBeenCalled();
    expect(replay.stop).not.toHaveBeenCalled();
  });

  it("is a no-op on a self-hosted build", async () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "false");
    vi.resetModules();
    const { syncSentryReplayForPath } = await import("../sentry");
    const replay = stubReplay(true);

    syncSentryReplayForPath("/results/secret-token");
    expect(replay.stop).not.toHaveBeenCalled();
  });

  it("survives a missing client or a client without the Replay integration", async () => {
    // Deliberately on the hosted surface: with HOSTED_MODE off the function
    // returns at its first guard and never reaches `getClient()`, so the
    // assertion would pass no matter what the client guard did.
    const { syncSentryReplayForPath } = await import("../sentry");

    getClient.mockReturnValue(undefined);
    expect(() => syncSentryReplayForPath("/results/x")).not.toThrow();

    getClient.mockReturnValue({ getIntegrationByName: () => undefined });
    expect(() => syncSentryReplayForPath("/results/x")).not.toThrow();
    expect(() => syncSentryReplayForPath("/servers")).not.toThrow();

    // posthog-js is not the only ad-block target; a client that throws on
    // lookup must not take the render down either.
    getClient.mockReturnValue({
      getIntegrationByName: () => {
        throw new Error("blocked");
      },
    });
    expect(() => syncSentryReplayForPath("/results/x")).not.toThrow();
  });
});
