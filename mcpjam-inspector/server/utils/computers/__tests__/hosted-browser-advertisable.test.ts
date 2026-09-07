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
 * The interesting part is which gates it does NOT fold in. The two backend
 * verdicts fail in opposite ways: `exposable: false` does not stop a
 * reservation (the control plane decides from the run's frozen
 * `builtInToolIds`), so a box gets booted and then has nothing advertised on
 * it — paid and idle. A missing desktop template or rate DOES stop it, before
 * any box exists, and the refusal carries a sentence the run surfaces. So the
 * first is gated here and the second deliberately is not.
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

  it("still ASKS when the backend cannot boot a desktop — the refusal has words", async () => {
    // Deliberately not gated. `desktopTemplateRefFromConfig` is a pure config
    // check that throws `desktop_unavailable` before any box is created, and
    // `describeEvalSandboxRefusal` turns that into the sentence the run
    // surfaces. Refusing here instead would cost nothing less and would run
    // the eval browser-less, scoring it as an ordinary result — an eval has no
    // notice channel, so the failed setup is the only message there is.
    stubRuntimeConfig({ exposable: true, desktopProvisionable: false });
    await initComputersRuntimeConfigBootstrap({ sleep: async () => {} });

    expect(isHostedDesktopUnavailable()).toBe(true);
    expect(hostedBrowserAdvertisable()).toBe(true);
  });

  it("refuses when the browser is not exposable — THAT one boots a box anyway", async () => {
    // The asymmetry this gate exists for: the control plane reserves from the
    // run's frozen `builtInToolIds`, which still say `browser`, so it boots a
    // real desktop — and the resolver, reading this same verdict, advertises
    // nothing on it. Paid and idle for the life of the run.
    stubRuntimeConfig({ exposable: false });
    await initComputersRuntimeConfigBootstrap({ sleep: async () => {} });

    expect(isHostedBrowserRefused()).toBe(true);
    expect(hostedBrowserAdvertisable()).toBe(false);
  });

  it("allows it when the backend says both are fine", async () => {
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
