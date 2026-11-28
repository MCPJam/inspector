import { describe, expect, it } from "vitest";
import {
  canonicalizeHostConfigV2,
  computeHostConfigHashV2,
} from "../src/host-config/internal";
import type {
  HostConfigInputV2,
  HostConfigMcpProfileV1,
} from "../src/host-config/internal";
import {
  EVENT_DELIVERY_MODES,
  MCPJAM_EVENTS_EXTENSION_ID,
  describeModeRefusal,
  describeNoSubscribableMode,
  readEventsHostSetting,
  resolveHostEventDeliveryModes,
  setEventsHostSetting,
  subscribableModes,
} from "../src/host-config/events-support";
import {
  bundledHostCompatCatalog,
  getCatalogTemplate,
} from "../src/host-compat/index";
import { CHATGPT_PROFILE, DRAFT_PROFILE } from "../src/events/profiles";

// A client with an Apps style and nothing saved: the style must not matter.
const unsaved = (hostStyle: string) => ({ hostStyle, mcpProfile: undefined });

const saved = (events: unknown, hostStyle = "chatgpt") => ({
  hostStyle,
  mcpProfile: {
    profileVersion: 1,
    extensions: { [MCPJAM_EVENTS_EXTENSION_ID]: events },
  },
});

describe("resolveHostEventDeliveryModes", () => {
  it("is every mode for MCPJam (built-in), i.e. no host", () => {
    expect(resolveHostEventDeliveryModes(null)).toEqual(EVENT_DELIVERY_MODES);
    expect(resolveHostEventDeliveryModes(undefined)).toEqual(
      EVENT_DELIVERY_MODES
    );
  });

  it("is no modes when nothing is saved, whatever the style", () => {
    for (const hostStyle of ["mcpjam", "chatgpt", "chatgpt-work", "claude"]) {
      expect(resolveHostEventDeliveryModes(unsaved(hostStyle))).toEqual([]);
    }
    expect(resolveHostEventDeliveryModes({})).toEqual([]);
  });

  it("is no modes under a vendor harness, whatever is saved", () => {
    const all = saved({ poll: true, push: true, webhook: true }, "mcpjam");
    expect(resolveHostEventDeliveryModes(all)).toEqual(EVENT_DELIVERY_MODES);
    expect(resolveHostEventDeliveryModes({ ...all, harness: "codex" })).toEqual(
      []
    );
    expect(
      resolveHostEventDeliveryModes({ ...all, agentLoop: "claude-code" })
    ).toEqual([]);
    expect(
      resolveHostEventDeliveryModes({ ...all, harness: null, agentLoop: null })
    ).toEqual(EVENT_DELIVERY_MODES);
  });

  it("reads a saved setting, true modes only", () => {
    expect(
      resolveHostEventDeliveryModes(saved({ poll: true, webhook: false }))
    ).toEqual(["poll"]);
    expect(
      resolveHostEventDeliveryModes(saved({ webhook: true }, "claude"))
    ).toEqual(["webhook"]);
    expect(resolveHostEventDeliveryModes(saved({}))).toEqual([]);
  });

  it("never widens a host on a malformed setting", () => {
    for (const bad of [true, ["webhook"], { webhook: "yes" }, { sse: true }]) {
      expect(readEventsHostSetting(saved(bad, "mcpjam"))).toEqual({
        kind: "invalid",
      });
      expect(resolveHostEventDeliveryModes(saved(bad, "mcpjam"))).toEqual([]);
    }
    expect(
      resolveHostEventDeliveryModes({ mcpProfile: "on" })
    ).toEqual([]);
    expect(
      resolveHostEventDeliveryModes({
        mcpProfile: { extensions: new Map() },
      })
    ).toEqual([]);
  });
});

describe("setEventsHostSetting", () => {
  it("saves only the true modes and keeps other extensions", () => {
    const host = {
      hostStyle: "claude",
      mcpProfile: {
        profileVersion: 1,
        extensions: { "com.mcpjam/tasks": { enabled: true } },
      },
    };
    const next = setEventsHostSetting(host, ["webhook", "poll"]);
    expect(next.mcpProfile).toEqual({
      profileVersion: 1,
      extensions: {
        "com.mcpjam/tasks": { enabled: true },
        [MCPJAM_EVENTS_EXTENSION_ID]: { poll: true, webhook: true },
      },
    });
    expect(resolveHostEventDeliveryModes(next)).toEqual(["poll", "webhook"]);
    expect(
      readEventsHostSetting(setEventsHostSetting(unsaved("chatgpt"), []))
    ).toEqual({ kind: "valid", modes: [] });
  });

  it("creates a versioned profile, so a new setting canonicalizes", () => {
    expect(setEventsHostSetting({}, []).mcpProfile).toEqual({
      profileVersion: 1,
      extensions: { [MCPJAM_EVENTS_EXTENSION_ID]: {} },
    });
  });
});

