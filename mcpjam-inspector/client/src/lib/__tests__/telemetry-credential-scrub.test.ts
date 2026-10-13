import { afterEach, describe, expect, it, vi } from "vitest";

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
