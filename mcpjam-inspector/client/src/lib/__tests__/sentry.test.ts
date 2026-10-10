import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const init = vi.fn();
const replayIntegration = vi.fn(() => ({ name: "Replay" }));
const browserTracingIntegration = vi.fn(() => ({ name: "BrowserTracing" }));
const getClient = vi.fn();
const addIntegration = vi.fn();

vi.mock("@sentry/react", () => ({
  init,
  replayIntegration,
  browserTracingIntegration,
  getClient,
  addIntegration,
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

  it("initializes desktop identity without dropping deployment tags", async () => {
    const installationId = "installation:12345678-1234-4321-8123-123456789abc";
    vi.stubGlobal("window", {
      location: { origin: "http://localhost:6274", pathname: "/" },
      electronAPI: { sentry: { installationId } },
    });
    const { initSentry } = await import("../sentry");
    initSentry();
    expect(init.mock.calls[0][0].initialScope).toEqual({
      user: { id: installationId },
      tags: { deployment: "self_hosted", actor_kind: "installation" },
    });
  });
  it("reports the build surface as dist so artifacts resolve per build", async () => {
    // The release alone is the bare app version, which the web, npm and
    // desktop builds all share. Without `dist` here, Sentry symbolicates this
    // bundle's events against whichever of those uploaded last.
    const { resolveClientSentryConfig } = await import("../sentry");

    expect(resolveClientSentryConfig().dist).toBe("npm");
  });

  it("reports by default", async () => {
    const { resolveClientSentryConfig } = await import("../sentry");

    expect(resolveClientSentryConfig().enabled).toBe(true);
  });

  it("stops reporting when the bundle is built with VITE_DISABLE_SENTRY", async () => {
    vi.stubEnv("VITE_DISABLE_SENTRY", "true");
    vi.resetModules();
    const { resolveClientSentryConfig } = await import("../sentry");

    expect(resolveClientSentryConfig().enabled).toBe(false);
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
    expect(replayIntegration).not.toHaveBeenCalled();
    expect(browserTracingIntegration).toHaveBeenCalled();
    expect(config.integrations).toHaveLength(1);
  });

  it("sets hosted sample rates but leaves the recorder to the privacy level", async () => {
    // Constructing it here and stopping it later would not do:
    // `replay.stop()` FLUSHES the buffered segment, which is exactly what a
    // `pending` session or a `/results/<token>` page must keep out.
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
    vi.resetModules();
    const { initSentry } = await import("../sentry");

    initSentry();
    const config = init.mock.calls[0][0];
    expect(config.replaysSessionSampleRate).toBe(0.1);
    expect(config.replaysOnErrorSampleRate).toBe(1.0);
    expect(replayIntegration).not.toHaveBeenCalled();
    expect(config.integrations).toHaveLength(1);
  });

  it("scrubs the replay event's URL list short of full", async () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
    vi.resetModules();
    const handlers: Record<string, (event: Record<string, unknown>) => void> =
      {};
    getClient.mockReturnValue({
      on: (hook: string, fn: (event: Record<string, unknown>) => void) => {
        handlers[hook] = fn;
      },
    });
    const { initSentry } = await import("../sentry");
    const { setSessionPrivacy } = await import("../session-privacy");
    initSentry();

    const replayEvent = () => ({
      type: "replay_event",
      urls: ["https://app.mcpjam.com/servers/acme"],
    });
    setSessionPrivacy("masked");
    const masked = replayEvent();
    handlers.preprocessEvent(masked);
    expect(masked.urls).toEqual(["https://app.mcpjam.com/servers/[name]"]);

    setSessionPrivacy("full");
    const full = replayEvent();
    handlers.preprocessEvent(full);
    expect(full.urls).toEqual(["https://app.mcpjam.com/servers/acme"]);
  });
});