describe("subscribableModes", () => {
  it("is the intersection of runtime, event and host", () => {
    const result = subscribableModes({
      host: saved({ poll: true, push: true, webhook: true }, "mcpjam"),
      eventModes: ["poll", "push"],
      runtime: "hosted",
    });
    expect(result.modes).toEqual(["poll"]);
    expect(result.refused).toEqual({ push: "runtime", webhook: "event" });
    expect(subscribableModes({ host: null, runtime: "local" }).modes).toEqual(
      EVENT_DELIVERY_MODES
    );
  });

  it("names the side that refused, so the user knows what to change", () => {
    const chatgpt = subscribableModes({
      host: saved({ webhook: true }, "chatgpt-work"),
      runtime: "hosted",
    });
    expect(chatgpt.modes).toEqual(["webhook"]);
    expect(describeModeRefusal("poll", chatgpt, "ChatGPT")).toBe(
      "ChatGPT doesn't receive events by poll. Turn it on in the client's Events tab, or pick another client."
    );
    expect(describeModeRefusal("push", chatgpt, "ChatGPT")).toBe(
      "Hosted subscriptions can't use push yet. Use webhook or poll, or subscribe from the local app."
    );
    expect(describeModeRefusal("webhook", chatgpt, "ChatGPT")).toBeNull();
    expect(describeNoSubscribableMode(chatgpt, "ChatGPT")).toBeNull();
  });

  it("explains an empty result from the host's side first", () => {
    const claude = subscribableModes({
      host: unsaved("claude"),
      eventModes: ["webhook"],
      runtime: "hosted",
    });
    expect(describeNoSubscribableMode(claude, "Claude")).toBe(
      "Claude doesn't receive events. Turn on a delivery mode in the client's Events tab, or pick another client."
    );
    expect(describeNoSubscribableMode(claude, "My Codex client", "Codex")).toBe(
      "My Codex client runs on Codex, which doesn't receive MCP Events. Pick another client."
    );
    const pollOnly = subscribableModes({
      host: saved({ webhook: true }, "chatgpt-work"),
      eventModes: ["poll"],
      runtime: "hosted",
    });
    expect(describeNoSubscribableMode(pollOnly, "ChatGPT")).toBe(
      "ChatGPT receives events by webhook, and the server doesn't offer that for this event. Pick another client."
    );
    const pushOnly = subscribableModes({
      host: saved({ push: true }, "claude"),
      runtime: "hosted",
    });
    expect(describeNoSubscribableMode(pushOnly, "Local")).toBe(
      "Local receives events only by push, which hosted subscriptions can't use yet. Subscribe from the local app, or pick another client."
    );
  });
});

describe("hashes and parity", () => {
  const base = (mcpProfile?: HostConfigMcpProfileV1): HostConfigInputV2 =>
    ({
      hostStyle: "chatgpt",
      modelId: "openai/gpt-5-nano",
      systemPrompt: "",
      temperature: 0.7,
      requireToolApproval: false,
      serverIds: [],
      optionalServerIds: [],
      connectionDefaults: { headers: {}, requestTimeout: 10000 },
      clientCapabilities: {},
      hostContext: {},
      ...(mcpProfile ? { mcpProfile } : {}),
    }) as HostConfigInputV2;

  it("canonicalizes a setting saved on a host with no profile", () => {
    const set = setEventsHostSetting(base(), ["webhook"]);
    expect(
      canonicalizeHostConfigV2(set).mcpProfile?.extensions?.[
        MCPJAM_EVENTS_EXTENSION_ID
      ]
    ).toEqual({ webhook: true });
  });

  it("keeps an explicit {} distinct from absent, and absent hashes as before", async () => {
    const none = base({
      profileVersion: 1,
      extensions: { [MCPJAM_EVENTS_EXTENSION_ID]: {} },
    } as HostConfigMcpProfileV1);
    const canonical = canonicalizeHostConfigV2(none);
    expect(
      canonical.mcpProfile?.extensions?.[MCPJAM_EVENTS_EXTENSION_ID]
    ).toEqual({});
    expect(resolveHostEventDeliveryModes(canonical)).toEqual([]);
    const absent = await computeHostConfigHashV2(base());
    expect(await computeHostConfigHashV2(none)).not.toBe(absent);
    expect(await computeHostConfigHashV2(base())).toBe(absent);
  });

  it("matches the conformance profiles for ChatGPT Work and MCPJam", () => {
    const catalog = bundledHostCompatCatalog();
    for (const id of ["chatgpt-work", "chatgpt-work-desktop"]) {
      expect(
        resolveHostEventDeliveryModes(getCatalogTemplate(catalog, id))
      ).toEqual(CHATGPT_PROFILE.deliveryModes.value);
    }
    expect(
      [
        ...resolveHostEventDeliveryModes(getCatalogTemplate(catalog, "mcpjam")),
      ].sort()
    ).toEqual([...DRAFT_PROFILE.deliveryModes.value].sort());
  });

  it("saves no events for personal ChatGPT, which receives none", () => {
    const catalog = bundledHostCompatCatalog();
    for (const id of ["chatgpt", "chatgpt-desktop"]) {
      const template = getCatalogTemplate(catalog, id);
      expect(readEventsHostSetting(template)).toEqual({
        kind: "valid",
        modes: [],
      });
    }
  });

  it("covers every protocol version the ChatGPT template speaks", () => {
    const template = getCatalogTemplate(bundledHostCompatCatalog(), "chatgpt");
    const versions =
      template?.mcpProfile?.initialize?.supportedProtocolVersions ?? [];
    expect(versions.length).toBeGreaterThan(0);
    for (const version of versions) {
      expect(CHATGPT_PROFILE.protocolVersions.value).toContain(version);
    }
  });
});
