import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionPrivacyInputs } from "../session-privacy";

type SessionPrivacyModule = typeof import("../session-privacy");

/** A fresh module: its level and recorder state are module-scoped. */
async function load(
  env: { hosted?: boolean; desktop?: boolean; posthogDisabled?: boolean } = {},
): Promise<SessionPrivacyModule> {
  if (env.hosted) vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
  if (env.desktop) {
    vi.stubEnv("PROD", true);
    vi.stubGlobal("window", { ...window, isElectron: true });
  }
  // Explicit both ways: `.env.local` sets it for local dev, and Vite loads
  // that file into the test environment too.
  vi.stubEnv(
    "VITE_DISABLE_POSTHOG_LOCAL",
    env.posthogDisabled ? "true" : "false",
  );
  vi.resetModules();
  return import("../session-privacy");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

/**
 * posthog-js stand-in. `log` records every call in order, so a test can prove
 * the recorder stopped BEFORE its profile changed.
 */
function posthogStub() {
  const log: string[] = [];
  let profile: unknown;
  const client = {
    log,
    profile: () => profile,
    startSessionRecording: vi.fn(() => log.push("start")),
    stopSessionRecording: vi.fn(() => log.push("stop")),
    set_config: vi.fn((config: Record<string, unknown>) => {
      profile = config.session_recording;
      log.push(`config:${config.mask_all_text === true ? "masked" : "full"}`);
    }),
  };
  return client;
}

describe("resolveSessionPrivacy", () => {
  const base: SessionPrivacyInputs = {
    surface: "hosted",
    account: "signed_in",
    sharedLink: false,
    enterprisePrivacyInView: false,
  };

  it("is off wherever replay is off", async () => {
    const { resolveSessionPrivacy } = await load();
    for (const account of ["loading", "signed_out", "signed_in"] as const) {
      expect(resolveSessionPrivacy({ ...base, surface: "off", account })).toBe(
        "off",
      );
    }
  });

  it("is masked on packaged desktop for everyone", async () => {
    const { resolveSessionPrivacy } = await load();
    for (const account of ["loading", "signed_out", "signed_in"] as const) {
      for (const enterprisePrivacyInView of [true, false, undefined]) {
        expect(
          resolveSessionPrivacy({
            ...base,
            surface: "desktop",
            account,
            enterprisePrivacyInView,
          }),
        ).toBe("masked");
      }
    }
  });

  it("on hosted: full signed out, by organization signed in, pending until known", async () => {
    const { resolveSessionPrivacy } = await load();
    expect(resolveSessionPrivacy({ ...base, account: "signed_out" })).toBe(
      "full",
    );
    expect(resolveSessionPrivacy({ ...base, account: "loading" })).toBe(
      "pending",
    );
    expect(
      resolveSessionPrivacy({ ...base, enterprisePrivacyInView: undefined }),
    ).toBe("pending");
    expect(
      resolveSessionPrivacy({ ...base, enterprisePrivacyInView: true }),
    ).toBe("masked");
    expect(resolveSessionPrivacy(base)).toBe("full");
  });

  it("masks a share link whoever is viewing it", async () => {
    const { resolveSessionPrivacy } = await load();
    for (const account of ["loading", "signed_out", "signed_in"] as const) {
      expect(
        resolveSessionPrivacy({ ...base, account, sharedLink: true }),
      ).toBe("masked");
    }
  });
});

describe("recordingSurface", () => {
  it("is off for npx/Docker, hosted on hosted, desktop when packaged", async () => {
    expect((await load()).recordingSurface()).toBe("off");
    expect((await load({ hosted: true })).recordingSurface()).toBe("hosted");
    vi.unstubAllEnvs();
    expect((await load({ desktop: true })).recordingSurface()).toBe("desktop");
  });

  it("is off in a VITE_DISABLE_POSTHOG_LOCAL build, even on hosted", async () => {
    const mod = await load({ hosted: true, posthogDisabled: true });
    expect(mod.recordingSurface()).toBe("off");
    expect(mod.currentSessionPrivacy()).toBe("off");
  });
});

describe("enterprise privacy from the organization list", () => {
  const orgs = [
    { _id: "org_plain" },
    { _id: "org_private", enterprisePrivacy: true },
    { _id: "org_explicit_off", enterprisePrivacy: false },
  ];

  it("in view: unknown until the list loads or something is in view", async () => {
    const { resolveEnterprisePrivacyInView } = await load();
    expect(
      resolveEnterprisePrivacyInView(undefined, ["org_private"]),
    ).toBeUndefined();
    expect(
      resolveEnterprisePrivacyInView(orgs, [null, undefined]),
    ).toBeUndefined();
  });

  it("in view: any one organization in view is enough, and only `true` counts", async () => {
    const { resolveEnterprisePrivacyInView } = await load();
    expect(
      resolveEnterprisePrivacyInView(orgs, ["org_plain", null, "org_private"]),
    ).toBe(true);
    expect(resolveEnterprisePrivacyInView(orgs, ["org_plain"])).toBe(false);
    expect(resolveEnterprisePrivacyInView(orgs, ["org_explicit_off"])).toBe(
      false,
    );
    // A private organization the user belongs to but is not looking at.
    expect(
      resolveEnterprisePrivacyInView(orgs, ["org_plain", "org_gone"]),
    ).toBe(false);
  });

  it("membership: any organization in the list, unknown until it loads", async () => {
    const { resolveEnterprisePrivacyMember } = await load();
    expect(resolveEnterprisePrivacyMember(undefined)).toBeUndefined();
    expect(resolveEnterprisePrivacyMember([])).toBe(false);
    expect(resolveEnterprisePrivacyMember([orgs[0], orgs[2]])).toBe(false);
    expect(resolveEnterprisePrivacyMember(orgs)).toBe(true);
  });
});

describe("scrubNamesFromUrl", () => {
  const id = "k57a8c1b2d3e4f5g6h7j8k9m0n1p2q3r";

  it("keeps route words and ids, replaces names", async () => {
    const { scrubNamesFromUrl } = await load();
    expect(scrubNamesFromUrl(`/p/${id}/servers/acme-billing`)).toBe(
      `/p/${id}/servers/[name]`,
    );
    expect(
      scrubNamesFromUrl(
        `https://app.mcpjam.com/p/${id}/evals/suite/${id}/test/42/edit`,
      ),
    ).toBe(`https://app.mcpjam.com/p/${id}/evals/suite/${id}/test/42/edit`);
    expect(scrubNamesFromUrl("/capabilities/my-secret-capability")).toBe(
      "/capabilities/[name]",
    );
    expect(
      scrubNamesFromUrl("/servers/123e4567-e89b-12d3-a456-426614174000"),
    ).toBe("/servers/123e4567-e89b-12d3-a456-426614174000");
  });

  it("replaces query values that are not ids and drops the fragment", async () => {
    const { scrubNamesFromUrl } = await load();
    expect(
      scrubNamesFromUrl(
        `https://app.mcpjam.com/servers?server=acme&project=${id}#access_token=abc`,
      ),
    ).toBe(`https://app.mcpjam.com/servers?server=[name]&project=${id}`);
  });

  it("treats encoded names as names and leaves non-URLs alone", async () => {
    const { scrubNamesFromUrl } = await load();
    expect(scrubNamesFromUrl("/servers/My%20Server")).toBe("/servers/[name]");
    expect(scrubNamesFromUrl("$direct")).toBe("$direct");
    // A path that cannot be decoded fails closed.
    expect(scrubNamesFromUrl("/servers/%E0%A4%A")).toBe("[name]");
  });
});

describe("profiles", () => {
  it("masked: every text node, inputs, media, canvas, console, network detail", async () => {
    const { posthogPrivacyConfig, MASKED_BLOCK_SELECTOR, maskReplayRequest } =
      await load();
    const config = posthogPrivacyConfig("masked");
    const replay = config.session_recording as Record<string, unknown>;

    expect(replay).toMatchObject({
      maskAllInputs: true,
      maskTextSelector: "*",
      blockSelector: MASKED_BLOCK_SELECTOR,
      recordHeaders: false,
      recordBody: false,
      captureCanvas: { recordCanvas: false },
      captureJsonLd: false,
      recordCrossOriginIframes: false,
      maskCapturedNetworkRequestFn: maskReplayRequest,
    });
    for (const media of ["img", "video", "canvas", "iframe"]) {
      expect(MASKED_BLOCK_SELECTOR).toContain(media);
    }
    expect(config).toMatchObject({
      enable_recording_console_log: false,
      mask_all_text: true,
      mask_all_element_attributes: true,
    });
  });

  it("full: today's profile, console capture back to the project setting", async () => {
    const { posthogPrivacyConfig, SESSION_RECORDING_OPTIONS } = await load();
    const config = posthogPrivacyConfig("full");

    expect(config.session_recording).toBe(SESSION_RECORDING_OPTIONS);
    // null, not undefined: posthog-js's set_config skips undefined values.
    expect(config.enable_recording_console_log).toBeNull();
    expect(config.mask_all_text).toBe(false);
    expect(config.mask_all_element_attributes).toBe(false);
  });

  it("masks text-bearing attributes but keeps what styling needs", async () => {
    const { maskReplayAttribute } = await load();
    expect(maskReplayAttribute("class", "flex gap-2")).toBe("flex gap-2");
    expect(maskReplayAttribute("style", "width: 4px")).toBe("width: 4px");
    expect(maskReplayAttribute("data-state", "open")).toBe("open");
    expect(maskReplayAttribute("viewBox", "0 0 24 24")).toBe("0 0 24 24");
    for (const name of [
      "title",
      "alt",
      "href",
      "src",
      "placeholder",
      "aria-label",
      "id",
      "data-server-name",
    ]) {
      expect(maskReplayAttribute(name, "acme-billing")).toBe("***");
    }
  });

  it("strips network detail and scrubs the URL of every replayed request", async () => {
    const { maskReplayRequest } = await load();
    const masked = maskReplayRequest({
      name: "https://app.mcpjam.com/api/web/servers/acme-billing/tools",
      requestHeaders: { authorization: "x" },
      responseHeaders: { "set-cookie": "y" },
      requestBody: "{}",
      responseBody: "{}",
    } as Record<string, unknown> & { name: string });

    expect(masked).toEqual({
      name: "https://app.mcpjam.com/api/web/servers/[name]/tools",
    });
    for (const field of [
      "requestHeaders",
      "responseHeaders",
      "requestBody",
      "responseBody",
    ]) {
      expect(masked).not.toHaveProperty(field);
    }
    // The recorded page URL goes through the same callback as `{ name }`.
    expect(maskReplayRequest({ name: "/servers/acme" }).name).toBe(
      "/servers/[name]",
    );
  });
});

describe("syncSessionRecording", () => {
  it("does nothing on an off surface", async () => {
    const mod = await load();
    const client = posthogStub();
    mod.syncSessionRecording(client, "/servers");
    expect(client.log).toEqual([]);
  });

  it("holds the recorder off while pending, with the masked profile in place", async () => {
    const mod = await load({ hosted: true });
    const client = posthogStub();

    expect(mod.currentSessionPrivacy()).toBe("pending");
    mod.syncSessionRecording(client, "/servers");

    expect(client.startSessionRecording).not.toHaveBeenCalled();
    expect(client.log).toEqual(["config:masked"]);
  });

  it("configures, then starts, on the first resolved level", async () => {
    const mod = await load({ hosted: true });
    const client = posthogStub();

    mod.setSessionPrivacy("full");
    mod.syncSessionRecording(client, "/servers");

    expect(client.log).toEqual(["config:full", "start"]);
    expect(client.profile()).toBe(mod.SESSION_RECORDING_OPTIONS);
  });

  it("full → masked: stops BEFORE the profile changes, then restarts masked", async () => {
    const mod = await load({ hosted: true });
    const client = posthogStub();
    mod.setSessionPrivacy("full");
    mod.syncSessionRecording(client, "/servers");
    client.log.length = 0;

    mod.setSessionPrivacy("masked");
    mod.syncSessionRecording(client, "/servers");

    expect(client.log).toEqual(["stop", "config:masked", "start"]);
    expect(client.profile()).toBe(mod.MASKED_SESSION_RECORDING_OPTIONS);
  });

  it("masked → full: stops, reconfigures, restarts full", async () => {
    const mod = await load({ hosted: true });
    const client = posthogStub();
    mod.setSessionPrivacy("masked");
    mod.syncSessionRecording(client, "/servers");
    client.log.length = 0;

    mod.setSessionPrivacy("full");
    mod.syncSessionRecording(client, "/servers");

    expect(client.log).toEqual(["stop", "config:full", "start"]);
  });

  it("does not restart on an ordinary navigation", async () => {
    const mod = await load({ hosted: true });
    const client = posthogStub();
    mod.setSessionPrivacy("full");
    mod.syncSessionRecording(client, "/servers");
    client.log.length = 0;

    mod.syncSessionRecording(client, "/tools");
    mod.syncSessionRecording(client, "/prompts");

    expect(client.log).toEqual([]);
  });

  it("going back to pending stops the recorder at once", async () => {
    const mod = await load({ hosted: true });
    const client = posthogStub();
    mod.setSessionPrivacy("full");
    mod.syncSessionRecording(client, "/servers");
    client.log.length = 0;

    mod.setSessionPrivacy("pending");
    mod.syncSessionRecording(client, "/servers");

    expect(client.log).toEqual(["stop", "config:masked"]);
  });

  describe("/results/<token>", () => {
    it("stops on the way in and resumes on the way out", async () => {
      const mod = await load({ hosted: true });
      const client = posthogStub();
      mod.setSessionPrivacy("full");
      mod.syncSessionRecording(client, "/servers");
      client.log.length = 0;

      mod.syncSessionRecording(client, "/results/token-a");
      mod.syncSessionRecording(client, "/results/token-b");
      mod.syncSessionRecording(client, "/servers");

      expect(client.log).toEqual(["stop", "start"]);
    });

    it("never starts on a hard load onto the route, whatever the level", async () => {
      const mod = await load({ hosted: true });
      const client = posthogStub();
      mod.setSessionPrivacy("full");
      mod.syncSessionRecording(client, "/results/secret-token");

      expect(client.startSessionRecording).not.toHaveBeenCalled();
      mod.syncSessionRecording(client, "/servers");
      expect(client.startSessionRecording).toHaveBeenCalledTimes(1);
    });

    it("a level change on the route reconfigures but does not start", async () => {
      const mod = await load({ hosted: true });
      const client = posthogStub();
      mod.setSessionPrivacy("full");
      mod.syncSessionRecording(client, "/servers");
      mod.syncSessionRecording(client, "/results/secret-token");
      client.log.length = 0;

      mod.setSessionPrivacy("masked");
      mod.syncSessionRecording(client, "/results/secret-token");
      expect(client.log).toEqual(["config:masked"]);

      mod.syncSessionRecording(client, "/servers");
      expect(client.log).toEqual(["config:masked", "start"]);
    });
  });

  it("never throws when posthog is unavailable or ad-blocked", async () => {
    const mod = await load({ hosted: true });
    mod.setSessionPrivacy("full");
    expect(() => mod.syncSessionRecording({}, "/servers")).not.toThrow();
    expect(() =>
      mod.syncSessionRecording(
        {
          set_config: () => {
            throw new Error("blocked");
          },
        },
        "/servers",
      ),
    ).not.toThrow();
  });
});

describe("filterSentryReplayFrame", () => {
  const consoleFrame = {
    data: { tag: "breadcrumb", payload: { category: "console", message: "x" } },
  };
  const navigationFrame = {
    data: {
      tag: "breadcrumb",
      payload: {
        category: "navigation",
        data: { from: "/servers/acme", to: "/servers/globex" },
      },
    },
  };
  const spanFrame = {
    data: {
      tag: "performanceSpan",
      payload: {
        op: "resource.fetch",
        description: "https://app.mcpjam.com/api/web/servers/acme/tools",
      },
    },
  };

  it("passes everything through at full", async () => {
    const mod = await load({ hosted: true });
    mod.setSessionPrivacy("full");
    expect(mod.filterSentryReplayFrame(consoleFrame)).toBe(consoleFrame);
    expect(mod.filterSentryReplayFrame(spanFrame)).toBe(spanFrame);
  });

  it("drops console breadcrumbs and scrubs URLs short of full", async () => {
    const mod = await load({ hosted: true });
    mod.setSessionPrivacy("masked");

    expect(mod.filterSentryReplayFrame(consoleFrame)).toBeNull();
    expect(
      mod.filterSentryReplayFrame(navigationFrame)?.data.payload,
    ).toMatchObject({
      data: { from: "/servers/[name]", to: "/servers/[name]" },
    });
    expect(mod.filterSentryReplayFrame(spanFrame)?.data.payload).toMatchObject({
      description: "https://app.mcpjam.com/api/web/servers/[name]/tools",
    });
    // The input frame is not mutated.
    expect(spanFrame.data.payload.description).toContain("acme");
  });

  it("is wired into the Sentry options, which mask at every level", async () => {
    const { SENTRY_REPLAY_OPTIONS, filterSentryReplayFrame } = await load();
    expect(SENTRY_REPLAY_OPTIONS).toMatchObject({
      maskAllText: true,
      maskAllInputs: true,
      blockAllMedia: true,
      networkDetailAllowUrls: [],
      networkCaptureBodies: false,
    });
    expect(SENTRY_REPLAY_OPTIONS.beforeAddRecordingEvent).toBe(
      filterSentryReplayFrame,
    );
  });
});

describe("currentSessionPrivacy", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("starts pending on a recording surface and off elsewhere", async () => {
    expect((await load({ hosted: true })).currentSessionPrivacy()).toBe(
      "pending",
    );
    vi.unstubAllEnvs();
    expect((await load()).currentSessionPrivacy()).toBe("off");
  });

  it("masks analytics while pending or masked only", async () => {
    const mod = await load({ hosted: true });
    expect(mod.shouldMaskAnalytics()).toBe(true);
    mod.setSessionPrivacy("full");
    expect(mod.shouldMaskAnalytics()).toBe(false);
    mod.setSessionPrivacy("masked");
    expect(mod.shouldMaskAnalytics()).toBe(true);
  });
});
