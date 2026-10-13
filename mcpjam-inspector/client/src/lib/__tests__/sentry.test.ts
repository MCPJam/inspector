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

async function allowFullContext() {
  const telemetry = await import("../telemetry-context");
  telemetry.setTelemetryActor("user_01K00000000000000000000000");
  telemetry.setTelemetryCaptureContext({
    projectIds: ["project_test"],
    organizationIds: [],
  });
  (await import("../session-privacy")).setSessionPrivacy("full");
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

  it("takes credentials out of replay events at every level", async () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
    vi.resetModules();
    const hooks: Record<string, Array<(e: unknown, h?: object) => void>> = {};
    getClient.mockReturnValue({
      on: (hook: string, fn: (e: unknown, h?: object) => void) => {
        (hooks[hook] ??= []).push(fn);
      },
    });
    const { initSentry } = await import("../sentry");
    const { setSessionPrivacy } = await import("../session-privacy");
    initSentry();

    // A segment the guard's stop flushed after the address bar moved onto a
    // credential page, at full.
    setSessionPrivacy("full");
    const event = {
      type: "replay_event",
      transaction: "/results/tok_secret",
      request: { url: "https://app.mcpjam.com/results/tok_secret" },
      urls: ["https://app.mcpjam.com/evals/shared/tok_secret"],
    };
    const hint = {};
    for (const fn of hooks.preprocessEvent ?? []) fn(event, hint);
    for (const fn of hooks.postprocessEvent ?? []) fn(event, hint);
    expect(event.urls).toEqual([
      "https://app.mcpjam.com/evals/shared/[redacted]",
    ]);
    expect(JSON.stringify(event)).not.toContain("tok_secret");
    getClient.mockReset();
  });

  it("filters standalone spans, which carry the scope's raw path", async () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
    vi.resetModules();
    init.mockClear();
    const { initSentry } = await import("../sentry");
    const { setSessionPrivacy } = await import("../session-privacy");
    initSentry();
    const config = init.mock.calls[0][0];
    // An INP span, as Sentry sends it on its own.
    const inp = () => ({
      op: "ui.interaction.click",
      description: "body > button",
      data: {
        "sentry.op": "ui.interaction.click",
        transaction: "/servers/acme/results/tok_secret?code=abc",
      },
    });

    setSessionPrivacy("full");
    const full = config.beforeSendSpan(inp());
    expect(JSON.stringify(full)).not.toContain("tok_secret");
    expect(full.data.transaction).toContain("/servers/acme/");

    setSessionPrivacy("masked");
    const masked = config.beforeSendSpan(inp());
    expect(JSON.stringify(masked)).not.toContain("tok_secret");
    expect(masked.data.transaction).not.toContain("acme");
  });

  it("names spans by credential template and scrubs transactions last", async () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
    vi.resetModules();
    init.mockClear();
    browserTracingIntegration.mockClear();
    const { initSentry } = await import("../sentry");
    const { setSessionPrivacy } = await import("../session-privacy");
    initSentry();
    const tracing = (
      browserTracingIntegration.mock.calls.at(-1) as unknown as [
        { beforeStartSpan: (o: { name: string }) => { name: string } },
      ]
    )[0];
    expect(tracing.beforeStartSpan({ name: "/results/tok_secret" }).name).toBe(
      "/results/:runToken",
    );
    // Short of a credential, the path is what `full` records.
    expect(tracing.beforeStartSpan({ name: "/servers/acme" }).name).toBe(
      "/servers/acme",
    );

    setSessionPrivacy("full");
    const config = init.mock.calls[0][0];
    const sent = config.beforeSendTransaction(
      {
        type: "transaction",
        transaction: "/servers",
        spans: [{ description: "GET /api/web/score/runs/tok_secret" }],
      },
      {},
    );
    expect(JSON.stringify(sent)).not.toContain("tok_secret");
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
      const { syncSentryReplay } = await loadAt("masked");

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

  it("needs no restart between full and masked: it masks at both", async () => {
    const { syncSentryReplay, setSessionPrivacy } = await loadAt("full");
    const replay = stubReplay(true);

    syncSentryReplay("/servers");
    setSessionPrivacy("masked");
    syncSentryReplay("/servers");
    setSessionPrivacy("full");
    syncSentryReplay("/servers");

    expect(replay.stop).not.toHaveBeenCalled();
    expect(replay.start).not.toHaveBeenCalled();
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

    setSessionPrivacy("masked");
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
    expect(JSON.stringify(config.beforeSend(makeEvent(), {}))).not.toMatch(
      /test.convex.cloud|ab1234/,
    );
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
    ).toEqual(["UnknownError"]);
  });
});