describe("syncSentryReplay", () => {
  beforeEach(() => {
    vi.stubGlobal("__APP_VERSION__", "2.34.0-test");
    vi.stubGlobal("__BUILD_SURFACE__", "npm");
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
    getClient.mockReset();
    addIntegration.mockReset();
    replayIntegration.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** `../sentry` with the session already at `level`. */
  async function loadAt(
    level: import("../session-privacy").SessionPrivacy | null,
  ) {
    const privacy = await import("../session-privacy");
    if (level) privacy.setSessionPrivacy(level);
    return { ...(await import("../sentry")), ...privacy };
  }

  describe("constructing the recorder", () => {
    function clientWithoutReplay() {
      getClient.mockReturnValue({ getIntegrationByName: () => undefined });
    }

    it("never while the level is pending", async () => {
      clientWithoutReplay();
      const { syncSentryReplay } = await loadAt(null);

      syncSentryReplay("/servers");
      expect(addIntegration).not.toHaveBeenCalled();
    });

    it("once the level allows it, with the masking options", async () => {
      clientWithoutReplay();
      const { syncSentryReplay, SENTRY_REPLAY_OPTIONS } = await loadAt("full");

      syncSentryReplay("/servers");
      syncSentryReplay("/tools");

      expect(replayIntegration).toHaveBeenCalledTimes(1);
      expect(replayIntegration).toHaveBeenCalledWith(SENTRY_REPLAY_OPTIONS);
      expect(addIntegration).toHaveBeenCalledTimes(1);
    });

    it("not on a hard load onto /results/, only after leaving it", async () => {
      clientWithoutReplay();
      const { syncSentryReplay } = await loadAt("full");

      syncSentryReplay("/results/secret-token");
      expect(addIntegration).not.toHaveBeenCalled();

      syncSentryReplay("/servers");
      expect(addIntegration).toHaveBeenCalledTimes(1);
    });

    it("never on an off surface", async () => {
      vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "true");
      vi.resetModules();
      clientWithoutReplay();
      const { syncSentryReplay, currentSessionPrivacy } = await loadAt(null);

      expect(currentSessionPrivacy()).toBe("off");
      syncSentryReplay("/servers");
      expect(addIntegration).not.toHaveBeenCalled();
    });
  });

  it("stops an active replay on the way into /results/ and resumes it on the way out", async () => {
    const { syncSentryReplay } = await loadAt("full");
    const replay = stubReplay(true);

    syncSentryReplay("/results/secret-token");
    expect(replay.stop).toHaveBeenCalledTimes(1);
    expect(replay.start).not.toHaveBeenCalled();

    syncSentryReplay("/servers");
    expect(replay.start).toHaveBeenCalledTimes(1);
  });

  it("keeps the resume armed across /results/ → /results/ navigation", async () => {
    // `stop()` clears the replay id, so re-reading it on the second
    // credential path would disarm the resume and the eventual exit would
    // never restart the recording.
    const { syncSentryReplay } = await loadAt("full");
    const replay = stubReplay(true);
    replay.stop.mockImplementation(() =>
      replay.getReplayId.mockReturnValue(undefined),
    );

    syncSentryReplay("/results/token-a");
    syncSentryReplay("/results/token-b");
    syncSentryReplay("/servers");

    expect(replay.stop).toHaveBeenCalledTimes(2);
    expect(replay.start).toHaveBeenCalledTimes(1);
  });

  it("does not resume a replay that was never running", async () => {
    // `start()` bypasses `replaysSessionSampleRate`, so resuming what this
    // guard did not stop would record 100% of the sessions that ever touched
    // a results link.
    const { syncSentryReplay } = await loadAt("full");
    const replay = stubReplay(false);

    syncSentryReplay("/results/secret-token");
    syncSentryReplay("/servers");

    expect(replay.stop).toHaveBeenCalledTimes(1);
    expect(replay.start).not.toHaveBeenCalled();
  });

  it("never starts a replay on an ordinary navigation", async () => {
    const { syncSentryReplay } = await loadAt("full");
    const replay = stubReplay(true);

    syncSentryReplay("/servers");
    syncSentryReplay("/tools");

    expect(replay.start).not.toHaveBeenCalled();
    expect(replay.stop).not.toHaveBeenCalled();
  });

  it("does not record at masked: stopped on the way in, resumed at full", async () => {
    // Sentry offers no hook over rrweb's page metadata and DOM events, so a
    // masked replay is PostHog's alone.
    const { syncSentryReplay, setSessionPrivacy } = await loadAt("full");
    const replay = stubReplay(true);
    replay.stop.mockImplementation(() =>
      replay.getReplayId.mockReturnValue(undefined),
    );

    syncSentryReplay("/servers");
    setSessionPrivacy("masked");
    syncSentryReplay("/servers");
    expect(replay.stop).toHaveBeenCalledTimes(1);
    expect(replay.start).not.toHaveBeenCalled();

    setSessionPrivacy("full");
    syncSentryReplay("/servers");
    expect(replay.start).toHaveBeenCalledTimes(1);
  });

  it("resumes a buffering replay as a buffering replay", async () => {
    const { syncSentryReplay, setSessionPrivacy } = await loadAt("full");
    const replay = stubReplay(true) as ReturnType<typeof stubReplay> & {
      getRecordingMode: ReturnType<typeof vi.fn>;
      startBuffering: ReturnType<typeof vi.fn>;
    };
    replay.getRecordingMode = vi.fn(() => "buffer");
    replay.startBuffering = vi.fn();
    replay.stop.mockImplementation(() =>
      replay.getReplayId.mockReturnValue(undefined),
    );

    syncSentryReplay("/results/secret-token");
    setSessionPrivacy("full");
    syncSentryReplay("/servers");

    expect(replay.startBuffering).toHaveBeenCalledTimes(1);
    expect(replay.start).not.toHaveBeenCalled();
  });

  it("stops on a location whose query carries a secret", async () => {
    const { syncSentryReplay } = await loadAt("full");
    const replay = stubReplay(true);

    syncSentryReplay({ pathname: "/servers", search: "?code=abc" });
    expect(replay.stop).toHaveBeenCalledTimes(1);
  });

  it("holds the replay stopped while the level drops back to pending", async () => {
    const { syncSentryReplay, setSessionPrivacy } = await loadAt("full");
    const replay = stubReplay(true);
    replay.stop.mockImplementation(() =>
      replay.getReplayId.mockReturnValue(undefined),
    );

    setSessionPrivacy("pending");
    syncSentryReplay("/servers");
    expect(replay.stop).toHaveBeenCalledTimes(1);

    setSessionPrivacy("full");
    syncSentryReplay("/servers");
    expect(replay.start).toHaveBeenCalledTimes(1);
  });

  it("is a no-op on a self-hosted build", async () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "false");
    vi.resetModules();
    const { syncSentryReplay } = await loadAt(null);
    const replay = stubReplay(true);

    syncSentryReplay("/results/secret-token");
    expect(replay.stop).not.toHaveBeenCalled();
  });

  it("survives a missing client or a client without the Replay integration", async () => {
    // Deliberately on the hosted surface: with HOSTED_MODE off the function
    // returns at its first guard and never reaches `getClient()`, so the
    // assertion would pass no matter what the client guard did.
    const { syncSentryReplay } = await loadAt("full");

    getClient.mockReturnValue(undefined);
    expect(() => syncSentryReplay("/results/x")).not.toThrow();
    expect(() => syncSentryReplay("/servers")).not.toThrow();

    getClient.mockReturnValue({ getIntegrationByName: () => undefined });
    addIntegration.mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => syncSentryReplay("/servers")).not.toThrow();

    // posthog-js is not the only ad-block target; a client that throws on
    // lookup must not take the render down either.
    getClient.mockReturnValue({
      getIntegrationByName: () => {
        throw new Error("blocked");
      },
    });
    expect(() => syncSentryReplay("/results/x")).not.toThrow();
  });
});

