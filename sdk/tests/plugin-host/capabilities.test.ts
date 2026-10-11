import { describe, expect, it, vi } from "vitest";
import {
  createPluginCapabilityRegistry,
  disabledPluginFeatures,
  PLUGIN_EXTENSION_TOGGLE_FEATURES,
  PluginCapabilityError,
  type PluginCapabilityProfile,
  type PluginFeature,
  type PluginFeatureBinding,
  type PluginService,
} from "../../src/plugin-host/index.js";

const serviceNames: PluginService[] = [
  "authorized-invocation",
  "thread-turn",
  "engine-input",
  "instance-context",
  "resource-grants",
  "file-open",
  "form-ui",
  "form-storage",
  "automation",
  "recording-read",
  "inert-render",
  "release",
];
const profile: PluginCapabilityProfile = {
  runtime: "chatgpt-emulated",
  transport: "legacy",
};
const binding = (): PluginFeatureBinding => ({
  coverage: "complete",
  validate: () => true,
  invoke: vi.fn(async (params) => params),
});
function setup(
  features: PluginFeature[],
  overrides: Partial<Parameters<typeof createPluginCapabilityRegistry>[0]> = {}
) {
  const bindings = Object.fromEntries(
    features.map((feature) => [feature, binding()])
  );
  const services = Object.fromEntries(
    serviceNames.map((service) => [service, { available: () => true }])
  );
  const input = {
    profile,
    executionEnabled: () => true,
    bindings,
    services,
    engineCoverage: {
      messages: "complete",
      "model-context": "complete",
      onboarding: "complete",
      automation: "complete",
    } as const,
    ...overrides,
  };
  return { input, registry: createPluginCapabilityRegistry(input) };
}

