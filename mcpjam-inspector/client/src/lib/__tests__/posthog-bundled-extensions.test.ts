import { describe, expect, it, vi } from "vitest";
import { preloadPosthogBundledExtensions } from "../posthog-bundled-extensions";

// Mutable gates so one module instance can be driven through both branches.
// Order matters below: the skip case must run BEFORE the register case,
// because once the dist bundles execute they stay in the ESM cache and
// `__PosthogExtensions__` can never be un-registered.
const gates = vi.hoisted(() => ({ disabled: false, surface: false }));

vi.mock("../PosthogUtils", () => ({
  get isPostHogDisabled() {
    return gates.disabled;
  },
  isErrorCaptureSurface: () => gates.surface,
}));

function registeredExtensions(): Record<string, unknown> | undefined {
  return (window as unknown as Record<string, unknown>)
    .__PosthogExtensions__ as Record<string, unknown> | undefined;
}

describe("preloadPosthogBundledExtensions", () => {
  it("loads nothing off the error-capture surfaces", async () => {
    gates.surface = false;
    gates.disabled = false;
    await preloadPosthogBundledExtensions();
    expect(registeredExtensions()).toBeUndefined();
  });

  it("loads nothing in the dev opt-out branch even on a capture surface", async () => {
    gates.surface = true;
    gates.disabled = true;
    await preloadPosthogBundledExtensions();
    expect(registeredExtensions()).toBeUndefined();
  });

  it("registers every extension posthog-js would otherwise fetch from /relay/static", async () => {
    gates.surface = true;
    gates.disabled = false;
    await preloadPosthogBundledExtensions();

    const extensions = registeredExtensions();
    expect(extensions).toBeDefined();
    // These keys are exactly what the SDK checks before calling
    // loadExternalDependency (the remote fetch Railway's edge blocks on
    // hosted). Same-package bundles mean the keys cannot drift from the SDK.
    expect(extensions).toMatchObject({
      rrweb: expect.anything(), // posthog-recorder (session replay)
      initSessionRecording: expect.anything(),
      generateSurveys: expect.anything(), // surveys popover
      errorWrappingFunctions: expect.anything(), // $exception capture
      initDeadClicksAutocapture: expect.anything(),
      postHogWebVitalsCallbacks: expect.anything(), // $web_vitals
    });
  });
});
