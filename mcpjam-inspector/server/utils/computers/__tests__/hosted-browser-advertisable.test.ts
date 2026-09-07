import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import {
  hostedBrowserAdvertisable,
  initComputersRuntimeConfigBootstrap,
  isHostedBrowserRefused,
  isHostedDesktopUnavailable,
  resetComputersRuntimeConfigBootstrapForTests,
} from "../runtime-config";

/**
 * The predicate the eval and swarm runners ask BEFORE booking a desktop box.
 *
 * It folds THREE gates, and the reason it must is that the two backend
 * verdicts answer different questions: `hostedBrowser.exposable` is "may we
 * advertise `browser_*`?" (it folds in the tool catalog), while
 * `desktopProvisionable` is "would a desktop boot, and is there a rate to
 * bill it at?". A caller that books a box for the life of a run needs both
 * answered yes — booking on the first alone reserves a desktop that the
 * resolver then refuses to hand a single tool to.
 */
describe("hostedBrowserAdvertisable", () => {
  function stubRuntimeConfig(hostedBrowser: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          // `enabled: false` on purpose: the bootstrap records the browser
          // verdict REGARDLESS of whether this deployment has a vendor key —
          // "a deployment with no vendor key still answers the question" —
          // and it keeps the fixture to the fields this test is about.
          JSON.stringify({ enabled: false, hostedBrowser }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );
  }

  beforeEach(() => {
    resetComputersRuntimeConfigBootstrapForTests();
    vi.stubEnv("HOSTED_BROWSER_TOOLS_ENABLED", "1");
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
  });

  afterEach(() => {
    resetComputersRuntimeConfigBootstrapForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("refuses when the backend can advertise a browser but NOT boot a desktop", async () => {
    // The gap this test exists for: `exposable` alone said yes, so the runners
    // booked a desktop the control plane would refuse — or worse, meter at the
    // terminal rate, which is the exact failure `isHostedDesktopUnavailable`
    // was added to prevent.
    stubRuntimeConfig({ exposable: true, desktopProvisionable: false });
    await initComputersRuntimeConfigBootstrap({ sleep: async () => {} });

    expect(isHostedBrowserRefused()).toBe(false);
    expect(isHostedDesktopUnavailable()).toBe(true);
    expect(hostedBrowserAdvertisable()).toBe(false);
  });

  it("allows it when both verdicts say yes", async () => {
    stubRuntimeConfig({ exposable: true, desktopProvisionable: true });
    await initComputersRuntimeConfigBootstrap({ sleep: async () => {} });

    expect(hostedBrowserAdvertisable()).toBe(true);
  });

  it("refuses when the env flag is dark, whatever the backend says", async () => {
    // The half the backend cannot see, and the reason this question is asked
    // inspector-side at all.
    stubRuntimeConfig({ exposable: true, desktopProvisionable: true });
    await initComputersRuntimeConfigBootstrap({ sleep: async () => {} });
    vi.stubEnv("HOSTED_BROWSER_TOOLS_ENABLED", "");

    expect(hostedBrowserAdvertisable()).toBe(false);
  });
});