describe("query event processor wiring", () => {
  it("does not forward events dropped by the browser filter", async () => {
    vi.resetModules();
    init.mockClear();
    const diagnostics = await import("../convex-query-diagnostics");
    const processor = vi.fn(diagnostics.createConvexQueryEventProcessor());
    const factory = vi
      .spyOn(diagnostics, "createConvexQueryEventProcessor")
      .mockReturnValue(processor);
    try {
      const { initSentry } = await import("../sentry");
      initSentry();
      const config = init.mock.calls[0][0];
      const dropped = config.beforeSend(
        {
          exception: {
            values: [
              {
                type: "Error",
                value: "injected script failure",
                stacktrace: {
                  frames: [
                    {
                      filename: `${window.location.origin}/playground`,
                      function: "injected",
                    },
                  ],
                },
              },
            ],
          },
        },
        {},
      );
      expect(dropped).toBeNull();
      expect(processor).not.toHaveBeenCalled();
    } finally {
      factory.mockRestore();
    }
  });

  it("enriches global errors, deduplicates boundary reports and retains DOM grouping", async () => {
    vi.resetModules();
    init.mockClear();
    const { configureConvexQueryDiagnostics } =
      await import("../convex-query-diagnostics");
    configureConvexQueryDiagnostics("https://test.convex.cloud");
    const { initSentry } = await import("../sentry");
    initSentry();
    const config = init.mock.calls[0][0];
    const makeEvent = () => ({
      exception: {
        values: [
          {
            type: "Error",
            value:
              "[CONVEX Q(scenarios:listScenarios)] [Request ID: ab1234] Server Error",
          },
        ],
      },
    });
    expect(config.beforeSend(makeEvent(), {}).tags).toMatchObject({
      convex_backend: "test.convex.cloud",
      request_id: "ab1234",
    });
    expect(config.beforeSend(makeEvent(), {})).toBeNull();
    expect(
      config.beforeSend(
        {
          environment: "prod",
          exception: {
            values: [
              {
                type: "NotFoundError",
                value: "Failed to execute 'removeChild' on 'Node': not a child",
              },
            ],
          },
        },
        {},
      ).fingerprint,
    ).toEqual(["dom-mutation-conflict", "prod"]);
  });
});
