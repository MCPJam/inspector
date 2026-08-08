import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const init = vi.fn();
const replayIntegration = vi.fn(() => ({ name: "Replay" }));
const browserTracingIntegration = vi.fn(() => ({ name: "BrowserTracing" }));

vi.mock("@sentry/react", () => ({
  init,
  replayIntegration,
  browserTracingIntegration,
}));

describe("client sentry init", () => {
  beforeEach(() => {
    vi.stubGlobal("__APP_VERSION__", "2.34.0-test");
    init.mockClear();
    replayIntegration.mockClear();
    browserTracingIntegration.mockClear();
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
});