describe("plugin capability admission and negotiation", () => {
  it.each(["chatgpt-emulated", "codex"] as const)(
    "uses one decision for %s advertisement and dispatch",
    async (runtime) => {
      const { input, registry } = setup(
        ["messages", "model-context", "resources", "file-open", "forms"],
        { profile: { ...profile, runtime } }
      );
      expect(registry.hostCapabilities()).toEqual({
        experimental: {
          "openai/message": {},
          "openai/modelContext": {},
          "openai/resource": {},
          "openai/files": {},
        },
      });
      expect(registry.clientCapabilities()).toEqual({
        extensions: { "openai/elicitation": { form: {} } },
      });
      const params = {
        content: [{ type: "text", text: "test", _meta: { nested: true } }],
        _meta: { opaque: "value" },
      };
      expect(await registry.invoke("messages", params)).toEqual(params);
      expect(input.bindings.messages.invoke).toHaveBeenCalledOnce();
    }
  );

  it("does not trust preset claims or mutate the preset", async () => {
    const { registry } = setup([]);
    const preset = {
      tools: {},
      extensions: { "openai/elicitation": { form: {} }, "vendor/key": {} },
      experimental: {
        "openai/message": {},
        "openai/future": {},
        "vendor/value": { a: true },
      },
    };
    const expected = {
      tools: {},
      extensions: { "vendor/key": {} },
      experimental: { "vendor/value": { a: true } },
    };
    expect(registry.hostCapabilities(preset)).toEqual(expected);
    expect(registry.clientCapabilities(preset)).toEqual(expected);
    expect(preset.experimental).toHaveProperty("openai/message");
    await expect(registry.invoke("messages", {})).rejects.toMatchObject({
      decision: { status: "unimplemented", allowed: false },
    });
  });

  it.each([false, undefined, "true", new Error("lookup unavailable")])(
    "fails closed for an unavailable rollout (%s)",
    async (answer) => {
      const { input, registry } = setup(["messages"], {
        executionEnabled: () => {
          if (answer instanceof Error) throw answer;
          return answer as boolean;
        },
      });
      expect(registry.hostCapabilities()).toEqual({});
      await expect(registry.invoke("messages", {})).rejects.toMatchObject({
        decision: { reason: "EXTENSIONS_DISABLED" },
      });
      expect(input.bindings.messages.invoke).not.toHaveBeenCalled();
    }
  );

  it("revokes availability when a required port disappears", async () => {
    let live = true;
    const { input, registry } = setup(["messages"], {
      services: {
        "thread-turn": { available: () => live },
        "engine-input": { available: () => true },
      },
    });
    expect(registry.decision("messages").allowed).toBe(true);
    live = false;
    expect(registry.hostCapabilities()).toEqual({});
    await expect(registry.invoke("messages", {})).rejects.toMatchObject({
      decision: { reason: "SERVICE_UNAVAILABLE" },
    });
    expect(input.bindings.messages.invoke).not.toHaveBeenCalled();
  });

  it("requires complete request handling and engine fidelity", async () => {
    const incomplete = binding();
    incomplete.coverage = "partial";
    const { registry } = setup(["messages", "model-context"], {
      bindings: { messages: incomplete, "model-context": binding() },
      engineCoverage: { "model-context": "partial" },
    });
    expect(registry.decision("messages")).toMatchObject({
      status: "degraded",
      reason: "HANDLER_INCOMPLETE",
      allowed: false,
    });
    expect(registry.decision("model-context")).toMatchObject({
      status: "degraded",
      reason: "ENGINE_FIDELITY_INCOMPLETE",
      allowed: false,
    });
    expect(registry.hostCapabilities()).toEqual({});
    await expect(registry.invoke("messages", {})).rejects.toBeInstanceOf(
      PluginCapabilityError
    );
    expect(incomplete.invoke).not.toHaveBeenCalled();
  });

  // Desktop-only in the spec's Platform Support table. The client's own
  // toggles decide them; nothing else does.
  const desktopOnly = [
    ["fileViewers", "file-entrypoint"],
    ["mentions", "mentions"],
    ["fileResources", "resources"],
    ["localFiles", "file-open"],
  ] as const;

  it.each(desktopOnly)(
    "refuses %s's feature (%s) when the client turns that toggle off",
    async (toggle, feature) => {
      expect(PLUGIN_EXTENSION_TOGGLE_FEATURES[toggle]).toContain(feature);
      const { input, registry } = setup([feature], {
        profile: {
          ...profile,
          disabledFeatures: disabledPluginFeatures({ [toggle]: false }),
        },
      });
      expect(registry.decision(feature)).toMatchObject({
        status: "blocked",
        reason: "PROFILE_DISABLED",
        allowed: false,
      });
      await expect(registry.invoke(feature, {})).rejects.toBeInstanceOf(
        PluginCapabilityError
      );
      expect(input.bindings[feature].invoke).not.toHaveBeenCalled();
      // Every other desktop-only feature stays on.
      for (const [, other] of desktopOnly)
        if (other !== feature)
          expect(
            setup([other], {
              profile: {
                ...profile,
                disabledFeatures: disabledPluginFeatures({ [toggle]: false }),
              },
            }).registry.decision(other).allowed
          ).toBe(true);
    }
  );

  it.each(["chatgpt-emulated", "codex"] as const)(
    "offers every desktop-only feature to %s when its toggles are on",
    async (runtime) => {
      const features = desktopOnly.map(([, feature]) => feature);
      // A stale platform field from an older caller is ignored.
      const stale = {
        ...profile,
        runtime,
        platform: "web",
        disabledFeatures: disabledPluginFeatures(
          Object.fromEntries(desktopOnly.map(([toggle]) => [toggle, true]))
        ),
      } as PluginCapabilityProfile;
      const { input, registry } = setup(features, { profile: stale });
      for (const feature of features)
        expect(registry.decision(feature)).toMatchObject({
          status: "supported",
          allowed: true,
        });
      expect(registry.hostCapabilities()).toMatchObject({
        experimental: { "openai/resource": {}, "openai/files": {} },
      });
      await registry.invoke("mentions", {});
      expect(input.bindings.mentions.invoke).toHaveBeenCalledOnce();
    }
  );

  it("rejects the whole unsupported request without leaking input or calling a port", async () => {
    const handler = binding();
    handler.validate = (params) =>
      !(params as { unsupported?: boolean }).unsupported;
    const { registry } = setup([], { bindings: { messages: handler } });
    await expect(
      registry.invoke("messages", { unsupported: true, credential: "private" })
    ).rejects.toMatchObject({ message: "PLUGIN_PARAMETERS_UNSUPPORTED" });
    await expect(
      registry.invoke("messages", { nonWire: () => "private" })
    ).rejects.toMatchObject({ message: "PLUGIN_PARAMETERS_UNSUPPORTED" });
    expect(handler.invoke).not.toHaveBeenCalled();
  });

  it("revalidates after validation and fences cancellation before dispatch", async () => {
    let enabled = true;
    const handler = binding();
    handler.validate = () => {
      enabled = false;
      return true;
    };
    const { registry } = setup([], {
      bindings: { messages: handler },
      executionEnabled: () => enabled,
    });
    await expect(registry.invoke("messages", {})).rejects.toMatchObject({
      decision: { reason: "EXTENSIONS_DISABLED" },
    });
    enabled = true;
    const abort = new AbortController();
    abort.abort();
    await expect(
      registry.invoke("messages", {}, { signal: abort.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(handler.invoke).not.toHaveBeenCalled();
  });

  it("captures profile and binding configuration while live authority remains revocable", async () => {
    const original = binding();
    const mutableProfile: PluginCapabilityProfile = { ...profile };
    const { input, registry } = setup([], {
      bindings: { messages: original },
      profile: mutableProfile,
    });
    mutableProfile.disabledFeatures = ["messages"];
    original.coverage = "partial";
    original.invoke = vi.fn(async () => "replaced");
    input.executionEnabled = () => false;
    const params = { nested: { text: "input" } };
    const result = await registry.invoke("messages", params);
    expect(result).toEqual(params);
    expect(result).not.toBe(params);
    expect(original.invoke).not.toHaveBeenCalled();
  });

  it("keeps assumed MRTR authority explicit after prototype opt-in", async () => {
    const assumed = setup(["forms"], {
      profile: { ...profile, transport: "mrtr" },
    });
    expect(assumed.registry.decision("forms")).toMatchObject({
      status: "degraded",
      allowed: false,
      authority: "assumed",
    });
    expect(assumed.registry.clientCapabilities()).toEqual({});
    const optedIn = setup(["forms"], {
      profile: { ...profile, transport: "mrtr", allowAssumedMrtrForms: true },
    });
    expect(optedIn.registry.decision("forms")).toMatchObject({
      status: "supported",
      allowed: true,
      authority: "assumed",
    });
    await optedIn.registry.invoke("forms", {});
  });

  it("permits replay and cleanup with execution disabled, without live ports", async () => {
    const { registry } = setup(["replay", "cleanup"], {
      profile: { ...profile, mode: "replay", disabledFeatures: ["cleanup"] },
      executionEnabled: () => {
        throw new Error("must not consult execution authority");
      },
      services: {
        "recording-read": { available: () => true },
        "inert-render": { available: () => true },
        release: { available: () => true },
      },
    });
    expect(
      registry.hostCapabilities({ experimental: { "openai/message": {} } })
    ).toEqual({});
    expect(registry.decision("messages")).toMatchObject({
      reason: "REPLAY_INERT",
    });
    await registry.invoke("replay", { recordingId: "recording" });
    await registry.invoke("cleanup", {});
    expect(() =>
      setup(["messages"], { profile: { ...profile, mode: "replay" } })
    ).toThrow("REPLAY_LIVE_BINDING");
    expect(() =>
      setup([], {
        profile: { ...profile, mode: "replay" },
        services: { "authorized-invocation": { available: vi.fn() } },
      })
    ).toThrow("REPLAY_LIVE_SERVICE");
  });

  it.each(["__proto__", "constructor", "future-feature"])(
    "rejects unknown feature %s without inherited handlers",
    async (feature) => {
      const { registry } = setup([]);
      expect(registry.decision(feature)).toMatchObject({
        status: "unsupported",
        reason: "UNKNOWN_PLUGIN_FEATURE",
      });
      await expect(registry.invoke(feature, {})).rejects.toBeInstanceOf(
        PluginCapabilityError
      );
    }
  );
});
