import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPageviewCaptureOptions,
  isPostHogBooleanFlagOn,
  options,
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
