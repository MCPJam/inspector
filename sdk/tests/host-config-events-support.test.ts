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
  clearEventsHostSetting,
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

  it("falls back to the host style when nothing is saved", () => {
    expect(resolveHostEventDeliveryModes({ hostStyle: "chatgpt" })).toEqual([
      "webhook",
    ]);
    expect(resolveHostEventDeliveryModes({ hostStyle: "mcpjam" })).toEqual([
      "poll",
      "push",
      "webhook",
    ]);
    expect(resolveHostEventDeliveryModes({ hostStyle: "claude" })).toEqual([]);
    expect(resolveHostEventDeliveryModes({ hostStyle: null })).toEqual([]);
    // Own entries only: a style named like an Object member has no default.
    for (const hostStyle of ["constructor", "toString", "__proto__"]) {
      expect(resolveHostEventDeliveryModes({ hostStyle })).toEqual([]);
    }
  });

  it("reads a saved setting over the style, true modes only", () => {
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
      resolveHostEventDeliveryModes({ hostStyle: "mcpjam", mcpProfile: "on" })
    ).toEqual([]);
    expect(
      resolveHostEventDeliveryModes({
        hostStyle: "mcpjam",
        mcpProfile: { extensions: new Map() },
      })
    ).toEqual([]);
  });
});

describe("setEventsHostSetting / clearEventsHostSetting", () => {
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
      readEventsHostSetting(setEventsHostSetting({ hostStyle: "chatgpt" }, []))
    ).toEqual({ kind: "valid", modes: [] });
  });

  it("clears back to the style default without leaving empty containers", () => {
    const host = { hostStyle: "chatgpt" };
    // A profile it creates carries its version, so it canonicalizes.
    expect(setEventsHostSetting(host, []).mcpProfile).toEqual({
      profileVersion: 1,
      extensions: { [MCPJAM_EVENTS_EXTENSION_ID]: {} },
    });
    expect(clearEventsHostSetting(setEventsHostSetting(host, []))).toEqual(
      host
    );
    const withTasks = {
      hostStyle: "chatgpt",
      mcpProfile: {
        profileVersion: 1,
        extensions: { "com.mcpjam/tasks": { enabled: false } },
      },
    };
    expect(
      clearEventsHostSetting(setEventsHostSetting(withTasks, ["poll"]))
    ).toEqual(withTasks);
    expect(clearEventsHostSetting(host)).toBe(host);
  });
});

describe("subscribableModes", () => {
  it("is the intersection of runtime, event and host", () => {
    const result = subscribableModes({
      host: { hostStyle: "mcpjam" },
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
      host: { hostStyle: "chatgpt" },
      runtime: "hosted",
    });
    expect(chatgpt.modes).toEqual(["webhook"]);
    expect(describeModeRefusal("poll", chatgpt, "ChatGPT")).toBe(
      "ChatGPT doesn't receive events by poll. Turn it on in its Protocol settings, or pick another client."
    );
    expect(describeModeRefusal("push", chatgpt, "ChatGPT")).toBe(
      "Hosted subscriptions can't use push yet. Use webhook or poll, or subscribe from the local app."
    );
    expect(describeModeRefusal("webhook", chatgpt, "ChatGPT")).toBeNull();
    expect(describeNoSubscribableMode(chatgpt, "ChatGPT")).toBeNull();
  });

  it("explains an empty result from the host's side first", () => {
    const claude = subscribableModes({
      host: { hostStyle: "claude" },
      eventModes: ["webhook"],
      runtime: "hosted",
    });
    expect(describeNoSubscribableMode(claude, "Claude")).toBe(
      "Claude doesn't receive events. Turn on a delivery mode in its Protocol settings, or pick another client."
    );
    const pollOnly = subscribableModes({
      host: { hostStyle: "chatgpt" },
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

  it("canonicalizes a setting saved on a host with no profile", async () => {
    const set = setEventsHostSetting(base(), ["webhook"]);
    expect(
      canonicalizeHostConfigV2(set).mcpProfile?.extensions?.[
        MCPJAM_EVENTS_EXTENSION_ID
      ]
    ).toEqual({ webhook: true });
    expect(await computeHostConfigHashV2(clearEventsHostSetting(set))).toBe(
      await computeHostConfigHashV2(base())
    );
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

  it("matches the conformance profiles for ChatGPT and MCPJam", () => {
    const catalog = bundledHostCompatCatalog();
    expect(
      resolveHostEventDeliveryModes(getCatalogTemplate(catalog, "chatgpt"))
    ).toEqual(CHATGPT_PROFILE.deliveryModes.value);
    expect(
      [
        ...resolveHostEventDeliveryModes(getCatalogTemplate(catalog, "mcpjam")),
      ].sort()
    ).toEqual([...DRAFT_PROFILE.deliveryModes.value].sort());
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