describe("identity at the outbound boundary", () => {
  type Hook = (event: Record<string, any>, hint?: object) => void;

  async function setup() {
    vi.resetModules();
    init.mockClear();
    const hooks: Record<string, Hook[]> = {};
    getClient.mockReturnValue({
      on: (hook: string, fn: Hook) => {
        (hooks[hook] ??= []).push(fn);
      },
    });
    const { initSentry } = await import("../sentry");
    const telemetry = await import("../telemetry-context");
    await allowFullContext();
    initSentry();
    const config = init.mock.calls[0][0];
    const run = (name: string, event: Record<string, any>, hint: object) => {
      for (const fn of hooks[name] ?? []) fn(event, hint);
    };
    return { config, run, telemetry };
  }

  const userEvent = () => ({
    user: {
      id: "user_01K00000000000000000000000",
      email: "zelda.quixote@acme-synthetic.example",
      username: "zelda.quixote@acme-synthetic.example",
      name: "Zelda",
      ip_address: "203.0.113.9",
    },
  });

  afterEach(() => {
    getClient.mockReset();
  });

  it("keeps names only when allowed at capture and still allowed at send", async () => {
    const { config, run, telemetry } = await setup();
    telemetry.setTelemetryActor("user_01K00000000000000000000000");
    telemetry.setTelemetryIdentity("user_01K00000000000000000000000", "full");
    const hint = {};
    const event = userEvent();
    run("preprocessEvent", event, hint);
    run("postprocessEvent", event, hint);
    expect(config.beforeSend(event, hint)?.user.email).toBe(
      "zelda.quixote@acme-synthetic.example",
    );
    telemetry.setTelemetryActor(null);
  });

  it("keeps an event captured while id-only id-only, even once names are allowed", async () => {
    const { config, run, telemetry } = await setup();
    telemetry.setTelemetryActor("user_01K00000000000000000000000");
    const hint = {};
    const event = userEvent();
    run("preprocessEvent", event, hint);
    telemetry.setTelemetryIdentity("user_01K00000000000000000000000", "full");
    run("postprocessEvent", event, hint);
    expect(event.user).toEqual({ id: "user_01K00000000000000000000000" });
    expect(config.beforeSend(userEvent(), hint)?.user).toEqual({
      id: "user_01K00000000000000000000000",
    });
    telemetry.setTelemetryActor(null);
  });

  it("strips names from an event whose grant went before it was sent", async () => {
    const { config, run, telemetry } = await setup();
    telemetry.setTelemetryActor("user_01K00000000000000000000000");
    telemetry.setTelemetryIdentity("user_01K00000000000000000000000", "full");
    const hint = {};
    run("preprocessEvent", userEvent(), hint);
    telemetry.setTelemetryActor("user_01K00000000000000000000001");
    expect(config.beforeSend(userEvent(), hint)?.user).toEqual({
      id: "user_01K00000000000000000000000",
    });
    expect(config.beforeSendTransaction(userEvent(), hint).user).toEqual({
      id: "user_01K00000000000000000000000",
    });
    telemetry.setTelemetryActor(null);
  });

  it("filters replay events, which never reach beforeSend", async () => {
    const { run, telemetry } = await setup();
    telemetry.setTelemetryActor("user_01K00000000000000000000000");
    const hint = {};
    const replay = { type: "replay_event", urls: [], ...userEvent() };
    run("preprocessEvent", replay, hint);
    run("postprocessEvent", replay, hint);
    expect(replay.user).toEqual({ id: "user_01K00000000000000000000000" });
    telemetry.setTelemetryActor(null);
  });

  it("treats an event with no capture-time record as id-only", async () => {
    const { config, telemetry } = await setup();
    telemetry.setTelemetryActor("user_01K00000000000000000000000");
    telemetry.setTelemetryIdentity("user_01K00000000000000000000000", "full");
    expect(config.beforeSend(userEvent(), {})?.user).toEqual({
      id: "user_01K00000000000000000000000",
    });
    telemetry.setTelemetryActor(null);
  });
});

