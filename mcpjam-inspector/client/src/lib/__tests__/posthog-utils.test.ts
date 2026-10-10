import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureResult } from "posthog-js";
import {
  detectEnvironment,
  dropInjectedScriptException,
  getPageviewCaptureOptions,
  isPostHogBooleanFlagOn,
  options,
  sanitizeAnalyticsProperties,
  scrubSensitiveUrl,
  standardEventProps,
} from "../PosthogUtils";
import { stampPostHogEvent } from "../telemetry-context";

describe("scrubSensitiveUrl", () => {
  // Autocapture attaches $current_url to every event, so an unredacted share
  // path ships the bearer token to PostHog on each click.
  it.each([
    ["/results/", "score run"],
    ["/conformance/shared/", "conformance share"],
    ["/evals/shared/", "eval share"],
  ])("redacts the credential segment of %s (%s)", (prefix) => {
    const url = `https://app.mcpjam.com${prefix}sk-secret-token-value`;
    const scrubbed = scrubSensitiveUrl(url);
    expect(scrubbed).not.toContain("sk-secret-token-value");
    expect(scrubbed).toBe(`https://app.mcpjam.com${prefix}[redacted]`);
  });

  it("keeps the query string and leaves unrelated paths alone", () => {
    expect(
      scrubSensitiveUrl("https://app.mcpjam.com/evals/shared/tok?project=abc"),
    ).toBe("https://app.mcpjam.com/evals/shared/[redacted]?project=abc");
    expect(scrubSensitiveUrl("https://app.mcpjam.com/evals/suite/abc")).toBe(
      "https://app.mcpjam.com/evals/suite/abc",
    );
  });

  it("redacts organization ids from automatically captured route URLs", () => {
    expect(
      scrubSensitiveUrl(
        "https://app.mcpjam.com/organizations/org_secret/billing?tab=plans",
      ),
    ).toBe("https://app.mcpjam.com/organizations/[redacted]/billing?tab=plans");
    expect(scrubSensitiveUrl("/organizations/org_secret/plans")).toBe(
      "/organizations/[redacted]/plans",
    );
  });

  it("redacts organization ids from PostHog session and initial URL properties", () => {
    const properties = sanitizeAnalyticsProperties({
      $session_entry_url:
        "https://app.mcpjam.com/organizations/org_secret/billing",
      $session_entry_pathname: "/organizations/org_secret/plans",
      $session_entry_referrer:
        "https://app.mcpjam.com/organizations/org_secret/plans",
      $initial_current_url:
        "https://app.mcpjam.com/organizations/org_secret/billing",
      $initial_pathname: "/organizations/org_secret/billing",
      $initial_referrer:
        "https://app.mcpjam.com/organizations/org_secret/plans",
    });

    expect(properties).toMatchObject({
      $session_entry_url:
        "https://app.mcpjam.com/organizations/[redacted]/billing",
      $session_entry_pathname: "/organizations/[redacted]/plans",
      $session_entry_referrer:
        "https://app.mcpjam.com/organizations/[redacted]/plans",
      $initial_current_url:
        "https://app.mcpjam.com/organizations/[redacted]/billing",
      $initial_pathname: "/organizations/[redacted]/billing",
      $initial_referrer:
        "https://app.mcpjam.com/organizations/[redacted]/plans",
    });
  });
});

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

  it("sets deployment + platform as FLAG person properties, not just super properties", () => {
    const posthog = {
      register: vi.fn(),
      setPersonPropertiesForFlags: vi.fn(),
    };
    options.loaded(posthog);

    // `register` feeds EVENTS; `/flags` evaluates PERSON properties. Without
    // this call a `deployment = self_hosted` flag rule matches nobody.
    expect(posthog.setPersonPropertiesForFlags).toHaveBeenCalledWith({
      local_browser_security_version: "1",
      deployment: "self_hosted",
      platform: expect.any(String),
    });
  });

  it("does not throw when posthog-js has no setPersonPropertiesForFlags", () => {
    // A partial stand-in (or a host pinning an older posthog-js): flag
    // targeting degrades, analytics init must still complete.
    const posthog = { register: vi.fn() };
    expect(() => options.loaded(posthog)).not.toThrow();
    expect(posthog.register).toHaveBeenCalled();
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
    // The four shapes that reach getPostHogOptions(). Exceptions are ON for
    // hosted + Electron desktop only; dead clicks are on everywhere because
    // they cost nothing extra. Replay is OFF at init on every surface — the
    // session privacy level starts it (lib/session-privacy.ts).
    it("self-hosted web (npx/docker): no replay, no exceptions, unmasked autocapture", async () => {
      vi.resetModules();
      const { options: opts, isErrorCaptureSurface } =
        await import("../PosthogUtils");

      expect(isErrorCaptureSurface()).toBe(false);
      expect(opts.capture_exceptions).toBe(false);
      expect(opts.disable_session_recording).toBe(true);
      expect(opts.capture_dead_clicks).toBe(true);
      // `off` keeps today's analytics.
      expect(opts.mask_all_text).toBe(false);
      expect(opts.mask_all_element_attributes).toBe(false);
    });

    it("hosted: exceptions on, replay held for the privacy level, masked until then", async () => {
      vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
      vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
      vi.resetModules();
      const { options: opts, isErrorCaptureSurface } =
        await import("../PosthogUtils");
      const { MASKED_SESSION_RECORDING_OPTIONS } =
        await import("../session-privacy");

      expect(isErrorCaptureSurface()).toBe(true);
      expect(opts.capture_exceptions).toBe(true);
      expect(opts.disable_session_recording).toBe(true);
      expect(opts.session_recording).toBe(MASKED_SESSION_RECORDING_OPTIONS);
      expect(opts.enable_recording_console_log).toBe(false);
      expect(opts.mask_all_text).toBe(true);
      expect(opts.mask_all_element_attributes).toBe(true);
    });

    it("packaged electron desktop: exceptions on, replay held, masked", async () => {
      vi.stubEnv("PROD", true);
      vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
      vi.stubGlobal("window", { ...window, isElectron: true });
      vi.resetModules();
      const { options: opts, isErrorCaptureSurface } =
        await import("../PosthogUtils");

      expect(isErrorCaptureSurface()).toBe(true);
      expect(opts.capture_exceptions).toBe(true);
      expect(opts.disable_session_recording).toBe(true);
      expect(opts.mask_all_text).toBe(true);
    });

    it("electron-forge start: replay + exceptions OFF", async () => {
      // The preload exposes `isElectron: true` in dev too, so without a
      // packaged signal every local `electron:dev` run would stream renderer
      // DOM and text into the production projects.
      vi.stubGlobal("window", { ...window, isElectron: true });
      vi.resetModules();
      const { options: opts, isErrorCaptureSurface } =
        await import("../PosthogUtils");

      expect(import.meta.env.PROD).toBe(false);
      expect(isErrorCaptureSurface()).toBe(false);
      expect(opts.capture_exceptions).toBe(false);
      expect(opts.disable_session_recording).toBe(true);
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

    it("treats bearer-credential share URLs as credential paths", async () => {
      vi.resetModules();
      const { isCredentialBearingPath } = await import("../PosthogUtils");

      expect(isCredentialBearingPath("/results/abc")).toBe(true);
      expect(isCredentialBearingPath("/conformance/shared/secret")).toBe(true);
      expect(isCredentialBearingPath("/evals/shared/secret")).toBe(true);
      expect(isCredentialBearingPath("/servers")).toBe(false);
    });

    it("keeps the full profile's masking: inputs and every annotated secret surface", async () => {
      vi.resetModules();
      const { SESSION_RECORDING_OPTIONS } = await import("../PosthogUtils");

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
    });

    it("does not read HOSTED_MODE at module import time", async () => {
      // The capture-surface fields are getters on purpose: as eager calls they
      // made merely importing this module touch `@/lib/config`, which broke
      // every test that partially mocks it (62 files do).
      for (const key of [
        "capture_exceptions",
        "mask_all_text",
        "mask_all_element_attributes",
      ]) {
        expect(Object.getOwnPropertyDescriptor(options, key)?.get).toBeTypeOf(
          "function",
        );
      }
    });
  });

  describe("URL scrubbing by privacy level", () => {
    const properties = () => ({
      $current_url:
        "https://app.mcpjam.com/p/k57a8c1b2d3e4f5g6h7j8k9m0n1p2q3r/servers/acme-billing?tab=tools",
      $pathname: "/p/k57a8c1b2d3e4f5g6h7j8k9m0n1p2q3r/servers/acme-billing",
    });

    it("scrubs names from URLs while the level is pending or masked", async () => {
      vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
      vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
      vi.resetModules();
      const { sanitizeAnalyticsProperties: sanitize } =
        await import("../PosthogUtils");
      const { setSessionPrivacy } = await import("../session-privacy");

      // Pending: nothing is known yet, so names stay out.
      expect(sanitize(properties())).toEqual({
        $current_url:
          "https://app.mcpjam.com/p/k57a8c1b2d3e4f5g6h7j8k9m0n1p2q3r/servers/[name]?tab=[name]",
        $pathname: "/p/k57a8c1b2d3e4f5g6h7j8k9m0n1p2q3r/servers/[name]",
      });

      setSessionPrivacy("masked");
      expect(sanitize(properties()).$pathname).toBe(
        "/p/k57a8c1b2d3e4f5g6h7j8k9m0n1p2q3r/servers/[name]",
      );
    });

    it("leaves names alone at full, and on an off surface", async () => {
      vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
      vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
      vi.resetModules();
      const hosted = await import("../PosthogUtils");
      const { setSessionPrivacy } = await import("../session-privacy");
      setSessionPrivacy("full");
      expect(hosted.sanitizeAnalyticsProperties(properties())).toEqual(
        properties(),
      );

      vi.unstubAllEnvs();
      vi.resetModules();
      const npx = await import("../PosthogUtils");
      expect(npx.sanitizeAnalyticsProperties(properties())).toEqual(
        properties(),
      );
    });

    it("still redacts credential tokens at every level", async () => {
      vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
      vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
      vi.resetModules();
      const { sanitizeAnalyticsProperties: sanitize } =
        await import("../PosthogUtils");
      const { setSessionPrivacy } = await import("../session-privacy");
      setSessionPrivacy("full");

      expect(
        sanitize({ $current_url: "https://app.mcpjam.com/results/secret" })
          .$current_url,
      ).toBe("https://app.mcpjam.com/results/[redacted]");
    });
  });

  describe("autocapture follows the level", () => {
    it("masks element text and attributes only while the level is not full", async () => {
      vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
      vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
      vi.resetModules();
      const { options: opts } = await import("../PosthogUtils");
      const { setSessionPrivacy } = await import("../session-privacy");

      expect(opts.mask_all_text).toBe(true);
      setSessionPrivacy("full");
      expect(opts.mask_all_text).toBe(false);
      expect(opts.mask_all_element_attributes).toBe(false);
      setSessionPrivacy("masked");
      expect(opts.mask_all_text).toBe(true);
      expect(opts.mask_all_element_attributes).toBe(true);
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

  describe("server-evaluated feature flags (MJ-015)", () => {
    const serverFlags = {
      "sandbox-images-enabled": true,
      "guest-credit-wall-copy": "treatment",
    };

    it("bootstraps the server flags and turns remote flag loading off", async () => {
      vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
      vi.resetModules();
      const { getPostHogOptions } = await import("../PosthogUtils");

      const opts = getPostHogOptions(serverFlags) as Record<string, any>;

      expect(opts.bootstrap.featureFlags).toEqual(serverFlags);
      expect(opts.advanced_disable_feature_flags).toBe(true);
      expect(opts.advanced_disable_feature_flags_on_first_load).toBe(true);
      // Remote config (replay, surveys, ...) still loads.
      expect(opts.advanced_disable_flags).toBeUndefined();
      expect(opts.advanced_disable_decide).toBeUndefined();
    });

    it("keeps the guest identity bootstrap and the capture-surface getters", async () => {
      vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
      vi.resetModules();
      vi.doMock("../guest-session", async (importOriginal) => ({
        ...(await importOriginal<typeof import("../guest-session")>()),
        getCachedGuestSession: () => ({
          guestId: "guest_bootstrap_1",
          token: "guest-token",
          expiresAt: Date.now() + 60_000,
        }),
      }));
      const { getPostHogOptions } = await import("../PosthogUtils");

      const opts = getPostHogOptions(serverFlags) as Record<string, any>;

      expect(opts.bootstrap).toEqual({
        distinctID: "guest_bootstrap_1",
        isIdentifiedID: false,
        featureFlags: serverFlags,
      });
      expect(
        Object.getOwnPropertyDescriptor(opts, "capture_exceptions")?.get,
      ).toBeTypeOf("function");
      vi.doUnmock("../guest-session");
    });

    it("leaves flags out of the bootstrap when the server returned none", async () => {
      vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
      vi.resetModules();
      const { getPostHogOptions } = await import("../PosthogUtils");

      for (const none of [undefined, null, {}]) {
        const opts = getPostHogOptions(none) as Record<string, any>;
        expect(opts.bootstrap?.featureFlags).toBeUndefined();
        expect(opts.advanced_disable_feature_flags).toBe(true);
      }
    });

    it("applies the same flag options in the capture-disabled branch", async () => {
      vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "true");
      vi.resetModules();
      const { getPostHogOptions } = await import("../PosthogUtils");

      const opts = getPostHogOptions(serverFlags) as Record<string, any>;

      expect(opts.opt_out_capturing_by_default).toBe(true);
      expect(opts.bootstrap.featureFlags).toEqual(serverFlags);
      expect(opts.advanced_disable_feature_flags).toBe(true);
      expect(opts.advanced_disable_feature_flags_on_first_load).toBe(true);
    });
  });
});

describe("dropInjectedScriptException", () => {
  const exceptionEvent = (frames: { filename?: string }[] | undefined) =>
    ({
      uuid: "01a0cf09-c6fe-7ec5-9756-c5a4f4597a43",
      event: "$exception",
      properties: {
        $exception_list: [
          {
            type: "RangeError",
            value: "Maximum call stack size exceeded.",
            stacktrace: frames ? { type: "raw", frames } : undefined,
          },
        ],
      },
    }) as unknown as CaptureResult;

  // The frames carry the app's own origin, so the fixtures derive from the
  // test document rather than hard-coding app.mcpjam.com — otherwise these
  // would pass for being cross-origin, which is not what is under test.
  const origin = window.location.origin;

  // The shape PostHog recorded on 2026-09-23: the browser stamps injected code
  // with the document URL because it has no script file of its own. Absolute
  // and route-relative both appear in the wild, hence both cases.
  it.each([
    ["an absolute document URL", `${origin}/p/v97d1szz`],
    ["a route-relative one", "/p/v97d1szz"],
  ])("drops a RangeError whose every frame is %s", (_label, prefix) => {
    const event = exceptionEvent([
      { filename: `${prefix}/playground` },
      { filename: `${prefix}/tasks` },
      { filename: `${prefix}/tasks` },
    ]);
    expect(dropInjectedScriptException(event)).toBeNull();
  });

  // The markdown lexer has blown the stack for real. That one must still page.
  it("keeps a stack overflow raised inside our own bundle", () => {
    const event = exceptionEvent([
      { filename: `${origin}/assets/index-Ct2CwjTH.js` },
      { filename: `${origin}/p/v97d1szz/playground` },
    ]);
    expect(dropInjectedScriptException(event)).toBe(event);
  });

  it.each([
    ["a Vite dev module with a cache-busting query", "/src/main.tsx?t=1730"],
    // An extension test alone would have swallowed every failure on the
    // payment path: seat-payment-stripe.ts loads this exact URL.
    ["extensionless Stripe.js", "https://js.stripe.com/v3/"],
    ["an engine-synthesised frame", "<anonymous>"],
  ])("keeps an exception from %s", (_label, filename) => {
    const event = exceptionEvent([{ filename }]);
    expect(dropInjectedScriptException(event)).toBe(event);
  });

  // No stack means no attribution. Guessing here would hide real errors.
  it.each([
    ["an empty frame list", [] as { filename?: string }[]],
    ["no stacktrace at all", undefined],
  ])("keeps an exception with %s", (_label, frames) => {
    const event = exceptionEvent(frames);
    expect(dropInjectedScriptException(event)).toBe(event);
  });

  // @posthog/core turns an Error.cause into its own $exception_list entry,
  // with no stacktrace when the cause is a string. That entry is unattributed,
  // so it keeps the event even though the other entry is all document frames.
  it("keeps a chained exception whose string cause has no stacktrace", () => {
    const event = exceptionEvent([{ filename: `${origin}/p/v97d1szz/tasks` }]);
    const exceptions = event.properties.$exception_list as unknown[];
    exceptions.push({ type: "Error", value: "string cause" });
    expect(dropInjectedScriptException(event)).toBe(event);
  });

  it("leaves other events and a null capture alone", () => {
    const pageview = {
      uuid: "1",
      event: "$pageview",
      properties: {},
    } as unknown as CaptureResult;
    expect(dropInjectedScriptException(pageview)).toBe(pageview);
    expect(dropInjectedScriptException(null)).toBeNull();
  });

  it("is wired into the app options, ahead of the capture-context stamp", () => {
    expect(options.before_send).toEqual([
      dropInjectedScriptException,
      stampPostHogEvent,
    ]);
  });
});
