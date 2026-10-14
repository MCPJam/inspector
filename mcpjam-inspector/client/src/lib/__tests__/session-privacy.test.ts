import { posthogStub } from "./fixtures/posthog-stub";
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

describe("resolveSessionPrivacy", () => {
  const base: SessionPrivacyInputs = {
    surface: "hosted",
    sharedLink: false,
    recording: "full",
  };
  const answers = ["full", "masked", "off", undefined] as const;

  it("is off wherever replay is off", async () => {
    const { resolveSessionPrivacy } = await load();
    for (const recording of answers) {
      expect(
        resolveSessionPrivacy({ ...base, surface: "off", recording }),
      ).toBe("off");
    }
  });

  it("is off wherever the backend answers off, on every recording surface", async () => {
    const { resolveSessionPrivacy } = await load();
    for (const surface of ["hosted", "desktop"] as const) {
      for (const sharedLink of [false, true]) {
        expect(
          resolveSessionPrivacy({ surface, sharedLink, recording: "off" }),
        ).toBe("off");
      }
    }
  });

  it("is masked on packaged desktop for everyone else, once answered", async () => {
    const { resolveSessionPrivacy } = await load();
    expect(
      resolveSessionPrivacy({
        ...base,
        surface: "desktop",
        recording: undefined,
      }),
    ).toBe("pending");
    for (const recording of ["full", "masked"] as const) {
      expect(
        resolveSessionPrivacy({ ...base, surface: "desktop", recording }),
      ).toBe("masked");
    }
  });

  it("on hosted: the backend's answer, pending until it arrives", async () => {
    const { resolveSessionPrivacy } = await load();
    expect(resolveSessionPrivacy({ ...base, recording: undefined })).toBe(
      "pending",
    );
    expect(resolveSessionPrivacy({ ...base, recording: "masked" })).toBe(
      "masked",
    );
    // Only a verified non-private context records in full.
    expect(resolveSessionPrivacy(base)).toBe("full");
  });

  it("records nothing on a share link, whatever the viewer's own answer", async () => {
    // The page shows an organization the viewer may not belong to; its
    // owner's replay might be off, and the backend answers for the viewer.
    const { resolveSessionPrivacy } = await load();
    for (const recording of ["full", "masked", "off", undefined] as const) {
      for (const surface of ["hosted", "desktop"] as const) {
        expect(
          resolveSessionPrivacy({ surface, recording, sharedLink: true }),
        ).toBe("off");
      }
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

describe("APP_ROUTE_WORDS", () => {
  // The relay scrubs URLs with the shared list and cannot read the route
  // table, so the list must cover every literal segment of it.
  it("covers every literal segment of the route table", async () => {
    const { APP_ROUTE_WORDS } = await load();
    const { APP_ROUTES } = await import("../app-routes");
    const missing = [
      ...new Set(
        APP_ROUTES.flatMap((route) => route.path.split("/")).filter(
          (segment) =>
            segment &&
            !segment.startsWith(":") &&
            segment !== "*" &&
            !APP_ROUTE_WORDS.has(segment),
        ),
      ),
    ];
    expect(
      missing,
      "Add these route segments to APP_ROUTE_WORDS in shared/telemetry-privacy.ts",
    ).toEqual([]);
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

  it("an off answer stops the recorder and keeps analytics masked", async () => {
    const mod = await load({ hosted: true });
    const client = posthogStub();
    mod.setSessionPrivacy("full");
    mod.syncSessionRecording(client, "/servers");
    client.log.length = 0;

    mod.setSessionPrivacy("off");
    mod.syncSessionRecording(client, "/servers");
    mod.syncSessionRecording(client, "/tools");

    expect(client.log).toEqual(["stop", "config:masked"]);
    expect(mod.shouldMaskAnalytics()).toBe(true);
  });

  it("an off surface keeps unmasked analytics", async () => {
    const mod = await load();
    expect(mod.currentSessionPrivacy()).toBe("off");
    expect(mod.shouldMaskAnalytics()).toBe(false);
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

describe("replayFramesToSend", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops the buffer that a full → masked stop flushes", async () => {
    const mod = await load({ hosted: true });
    const client = posthogStub();
    mod.setSessionPrivacy("full");
    mod.syncSessionRecording(client, "/servers");
    // posthog-js flushes its buffer synchronously from inside stop().
    let flushed: unknown[] | null | undefined;
    client.stopSessionRecording.mockImplementation(() => {
      flushed = mod.replayFramesToSend([{ type: 2, timestamp: Date.now() }]);
      return client.log.push("stop");
    });

    mod.setSessionPrivacy("masked");
    mod.syncSessionRecording(client, "/servers");

    expect(client.log).toContain("stop");
    expect(flushed).toBeNull();
  });

  it("drops frames older than the masked recorder from a later flush", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const mod = await load({ hosted: true });
    const client = posthogStub();
    mod.setSessionPrivacy("full");
    mod.syncSessionRecording(client, "/servers");
    vi.setSystemTime(5_000);
    mod.setSessionPrivacy("masked");
    mod.syncSessionRecording(client, "/servers");

    // A deferred flush of the full buffer, then the masked recorder's own.
    expect(mod.replayFramesToSend([{ timestamp: 4_999 }])).toBeNull();
    expect(
      mod.replayFramesToSend([
        { timestamp: 4_000 },
        { timestamp: 5_000 },
        { timestamp: 5_001 },
      ]),
    ).toEqual([{ timestamp: 5_000 }, { timestamp: 5_001 }]);
  });

  it("passes frames through on the full profile, and refuses a non-array", async () => {
    const mod = await load({ hosted: true });
    const client = posthogStub();
    mod.setSessionPrivacy("full");
    mod.syncSessionRecording(client, "/servers");

    const frames = [{ timestamp: 1 }];
    expect(mod.replayFramesToSend(frames)).toBe(frames);
    expect(mod.replayFramesToSend("not frames")).toBeNull();
  });

  it("keeps what a masked → full stop flushes: it was recorded masked", async () => {
    const mod = await load({ hosted: true });
    const client = posthogStub();
    mod.setSessionPrivacy("masked");
    mod.syncSessionRecording(client, "/servers");
    let flushed: unknown[] | null | undefined;
    const frames = [{ timestamp: Date.now() + 1 }];
    client.stopSessionRecording.mockImplementation(() => {
      flushed = mod.replayFramesToSend(frames);
      return client.log.push("stop");
    });

    mod.setSessionPrivacy("full");
    mod.syncSessionRecording(client, "/servers");

    expect(flushed).toEqual(frames);
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

  it("takes the page's text out of click and key frames short of full", async () => {
    const mod = await load({ hosted: true });
    const clickFrame = {
      data: {
        tag: "breadcrumb",
        payload: {
          category: "ui.slowClickDetected",
          message:
            'body > div.app > button#server-acme-prod.btn[aria-label="Delete Acme Prod"][type="button"]',
          data: {
            url: "https://app.mcpjam.com/servers/acme-prod",
            route: "/servers/acme-prod",
            nodeId: 12,
            node: {
              id: 12,
              tagName: "button",
              textContent: "Delete Acme Prod",
              attributes: {
                id: "server-acme-prod",
                class: "btn",
                "aria-label": "Delete Acme Prod",
                title: "Delete Acme Prod",
                name: "acme-prod",
                testId: "repo-row-acme/prod",
              },
            },
            clickCount: 1,
          },
        },
      },
    };
    mod.setSessionPrivacy("full");
    expect(mod.filterSentryReplayFrame(clickFrame)).toBe(clickFrame);

    mod.setSessionPrivacy("masked");
    const payload = mod.filterSentryReplayFrame(clickFrame)?.data
      .payload as any;
    expect(JSON.stringify(payload)).not.toMatch(/acme/i);
    expect(payload).toMatchObject({
      category: "ui.slowClickDetected",
      message: "body > div.app > button.btn",
      data: {
        url: "https://app.mcpjam.com/servers/[name]",
        route: "/servers/[name]",
        nodeId: 12,
        clickCount: 1,
        node: {
          tagName: "button",
          textContent: "****** **** ****",
          attributes: {
            id: "***",
            class: "btn",
            "aria-label": "***",
            title: "***",
            name: "***",
            testId: "***",
          },
        },
      },
    });
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
    // Sentry's rrweb skips attribute masking for `style`: an element whose
    // inline style names a URL or holds a string is blocked instead.
    expect(SENTRY_REPLAY_OPTIONS.block).toEqual(
      expect.arrayContaining([
        '[style*="url(" i]',
        '[style*="image-set(" i]',
        `[style*='"']`,
        `[style*="'"]`,
      ]),
    );
  });
});

describe("stripSelectorAttributes", () => {
  it("drops every attribute part, values with brackets included", async () => {
    const { stripSelectorAttributes } = await load();
    expect(
      stripSelectorAttributes(
        'div#main > button.btn[aria-label="a]b"][disabled][title="Zelda"]',
      ),
    ).toBe("div > button.btn");
    // An id can be a name: an MCP prompt argument's, an elicitation field's.
    expect(
      stripSelectorAttributes("form > input#prompt-arg-acme-billing.field"),
    ).toBe("form > input.field");
  });

  it("cuts the selector at a value holding its own quote", async () => {
    const { stripSelectorAttributes } = await load();
    expect(
      stripSelectorAttributes('div > span.x[title="say "Zelda""] > b'),
    ).toBe("div > span.x");
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

describe("filterSentryBreadcrumb", () => {
  it("keeps everything at full", async () => {
    const mod = await load({ hosted: true });
    mod.setSessionPrivacy("full");
    const crumb = { category: "console", message: "Zelda" };
    expect(mod.filterSentryBreadcrumb(crumb)).toBe(crumb);
  });

  it("short of full: drops console output and scrubs names from URLs", async () => {
    const mod = await load({ hosted: true });
    for (const level of ["masked", "pending"] as const) {
      mod.setSessionPrivacy(level);
      expect(
        mod.filterSentryBreadcrumb({ category: "console", message: "Zelda" }),
      ).toBeNull();
      expect(
        mod.filterSentryBreadcrumb({
          category: "fetch",
          data: { url: "/api/web/servers/acme-billing", method: "GET" },
        }),
      ).toEqual({
        category: "fetch",
        data: { url: "/api/web/servers/[name]", method: "GET" },
      });
      expect(
        mod.filterSentryBreadcrumb({
          category: "navigation",
          data: { from: "/servers/acme", to: "/servers/zelda" },
        }),
      ).toEqual({
        category: "navigation",
        data: { from: "/servers/[name]", to: "/servers/[name]" },
      });
      for (const category of ["ui.click", "ui.input"]) {
        expect(
          mod.filterSentryBreadcrumb({
            category,
            message:
              'div.row > button.danger[aria-label="Delete Acme Prod"][name="acme"]',
            data: { "ui.component_name": "DeleteButton" },
          }),
        ).toEqual({
          category,
          message: "div.row > button.danger",
          data: { "ui.component_name": "DeleteButton" },
        });
      }
      const click = { category: "ui.click", message: "button.harness" };
      expect(mod.filterSentryBreadcrumb(click)).toBe(click);
    }
  });
});

describe("remembered replay off", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("holds off the person it was answered for, and anyone not known yet", async () => {
    const mod = await load({ hosted: true });
    expect(mod.replayOffRemembered("user_a")).toBe(false);

    mod.rememberReplayOff("user_a", true);
    expect(mod.replayOffRemembered("user_a")).toBe(true);
    expect(mod.replayOffRemembered(undefined)).toBe(true);
    expect(mod.replayOffRemembered("user_b")).toBe(false);
    expect(mod.replayOffRemembered(null)).toBe(false);
  });

  it("survives a reload, and a later answer for the same person clears it", async () => {
    const first = await load({ hosted: true });
    first.rememberReplayOff("user_a", true);

    const reloaded = await load({ hosted: true });
    expect(reloaded.replayOffRemembered("user_a")).toBe(true);
    // An answer for someone else leaves it alone.
    reloaded.rememberReplayOff("user_b", false);
    expect(reloaded.replayOffRemembered("user_a")).toBe(true);
    reloaded.rememberReplayOff("user_a", false);
    expect(reloaded.replayOffRemembered("user_a")).toBe(false);
    expect((await load({ hosted: true })).replayOffRemembered(undefined)).toBe(
      false,
    );
  });

  it("works from memory when storage throws", async () => {
    const mod = await load({ hosted: true });
    const storage = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    try {
      mod.rememberReplayOff("user_a", true);
      expect(mod.replayOffRemembered("user_a")).toBe(true);
    } finally {
      storage.mockRestore();
      write.mockRestore();
    }
  });
});