describe("content at the outbound boundary", () => {
  it("wires the breadcrumb filter and scrubs the page URL of a masked event", async () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
    vi.resetModules();
    init.mockClear();
    const hooks: Record<string, Array<(e: unknown, h?: object) => void>> = {};
    getClient.mockReturnValue({
      on: (hook: string, fn: (e: unknown, h?: object) => void) => {
        (hooks[hook] ??= []).push(fn);
      },
    });
    const { initSentry } = await import("../sentry");
    const privacy = await import("../session-privacy");
    initSentry();
    const config = init.mock.calls[0][0];

    privacy.setSessionPrivacy("masked");
    expect(config.beforeBreadcrumb({ category: "console" })).toBeNull();
    const hint = {};
    for (const fn of hooks.preprocessEvent ?? []) fn({}, hint);
    const event = config.beforeSend(
      { request: { url: "https://app.mcpjam.com/servers/acme" } },
      hint,
    );
    expect(event.request).toBeUndefined();

    // Captured masked, sent after the level went full: still scrubbed.
    privacy.setSessionPrivacy("full");
    expect(
      config.beforeSend(
        { request: { url: "https://app.mcpjam.com/servers/acme" } },
        hint,
      ).request,
    ).toBeUndefined();

    // The raw path in `transaction` (set by browserTracingIntegration on
    // every navigation) and the Referer header are scrubbed too.
    const withPath = config.beforeSend(
      {
        transaction: "/p/kd7a8f9g0h1j2k3l4m5n6p7q8r/servers/acme-billing",
        request: {
          url: "https://app.mcpjam.com/servers/acme",
          headers: {
            Referer: "https://app.mcpjam.com/servers/globex",
            "User-Agent": "test",
          },
        },
      },
      hint,
    );
    expect(withPath.transaction).toBeUndefined();
    expect(withPath.request).toBeUndefined();

    // Captured and sent in a resolved full context: untouched.
    await allowFullContext();
    const fullHint = {};
    for (const fn of hooks.preprocessEvent ?? []) fn({}, fullHint);
    expect(
      config.beforeSend(
        { request: { url: "https://app.mcpjam.com/servers/acme" } },
        fullHint,
      ).request.url,
    ).toBe("https://app.mcpjam.com/servers/acme");
    expect(
      config.beforeSend({ transaction: "/servers/acme" }, fullHint).transaction,
    ).toBe("/servers/acme");
    getClient.mockReset();
  });

  it("runs the config's breadcrumb content scrub ahead of the level filter", async () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
    vi.resetModules();
    init.mockClear();
    const { initSentry } = await import("../sentry");
    const privacy = await import("../session-privacy");
    initSentry();
    const config = init.mock.calls[0][0];

    // At full the level filter keeps console breadcrumbs; the logged
    // payload still loses its value.
    await allowFullContext();
    privacy.setSessionPrivacy("full");
    const crumb = config.beforeBreadcrumb({
      category: "console",
      message: "tool result { body: acme contract }",
      data: { arguments: ["tool result", { body: "acme contract" }] },
    });
    expect(crumb.data).toEqual({ argumentCount: 2 });
    expect(JSON.stringify(crumb)).not.toContain("acme contract");
  });
});

