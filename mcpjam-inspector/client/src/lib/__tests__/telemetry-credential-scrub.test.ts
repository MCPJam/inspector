import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureResult } from "posthog-js";

/**
 * The client half of the credential guarantee (`shared/credential-urls.ts`):
 * PostHog's `before_send`, its replay callbacks, Sentry's transaction names,
 * and the navigation guard. Every test plants a credential and asserts it is
 * gone AND that the rest of the payload arrived — a scrubber that drops the
 * event would pass the first half alone.
 */
const SECRET = "SENTINELq8w2";

async function loadAt(level: "full" | "masked") {
  vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
  vi.stubEnv("VITE_DISABLE_POSTHOG_LOCAL", "false");
  vi.resetModules();
  const privacy = await import("../session-privacy");
  privacy.setSessionPrivacy(level);
  const posthog = await import("../PosthogUtils");
  return { ...privacy, ...posthog };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

function event(
  name: string,
  properties: Record<string, unknown>,
  extra: Partial<CaptureResult> = {},
): CaptureResult {
  return {
    uuid: "u-1",
    event: name,
    properties: { token: "phc_project", distinct_id: "user-1", ...properties },
    ...extra,
  } as CaptureResult;
}

describe("scrubCaptureEvent (PostHog before_send)", () => {
  it.each(["full", "masked"] as const)(
    "takes every credential out of every field at %s",
    async (level) => {
      const { scrubCaptureEvent } = await loadAt(level);
      const out = scrubCaptureEvent(
        event(
          "$autocapture",
          {
            $current_url: `https://app.mcpjam.com/results/${SECRET}`,
            $referrer: `https://app.mcpjam.com/oauth/callback?code=${SECRET}`,
            $pathname: `/bench/results/${SECRET}`,
            $elements_chain: `a:href="/evals/shared/${SECRET}"nth-child="1"`,
            $external_click_url: `https://idp.example/cb?state=${SECRET}`,
            $web_vitals_LCP_event: {
              $current_url: `/conformance/shared/${SECRET}`,
            },
            $$heatmap: {
              [`https://app.mcpjam.com/results/${SECRET}`]: [{ x: 1 }],
            },
            $exception_list: [
              { type: "Error", value: `failed GET /results/${SECRET}` },
            ],
            button: "Copy",
          },
          {
            $set: { last_url: `/connect/server/${SECRET}` },
            $set_once: { first_url: `/?_token=${SECRET}` },
          },
        ),
      );
      expect(out).not.toBeNull();
      expect(JSON.stringify(out)).not.toContain(SECRET);
      // The event still arrives, with what makes it ingestible.
      expect(out?.event).toBe("$autocapture");
      expect(out?.uuid).toBe("u-1");
      expect(out?.properties.token).toBe("phc_project");
      expect(out?.properties.distinct_id).toBe("user-1");
      expect(out?.properties.button).toBe("Copy");
    },
  );

  it("returns an event with nothing to scrub intact", async () => {
    const { scrubCaptureEvent } = await loadAt("full");
    const input = event("clicked", {
      $current_url: "https://app.mcpjam.com/p/k1/servers",
      count: 3,
    });
    const out = scrubCaptureEvent(input);
    expect(out?.properties).toEqual(input.properties);
  });

  it("fails closed: an event the walker cannot finish loses its URL fields", async () => {
    const { scrubCaptureEvent } = await loadAt("full");
    let deep: unknown = `/results/${SECRET}`;
    for (let i = 0; i < 100; i++) deep = { d: deep };
    const out = scrubCaptureEvent(
      event("$exception", {
        $current_url: `/results/${SECRET}`,
        $exception_list: deep,
        kept: "yes",
      }),
    );
    expect(JSON.stringify(out)).not.toContain(SECRET);
    expect(out?.properties.kept).toBe("yes");
    expect(out?.properties.token).toBe("phc_project");
  });

  it("fails closed: drops what it cannot clean at all", async () => {
    const { scrubCaptureEvent } = await loadAt("full");
    let deep: unknown = "x";
    for (let i = 0; i < 100; i++) deep = { d: deep };
    expect(scrubCaptureEvent(event("custom", { nested: deep }))).toBeNull();
  });

  describe("$snapshot batches", () => {
    it("scrubs meta, custom and plugin events, passes DOM events through", async () => {
      const { scrubCaptureEvent } = await loadAt("full");
      const fullSnapshot = {
        type: 2,
        data: {
          node: {
            type: 0,
            id: 1,
            childNodes: [{ type: 3, id: 2, textContent: "Results" }],
          },
          initialOffset: { top: 0, left: 0 },
        },
      };
      const out = scrubCaptureEvent(
        event("$snapshot", {
          $session_id: "s1",
          $snapshot_data: [
            {
              type: 4,
              data: { href: `https://app.mcpjam.com/results/${SECRET}` },
            },
            fullSnapshot,
            {
              type: 5,
              data: {
                tag: "$url_changed",
                payload: { href: `/?code=${SECRET}` },
              },
            },
            {
              type: 6,
              data: {
                plugin: "rrweb/console@1",
                payload: {
                  level: "log",
                  payload: [`"open /results/${SECRET}"`],
                },
              },
            },
          ],
        }),
      );
      expect(out).not.toBeNull();
      expect(JSON.stringify(out)).not.toContain(SECRET);
      const data = out?.properties.$snapshot_data as unknown[];
      expect(data).toHaveLength(4);
      // A DOM event with no stylesheet credential is forwarded as it came.
      expect(data[1]).toBe(fullSnapshot);
      expect(out?.properties.$session_id).toBe("s1");
    });

    const styleUrl = `url("https://example.test/media?token=${SECRET}")`;
    const sheetUrl = `url(/results/${SECRET})`;

    it("scrubs stylesheet text in a full snapshot", async () => {
      const { scrubCaptureEvent } = await loadAt("full");
      const styleText = {
        type: 3,
        id: 4,
        isStyle: true,
        textContent: `.hero { background: ${styleUrl}; color: red; }`,
      };
      const untouched = { type: 3, id: 9, textContent: "Plain words" };
      const snapshot = {
        type: 2,
        timestamp: 1,
        data: {
          node: {
            type: 0,
            id: 1,
            childNodes: [
              {
                type: 2,
                id: 2,
                tagName: "head",
                attributes: {},
                childNodes: [
                  {
                    type: 2,
                    id: 3,
                    tagName: "style",
                    attributes: {},
                    childNodes: [styleText],
                  },
                  {
                    type: 2,
                    id: 5,
                    tagName: "link",
                    attributes: {
                      rel: "stylesheet",
                      _cssText: `.a { mask: ${sheetUrl}; }`,
                    },
                    childNodes: [],
                  },
                ],
              },
              {
                type: 2,
                id: 6,
                tagName: "div",
                attributes: { style: `background-image: ${styleUrl};` },
                childNodes: [untouched],
              },
            ],
          },
          initialOffset: { top: 0, left: 0 },
        },
      };
      const out = scrubCaptureEvent(
        event("$snapshot", { $snapshot_data: [snapshot] }),
      );

      expect(out).not.toBeNull();
      const json = JSON.stringify(out);
      expect(json).not.toContain(SECRET);
      expect(json).toContain("https://example.test/media?token=[redacted]");
      expect(json).toContain("color: red;");
      expect(json).toContain("/results/[redacted]");
      // rrweb's mirror holds the emitted nodes: they are copied, not edited.
      expect(styleText.textContent).toContain(SECRET);
      const [scrubbed] = out?.properties.$snapshot_data as (typeof snapshot)[];
      const div = scrubbed.data.node.childNodes[1];
      expect(div.childNodes[0]).toBe(untouched);
    });

    it("scrubs stylesheet text in incremental events", async () => {
      const { scrubCaptureEvent } = await loadAt("full");
      const incremental = (data: Record<string, unknown>) => ({
        type: 3,
        timestamp: 2,
        data,
      });
      const out = scrubCaptureEvent(
        event("$snapshot", {
          $snapshot_data: [
            incremental({
              source: 0,
              texts: [{ id: 4, value: `.x { background: ${styleUrl}; }` }],
              attributes: [
                {
                  id: 5,
                  attributes: { _cssText: `.a { mask: ${sheetUrl}; }` },
                },
                {
                  id: 6,
                  attributes: {
                    style: { "background-image": [styleUrl, "important"] },
                  },
                },
                { id: 7, attributes: { style: `background: ${styleUrl}` } },
              ],
              removes: [],
              adds: [
                {
                  parentId: 2,
                  nextId: null,
                  node: {
                    type: 2,
                    id: 8,
                    tagName: "style",
                    attributes: {},
                    childNodes: [
                      {
                        type: 3,
                        id: 10,
                        isStyle: true,
                        textContent: `@import ${sheetUrl};`,
                      },
                    ],
                  },
                },
              ],
            }),
            incremental({
              source: 8,
              id: 8,
              adds: [{ rule: `.y { background: ${styleUrl}; }`, index: 0 }],
              replace: `.z { background: ${sheetUrl}; }`,
            }),
            incremental({
              source: 13,
              id: 8,
              index: [0],
              set: { property: "background", value: styleUrl },
            }),
            incremental({
              source: 15,
              id: 1,
              styleIds: [1],
              styles: [
                { styleId: 1, rules: [{ rule: `.w { mask: ${sheetUrl}; }` }] },
              ],
            }),
            incremental({
              source: 10,
              family: "Brand",
              fontSource: styleUrl,
              buffer: false,
            }),
            incremental({ source: 1, positions: [{ x: 1, y: 2, id: 3 }] }),
          ],
        }),
      );

      expect(out).not.toBeNull();
      expect(JSON.stringify(out)).not.toContain(SECRET);
      const data = out?.properties.$snapshot_data as { data: unknown }[];
      expect(data).toHaveLength(6);
      expect(data[5]?.data).toEqual({
        source: 1,
        positions: [{ x: 1, y: 2, id: 3 }],
      });
    });

    it("never receives packed DOM events, and drops a batch that has one", async () => {
      const { scrubCaptureEvent, posthogPrivacyConfig } = await loadAt("full");
      for (const profile of ["full", "masked"] as const) {
        const recording = posthogPrivacyConfig(profile).session_recording as {
          compress_events?: boolean;
        };
        expect(recording.compress_events).toBe(false);
      }
      const packed = "\u001f\u008b\u0008packed";
      for (const item of [
        { type: 2, cv: "2024-10", data: packed },
        {
          type: 3,
          cv: "2024-10",
          data: { source: 0, texts: packed, adds: packed },
        },
        { type: 2, data: packed },
      ]) {
        expect(
          scrubCaptureEvent(event("$snapshot", { $snapshot_data: [item] })),
        ).toBeNull();
      }
    });

    it.each([
      ["not an array", "nope"],
      ["an item without a type", [{ data: {} }]],
      ["an unknown event type", [{ type: 99, data: {} }]],
    ])("drops a batch that is %s", async (_label, data) => {
      const { scrubCaptureEvent } = await loadAt("full");
      expect(
        scrubCaptureEvent(event("$snapshot", { $snapshot_data: data })),
      ).toBeNull();
    });
  });

  it("is wired into options with hashes off", async () => {
    const { options, scrubCaptureEvent } = await loadAt("full");
    expect(options.before_send).toContain(scrubCaptureEvent);
    expect(options.disable_capture_url_hashes).toBe(true);
    expect("sanitize_properties" in options).toBe(false);
  });
});

describe("replay callbacks", () => {
  it.each(["full", "masked"] as const)(
    "the network hook keeps a scrubbed URL and timing only, at %s",
    async (level) => {
      const { posthogPrivacyConfig } = await loadAt(level);
      const config = posthogPrivacyConfig(level) as {
        session_recording: {
          maskCapturedNetworkRequestFn: (
            r: Record<string, unknown>,
          ) => Record<string, unknown> | null;
          recordHeaders: boolean;
          recordBody: boolean;
        };
      };
      expect(config.session_recording.recordHeaders).toBe(false);
      expect(config.session_recording.recordBody).toBe(false);
      const out = config.session_recording.maskCapturedNetworkRequestFn({
        name: `https://app.mcpjam.com/api/web/score/runs/${SECRET}`,
        entryType: "resource",
        initiatorType: "fetch",
        method: "GET",
        status: 200,
        startTime: 1,
        duration: 2,
        requestHeaders: { authorization: `Bearer ${SECRET}` },
        responseBody: SECRET,
        serverTiming: [{ name: SECRET }],
      });
      expect(JSON.stringify(out)).not.toContain(SECRET);
      expect(out).toMatchObject({
        entryType: "resource",
        method: "GET",
        status: 200,
        startTime: 1,
        duration: 2,
      });
      expect(String(out?.name)).toContain("/api/web/score/runs/[redacted]");
    },
  );

  it("never hands posthog-js an empty page URL", async () => {
    const { maskReplayRequestFull, REPLAY_PLACEHOLDER_HREF } =
      await loadAt("full");
    expect(maskReplayRequestFull({ name: "" })?.name).toBe(
      REPLAY_PLACEHOLDER_HREF,
    );
    expect(maskReplayRequestFull({ name: `/results/${SECRET}` })?.name).toBe(
      "/results/[redacted]",
    );
  });

  it("masks a foreign host at masked, keeps ours", async () => {
    const { scrubNamesFromUrl } = await loadAt("masked");
    expect(scrubNamesFromUrl("https://mcp.acme.example/tenants/42")).toBe(
      "https://[host]/[name]/42",
    );
    expect(
      scrubNamesFromUrl("https://app.mcpjam.com/p/k17abc9z/servers"),
    ).toMatch(/^https:\/\/app\.mcpjam\.com\/p\//);
  });

  it("scrubs a hex share secret before name masking could keep it as an id", async () => {
    const { scrubNamesFromUrl } = await loadAt("masked");
    expect(scrubNamesFromUrl("/bench/results/0123456789abcdef0123456789")).toBe(
      "/bench/results/[redacted]",
    );
  });

  it("scrubs a percent-encoded credential from a replay text node and attribute", async () => {
    const { posthogPrivacyConfig } = await loadAt("full");
    const recording = posthogPrivacyConfig("full").session_recording as {
      maskTextFn: (text: string, element?: Element) => string;
      maskAttributeFn: (name: string, value: string) => string;
    };
    // Neither a `/` nor an `=` survives encoding.
    const encoded = encodeURIComponent(`/results/${SECRET}`);
    expect(encoded).not.toMatch(/[/=]/);

    const text = recording.maskTextFn(`Share link: ${encoded}`);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("Share link: %2Fresults%2F");
    const attribute = recording.maskAttributeFn("data-link", encoded);
    expect(attribute).not.toContain(SECRET);
    expect(attribute).toContain("%2Fresults%2F");
  });

  it("attributes keep their content at full, minus credentials", async () => {
    const { maskReplayAttributeFull, maskReplayAttribute } =
      await loadAt("full");
    expect(maskReplayAttributeFull("class", "btn primary")).toBe("btn primary");
    expect(
      maskReplayAttributeFull(
        "src",
        `/user-testing/acme/${SECRET}?surface=preview`,
      ),
    ).toBe("/user-testing/acme/[redacted]?surface=preview");
    expect(maskReplayAttribute("href", `/results/${SECRET}`)).toBe("***");
    expect(
      maskReplayAttribute("style", `background:url(/results/${SECRET})`),
    ).not.toContain(SECRET);
  });
});

describe("sentryTransactionName", () => {
  it("names credential routes by template; other paths keep their words", async () => {
    vi.stubGlobal("__APP_VERSION__", "test");
    vi.stubGlobal("__BUILD_SURFACE__", "local");
    await loadAt("full");
    const { sentryTransactionName } = await import("../sentry");
    expect(sentryTransactionName(`/results/${SECRET}`)).toBe(
      "/results/:runToken",
    );
    expect(sentryTransactionName(`/user-testing/acme/${SECRET}`)).toBe(
      "/user-testing/:slug/:token",
    );
    // Names in other paths are the privacy level's to decide: kept at full,
    // scrubbed on the way out short of it.
    expect(sentryTransactionName("/p/k17abc/servers/srv_1")).toBe(
      "/p/k17abc/servers/srv_1",
    );
    expect(sentryTransactionName(`/servers?code=${SECRET}`)).not.toContain(
      SECRET,
    );
    expect(sentryTransactionName("/settings/api-keys")).toBe(
      "/settings/api-keys",
    );
  });
});

describe("installRecorderNavigationGuard", () => {
  it("stops both recorders before a pushState onto a credential URL", async () => {
    vi.stubGlobal("__APP_VERSION__", "test");
    vi.stubGlobal("__BUILD_SURFACE__", "local");
    vi.resetModules();
    const order: string[] = [];
    vi.doMock("../sentry", () => ({
      syncSentryReplay: vi.fn((location: { pathname: string }) =>
        order.push(`sentry:${location.pathname}`),
      ),
    }));
    vi.doMock("../session-privacy", () => ({
      lastSyncedPostHogClient: () => ({}),
      syncSessionRecording: vi.fn(
        (_client: unknown, location: { pathname: string }) =>
          order.push(`posthog:${location.pathname}`),
      ),
    }));
    const { installRecorderNavigationGuard } =
      await import("../recorder-navigation-guard");
    const realPush = window.history.pushState;
    const spy = vi.fn(function (
      this: History,
      ...args: Parameters<History["pushState"]>
    ) {
      order.push(`push:${String(args[2])}`);
      return realPush.apply(this, args);
    });
    window.history.pushState = spy;
    const uninstall = installRecorderNavigationGuard();
    try {
      window.history.pushState({}, "", "/p/x/servers");
      window.history.pushState({}, "", `/results/${SECRET}`);
      window.history.pushState({}, "", "/oauth/callback?code=abc");
      expect(order).toEqual([
        "push:/p/x/servers",
        "posthog:/results/" + SECRET,
        "sentry:/results/" + SECRET,
        `push:/results/${SECRET}`,
        "posthog:/oauth/callback",
        "sentry:/oauth/callback",
        "push:/oauth/callback?code=abc",
      ]);
    } finally {
      uninstall();
      window.history.pushState = realPush;
      window.history.replaceState({}, "", "/");
      vi.doUnmock("../sentry");
      vi.doUnmock("../session-privacy");
    }
  });
});

describe("Sentry Replay blocks elements whose URL attributes carry a credential", () => {
  // Sentry's rrweb writes `href`/`src` without consulting `maskAttributes`,
  // so these elements must be BLOCKED, by selector.
  it.each([
    ["href", `https://app.mcpjam.com/results/${SECRET}`],
    ["href", `/bench/results/${SECRET}`],
    [
      "src",
      `https://app.mcpjam.com/user-testing/acme/${SECRET}?surface=preview`,
    ],
    ["href", `/api/mcp/servers/rpc/stream?serverId=a&_token=${SECRET}`],
    ["href", `/oauth/callback?code=${SECRET}`],
    ["action", `https://idp.example/sso?SAMLResponse=${SECRET}`],
  ])("blocks %s=%s", async (attribute, value) => {
    const { SENTRY_REPLAY_OPTIONS } = await loadAt("full");
    const element = document.createElement(
      attribute === "src" ? "iframe" : "a",
    );
    element.setAttribute(attribute, value);
    expect(element.matches(SENTRY_REPLAY_OPTIONS.block.join(","))).toBe(true);
  });

  // Selectors cannot follow the URL scrubber's semantics, so every element
  // with an attribute Sentry records unmasked is blocked, whatever it holds.
  it.each([
    ["a", "href", `https://user:${SECRET}@example.com/path`],
    ["a", "href", `https://app.mcpjam.com/%72esults/${SECRET}`],
    ["a", "href", `https://example.com/path?x_vendor_access_token=${SECRET}`],
    ["a", "href", "/p/k1/servers?tab=tools"],
    ["iframe", "src", "https://docs.mcpjam.com/x"],
    ["img", "srcset", "/a.png 1x, /b.png 2x"],
    ["div", "style", "background-image: url(/x.png)"],
  ])("blocks <%s %s=%s>", async (tag, attribute, value) => {
    const { SENTRY_REPLAY_OPTIONS } = await loadAt("full");
    const element = document.createElement(tag);
    element.setAttribute(attribute, value);
    expect(element.matches(SENTRY_REPLAY_OPTIONS.block.join(","))).toBe(true);
  });

  it("leaves elements without a URL attribute recorded", async () => {
    const { SENTRY_REPLAY_OPTIONS } = await loadAt("full");
    const button = document.createElement("button");
    button.setAttribute("title", "Open");
    const section = document.createElement("section");
    section.setAttribute("style", "color: red");
    for (const element of [button, section, document.createElement("a")]) {
      expect(element.matches(SENTRY_REPLAY_OPTIONS.block.join(","))).toBe(
        false,
      );
    }
  });
});

describe("scrubPostHogPersistence", () => {
  it("takes credentials out of what posthog-js stored, in place", async () => {
    const { scrubPostHogPersistence } = await loadAt("full");
    const props: Record<string, unknown> = {
      distinct_id: "user-1",
      $initial_person_info: {
        u: `https://app.mcpjam.com/results/${SECRET}`,
        r: "$direct",
      },
    };
    const save = vi.fn();
    scrubPostHogPersistence({ persistence: { props, save } });
    expect(JSON.stringify(props)).not.toContain(SECRET);
    expect(props.distinct_id).toBe("user-1");
    expect(props.$initial_person_info).toEqual({
      u: "https://app.mcpjam.com/results/[redacted]",
      r: "$direct",
    });
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("saves nothing when there was nothing to scrub", async () => {
    const { scrubPostHogPersistence } = await loadAt("full");
    const save = vi.fn();
    scrubPostHogPersistence({
      persistence: { props: { distinct_id: "user-1" }, save },
    });
    expect(save).not.toHaveBeenCalled();
  });
});
