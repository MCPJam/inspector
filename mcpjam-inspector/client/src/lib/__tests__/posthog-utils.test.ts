import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  detectEnvironment,
  getPageviewCaptureOptions,
  isPostHogBooleanFlagOn,
  options,
  standardEventProps,
} from "../PosthogUtils";

describe("PosthogUtils", () => {
  beforeEach(() => {
    vi.stubGlobal("__APP_VERSION__", "2.0.13-test");
  });

  it("isPostHogBooleanFlagOn accepts PostHog quirks", () => {
    expect(isPostHogBooleanFlagOn(true)).toBe(true);
    expect(isPostHogBooleanFlagOn(false)).toBe(false);
    expect(isPostHogBooleanFlagOn(undefined)).toBe(false);
    expect(isPostHogBooleanFlagOn("true")).toBe(true);
    expect(isPostHogBooleanFlagOn(" TRUE ")).toBe(true);
    expect(isPostHogBooleanFlagOn("yes")).toBe(true);
    expect(isPostHogBooleanFlagOn("control")).toBe(false);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("registers static telemetry properties on PostHog load", () => {
    const posthog = {
      register: vi.fn(),
    };

    options.loaded(posthog);

    expect(posthog.register).toHaveBeenCalledWith({
      environment: import.meta.env.MODE,
      platform: expect.any(String),
      version: "2.0.13-test",
      // Test build has VITE_MCPJAM_HOSTED_MODE unset -> self_hosted.
      deployment: "self_hosted",
      source: "client",
    });
  });

  it("registers deployment: hosted when built for hosted mode", async () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.resetModules();
    const { options: hostedOptions } = await import("../PosthogUtils");

    const posthog = { register: vi.fn() };
    hostedOptions.loaded(posthog);

    expect(posthog.register).toHaveBeenCalledWith(
      expect.objectContaining({ deployment: "hosted", source: "client" }),
    );
  });

  describe("standardEventProps / detectEnvironment", () => {
    it("omits environment when VITE_ENVIRONMENT is unset, so the registered super-property wins", () => {
      // Neither Vite's envPrefix ("VITE_") nor .env.production expose an
      // unprefixed ENVIRONMENT to the client bundle — this must resolve to
      // undefined, not silently pick up a same-named var from elsewhere.
      expect(detectEnvironment()).toBeUndefined();

      const props = standardEventProps("skills_tab");
      expect(props).not.toHaveProperty("environment");
      expect(props.location).toBe("skills_tab");
    });

    it("includes environment when VITE_ENVIRONMENT is set", async () => {
      vi.stubEnv("VITE_ENVIRONMENT", "staging");
      vi.resetModules();
      const mod = await import("../PosthogUtils");

      expect(mod.detectEnvironment()).toBe("staging");
      expect(mod.standardEventProps("skills_tab")).toMatchObject({
        environment: "staging",
      });
    });
  });

  it("opts capture out by default when VITE_DISABLE_POSTHOG_LOCAL is set", async () => {
    vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "true");
    vi.resetModules();
    const { getPostHogOptions } = await import("../PosthogUtils");

    const opts = getPostHogOptions() as Record<string, unknown>;

    expect(opts.opt_out_capturing_by_default).toBe(true);
    // Guard against re-introducing the typo: `opt_out_capturing` is a method
    // on PostHog instances, not a valid init config field.
    expect(opts).not.toHaveProperty("opt_out_capturing");
  });

  it("does not opt out when the disable flag is unset", async () => {
    vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
    vi.resetModules();
    const { getPostHogOptions } = await import("../PosthogUtils");

    const opts = getPostHogOptions() as Record<string, unknown>;

    expect(opts.opt_out_capturing_by_default).toBeUndefined();
  });

  describe("replay + exception capture surface matrix", () => {
    // The four shapes that reach getPostHogOptions(). Replay and
    // capture_exceptions are ON for hosted + Electron desktop only; dead
    // clicks are on everywhere because they cost nothing extra.
    it("self-hosted web (npx/docker): no replay, no exceptions", async () => {
      vi.resetModules();
      const { options: opts, isErrorCaptureSurface } = await import(
        "../PosthogUtils"
      );

      expect(isErrorCaptureSurface()).toBe(false);
      expect(opts.capture_exceptions).toBe(false);
      expect(opts.disable_session_recording).toBe(true);
      expect(opts.capture_dead_clicks).toBe(true);
    });

    it("hosted: replay + exceptions on", async () => {
      vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
      vi.resetModules();
      const { options: opts, isErrorCaptureSurface } = await import(
        "../PosthogUtils"
      );

      expect(isErrorCaptureSurface()).toBe(true);
      expect(opts.capture_exceptions).toBe(true);
      expect(opts.disable_session_recording).toBe(false);
    });

    it("electron desktop: replay + exceptions on", async () => {
      vi.stubGlobal("window", { ...window, isElectron: true });
      vi.resetModules();
      const { options: opts, isErrorCaptureSurface } = await import(
        "../PosthogUtils"
      );

      expect(isErrorCaptureSurface()).toBe(true);
      expect(opts.capture_exceptions).toBe(true);
      expect(opts.disable_session_recording).toBe(false);
    });

    it("disabled branch: recorder and exception handlers never load", async () => {
      vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "true");
      vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
      vi.resetModules();
      const { getPostHogOptions } = await import("../PosthogUtils");

      const opts = getPostHogOptions() as Record<string, unknown>;
      // Even on hosted, the opt-out branch must not fetch the recorder:
      // opt_out_capturing_by_default suppresses sending, not loading.
      expect(opts.disable_session_recording).toBe(true);
      expect(opts.capture_exceptions).toBe(false);
    });

    it("never records on bearer-credential /results/ URLs", async () => {
      vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
      vi.stubGlobal("location", {
        hostname: "app.mcpjam.com",
        origin: "https://app.mcpjam.com",
        pathname: "/results/super-secret-token",
      });
      vi.resetModules();
      const { options: opts, shouldRecordSession, isCredentialBearingPath } =
        await import("../PosthogUtils");

      expect(isCredentialBearingPath("/results/abc")).toBe(true);
      expect(isCredentialBearingPath("/servers")).toBe(false);
      expect(shouldRecordSession()).toBe(false);
      expect(opts.disable_session_recording).toBe(true);
    });

    it("masks inputs and every annotated secret surface", async () => {
      vi.resetModules();
      const { SESSION_RECORDING_OPTIONS, options: opts } = await import(
        "../PosthogUtils"
      );

      expect(SESSION_RECORDING_OPTIONS.maskAllInputs).toBe(true);
      expect(SESSION_RECORDING_OPTIONS.maskInputOptions).toEqual({
        password: true,
      });
      // Reuses the repo's existing `data-ph-no-capture` convention rather
      // than a second attribute — annotate a secret surface once, get both
      // autocapture opt-out and replay masking.
      expect(SESSION_RECORDING_OPTIONS.maskTextSelector).toBe(
        "[data-ph-no-capture]",
      );
      expect(opts.session_recording).toBe(SESSION_RECORDING_OPTIONS);
    });

    it("stops recording at runtime when navigating INTO /results/", async () => {
      // The init-time flag cannot cover SPA navigation into the route: the
      // recorder is already running by then and rrweb snapshots the address
      // bar, token and all.
      vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
      vi.resetModules();
      const { syncSessionRecordingForPath } = await import("../PosthogUtils");
      const client = {
        startSessionRecording: vi.fn(),
        stopSessionRecording: vi.fn(),
      };

      syncSessionRecordingForPath(client, "/results/secret-token");
      expect(client.stopSessionRecording).toHaveBeenCalledTimes(1);
      expect(client.startSessionRecording).not.toHaveBeenCalled();

      syncSessionRecordingForPath(client, "/servers");
      expect(client.startSessionRecording).toHaveBeenCalledTimes(1);
    });

    it("never starts recording on a non-capture surface", async () => {
      vi.resetModules();
      const { syncSessionRecordingForPath } = await import("../PosthogUtils");
      const client = {
        startSessionRecording: vi.fn(),
        stopSessionRecording: vi.fn(),
      };

      syncSessionRecordingForPath(client, "/servers");
      expect(client.startSessionRecording).not.toHaveBeenCalled();
    });

    it("never throws when posthog is unavailable or ad-blocked", async () => {
      vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
      vi.resetModules();
      const { syncSessionRecordingForPath } = await import("../PosthogUtils");

      // Missing methods, and a method that throws — neither may break render.
      expect(() =>
        syncSessionRecordingForPath({}, "/results/x"),
      ).not.toThrow();
      expect(() =>
        syncSessionRecordingForPath(
          {
            stopSessionRecording: () => {
              throw new Error("blocked");
            },
          },
          "/results/x",
        ),
      ).not.toThrow();
    });

    it("does not read HOSTED_MODE at module import time", async () => {
      // The capture-surface fields are getters on purpose: as eager calls they
      // made merely importing this module touch `@/lib/config`, which broke
      // every test that partially mocks it (62 files do).
      const descriptor = Object.getOwnPropertyDescriptor(
        options,
        "capture_exceptions",
      );
      expect(descriptor?.get).toBeTypeOf("function");
      expect(
        Object.getOwnPropertyDescriptor(options, "disable_session_recording")
          ?.get,
      ).toBeTypeOf("function");
    });
  });

  describe("landing-host pageview capture", () => {
    it("enables SPA pageviews + pageleave on vanity landing hosts", () => {
      for (const hostname of [
        "caniuse.dev",
        "www.caniuse.dev",
        "score.mcpjam.com",
        "www.score.mcpjam.com",
        "CANIUSE.DEV",
      ]) {
        expect(getPageviewCaptureOptions(hostname)).toEqual({
          capture_pageview: "history_change",
          capture_pageleave: true,
        });
      }
    });

    it("keeps pageviews off everywhere else", () => {
      for (const hostname of [
        "app.mcpjam.com",
        "localhost",
        // Suffix look-alikes must not match.
        "evil-caniuse.dev",
        "caniuse.dev.example.com",
        undefined,
      ]) {
        expect(getPageviewCaptureOptions(hostname)).toEqual({
          capture_pageview: false,
          capture_pageleave: false,
        });
      }
    });

    it("wires pageview capture off in the app default options", () => {
      // jsdom test host is localhost — not a landing host.
      expect(options.capture_pageview).toBe(false);
      expect(options.capture_pageleave).toBe(false);
    });

    it("wires landing-host capture into both option branches", async () => {
      vi.stubGlobal("location", {
        hostname: "caniuse.dev",
        origin: "https://caniuse.dev",
      });

      vi.resetModules();
      const enabled = await import("../PosthogUtils");
      expect(enabled.options.capture_pageview).toBe("history_change");
      expect(enabled.options.capture_pageleave).toBe(true);

      // The VITE_DISABLE_POSTHOG_LOCAL branch is an independent options
      // literal — it must carry the same pageview fields or dev/opt-out
      // builds silently diverge.
      vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "true");
      vi.resetModules();
      const disabled = await import("../PosthogUtils");
      const opts = disabled.getPostHogOptions() as Record<string, unknown>;
      expect(opts.capture_pageview).toBe("history_change");
      expect(opts.capture_pageleave).toBe(true);
    });
  });
});