describe("performance transactions short of full", () => {
  it("keep timing but lose URLs, peer hosts and selector attribute values", async () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
    vi.resetModules();
    init.mockClear();
    getClient.mockReturnValue({ on: () => {} });
    const { initSentry } = await import("../sentry");
    const privacy = await import("../session-privacy");
    initSentry();
    const config = init.mock.calls[0][0];
    privacy.setSessionPrivacy("masked");

    const event = config.beforeSendTransaction(
      {
        transaction: "/results/kd7a8f9g0h1j2k3l4m5n6p7q8r9s",
        contexts: {
          trace: {
            data: {
              "url.full": "https://app.mcpjam.com/servers/acme-billing",
              "lcp.element": 'h1.title[title="Zelda\'s dashboard"]',
              "cls.source.1": 'img.avatar[alt="Zelda"]',
            },
          },
        },
        spans: [
          {
            description: "GET https://cdn.acme.example/avatars/zelda.png",
            data: {
              "server.address": "cdn.acme.example",
              "url.full": "https://cdn.acme.example/avatars/zelda.png",
              "http.response_transfer_size": 1057,
            },
            start_timestamp: 1,
            timestamp: 2,
          },
          {
            description: "GET /api/web/servers/acme-billing?tab=tools",
            data: { "http.query": "?q=zelda", "http.fragment": "#acme" },
            start_timestamp: 2,
            timestamp: 3,
          },
        ],
      },
      {},
    );

    // A request to a relative URL, and its query and fragment kept apart.
    expect(event.spans[1]).toEqual({
      description: "GET /api/web/servers/[name]?tab=[name]",
      data: { "http.query": "?q=[name]", "http.fragment": "" },
      start_timestamp: 2,
      timestamp: 3,
    });
    expect(event.transaction).toBe("/results/[redacted]");
    expect(event.contexts.trace.data).toEqual({
      "url.full": "https://app.mcpjam.com/servers/[name]",
      "lcp.element": "h1.title",
      "cls.source.1": "img.avatar",
    });
    expect(event.spans[0]).toEqual({
      description: "GET https://[host]/[name]/[name]",
      data: {
        "server.address": "[host]",
        "url.full": "https://[host]/[name]/[name]",
        "http.response_transfer_size": 1057,
      },
      start_timestamp: 1,
      timestamp: 2,
    });
    getClient.mockReset();
  });
});

describe("syncSentryReplay, a quick in-and-out", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("resumes only after the guard's stop has finished flushing", async () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
    vi.resetModules();
    const { syncSentryReplay } = await import("../sentry");
    const { setSessionPrivacy } = await import("../session-privacy");
    setSessionPrivacy("full");
    let finishStop: () => void = () => {};
    const replay = {
      start: vi.fn(),
      stop: vi.fn(() => new Promise<void>((resolve) => (finishStop = resolve))),
      getReplayId: vi.fn(() => "replay-id"),
    };
    getClient.mockReturnValue({ getIntegrationByName: () => replay });

    syncSentryReplay("/results/tok");
    syncSentryReplay("/servers");
    expect(replay.start).not.toHaveBeenCalled();

    finishStop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replay.start).toHaveBeenCalledTimes(1);
  });

  it("waits for the first stop when a second stop returns at once", async () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
    vi.resetModules();
    const { syncSentryReplay } = await import("../sentry");
    const { setSessionPrivacy } = await import("../session-privacy");
    setSessionPrivacy("full");
    const events: string[] = [];
    let finishFirstStop: () => void = () => {};
    let stops = 0;
    const replay = {
      start: vi.fn(() => events.push("start")),
      // Like Sentry's: the first stop flushes for a while; a stop while the
      // replay is already stopping returns a resolved promise.
      stop: vi.fn(() => {
        stops += 1;
        if (stops > 1) return Promise.resolve();
        return new Promise<void>((resolve) => {
          finishFirstStop = () => {
            events.push("first stop settled");
            resolve();
          };
        });
      }),
      getReplayId: vi.fn(() => (stops === 0 ? "replay-id" : undefined)),
    };
    getClient.mockReturnValue({ getIntegrationByName: () => replay });

    syncSentryReplay("/results/a");
    syncSentryReplay("/results/b");
    expect(replay.stop).toHaveBeenCalledTimes(2);
    syncSentryReplay("/servers");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replay.start).not.toHaveBeenCalled();

    finishFirstStop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(["first stop settled", "start"]);
  });

  it("stays stopped when the location is blocked again before the flush ends", async () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
    vi.resetModules();
    const { syncSentryReplay } = await import("../sentry");
    const { setSessionPrivacy } = await import("../session-privacy");
    setSessionPrivacy("full");
    // Every stop issued so far finishes flushing together.
    const flushing: (() => void)[] = [];
    const finishStop = () => flushing.splice(0).forEach((resolve) => resolve());
    const replay = {
      start: vi.fn(),
      stop: vi.fn(() => new Promise<void>((resolve) => flushing.push(resolve))),
      getReplayId: vi.fn(() => "replay-id"),
    };
    getClient.mockReturnValue({ getIntegrationByName: () => replay });

    syncSentryReplay("/results/a");
    syncSentryReplay("/servers");
    syncSentryReplay("/results/b");
    finishStop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replay.start).not.toHaveBeenCalled();

    // …and still resumes on the way out.
    syncSentryReplay("/servers");
    finishStop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(replay.start).toHaveBeenCalledTimes(1);
  });
});
