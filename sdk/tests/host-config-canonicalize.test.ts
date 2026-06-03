import {
  canonicalizeHostConfigV2,
  computeHostConfigHashV2,
} from "../src/host-config/internal";
import type { HostConfigInputV2 } from "../src/host-config/internal";

function base(overrides: Partial<HostConfigInputV2> = {}): HostConfigInputV2 {
  return {
    hostStyle: "claude",
    modelId: "anthropic/claude-sonnet-4-6",
    systemPrompt: "You are a helpful assistant.",
    temperature: 0.7,
    requireToolApproval: false,
    connectionDefaults: { headers: {}, requestTimeout: 10000 },
    clientCapabilities: {},
    hostContext: {},
    ...overrides,
  };
}

const hash = (input: HostConfigInputV2) => computeHostConfigHashV2(input);

describe("canonicalizeHostConfigV2 — hash stability", () => {
  it("is independent of TOP-LEVEL header / capability key order (shallow sort)", async () => {
    // connectionDefaults.headers, clientCapabilities and hostContext use a
    // SHALLOW key sort — top-level order is normalized, nested order is NOT
    // (matches the backend; only *Override + mcpProfile deep-sort).
    const a = base({
      connectionDefaults: { headers: { a: "1", b: "2" }, requestTimeout: 1 },
      clientCapabilities: { x: 1, y: 3 },
    });
    const b = base({
      connectionDefaults: { headers: { b: "2", a: "1" }, requestTimeout: 1 },
      clientCapabilities: { y: 3, x: 1 },
    });
    expect(await hash(a)).toBe(await hash(b));
  });

  it("deep-sorts hostCapabilitiesOverride (nested order-independent)", async () => {
    const a = base({ hostCapabilitiesOverride: { x: { p: 1, q: 2 }, y: 3 } });
    const b = base({ hostCapabilitiesOverride: { y: 3, x: { q: 2, p: 1 } } });
    expect(await hash(a)).toBe(await hash(b));
  });

  it("normalizes undefined serverIds to [] (same hash as explicit empty)", async () => {
    expect(await hash(base())).toBe(
      await hash(base({ serverIds: [], optionalServerIds: [] })),
    );
  });

  it("sorts serverIds deterministically", () => {
    const c = canonicalizeHostConfigV2(
      base({ serverIds: ["c", "a", "b"] as string[] }),
    );
    expect(c.serverIds).toEqual(["a", "b", "c"]);
  });
});

describe("canonicalizeHostConfigV2 — undefined vs explicit", () => {
  it("distinguishes hostCapabilitiesOverride undefined from {}", async () => {
    const omitted = canonicalizeHostConfigV2(base());
    expect("hostCapabilitiesOverride" in JSON.parse(JSON.stringify(omitted))).toBe(
      false,
    );
    expect(await hash(base())).not.toBe(
      await hash(base({ hostCapabilitiesOverride: {} })),
    );
  });

  it("distinguishes progressiveToolDiscovery undefined from false", async () => {
    expect(await hash(base())).not.toBe(
      await hash(base({ progressiveToolDiscovery: false })),
    );
  });
});

describe("canonicalizeHostConfigV2 — validation", () => {
  it("throws on non-finite temperature", () => {
    expect(() => canonicalizeHostConfigV2(base({ temperature: NaN }))).toThrow(
      /temperature must be finite/,
    );
  });

  it("rejects an unknown mcpAppsOverrides key (typo defense)", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({
          mcpProfile: {
            profileVersion: 1,
            apps: { mcpAppsOverrides: { toolCanceled: true } as never },
          },
        }),
      ),
    ).toThrow(/unknown key "toolCanceled"/);
  });

  it("rejects a serverConnectionOverrides key not in serverIds", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({
          serverIds: ["a"] as string[],
          serverConnectionOverrides: { b: { requestTimeoutOverride: 1 } },
        }),
      ),
    ).toThrow(/not in serverIds or optionalServerIds/);
  });

  it("requires mcpProfile.profileVersion === 1", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({ mcpProfile: { profileVersion: 2 } as never }),
      ),
    ).toThrow(/profileVersion must be 1/);
  });

  it("rejects an empty availableDisplayModes array", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({
          mcpProfile: {
            profileVersion: 1,
            apps: { mcpAppsOverrides: { availableDisplayModes: [] } },
          },
        }),
      ),
    ).toThrow(/must contain at least one mode/);
  });

  it("drops spec permission features from allowFeatures and blocks injection", () => {
    const c = canonicalizeHostConfigV2(
      base({
        mcpProfile: {
          profileVersion: 1,
          apps: {
            sandbox: { allowFeatures: { camera: "*", fullscreen: "'self'" } },
          },
        },
      }),
    );
    const allowFeatures = c.mcpProfile?.apps?.sandbox?.allowFeatures ?? {};
    expect("camera" in allowFeatures).toBe(false);
    expect(allowFeatures.fullscreen).toBe("'self'");

    expect(() =>
      canonicalizeHostConfigV2(
        base({
          mcpProfile: {
            profileVersion: 1,
            apps: { sandbox: { allowFeatures: { fullscreen: "*; camera *" } } },
          },
        }),
      ),
    ).toThrow(/must not contain ';' or ','/);
  });
});

describe("canonicalizeHostConfigV2 — mcpProfile derivation", () => {
  it("derives supportedProtocolVersions for a stateful pin", () => {
    const c = canonicalizeHostConfigV2(
      base({
        mcpProfile: { profileVersion: 1, mcpProtocolVersion: "2025-06-18" },
      }),
    );
    expect(c.mcpProfile?.initialize?.supportedProtocolVersions).toEqual([
      "2025-06-18",
    ]);
  });

  it("does not derive for a stateless pin", () => {
    const c = canonicalizeHostConfigV2(
      base({
        mcpProfile: { profileVersion: 1, mcpProtocolVersion: "2026-07-28" },
      }),
    );
    expect(c.mcpProfile?.initialize).toBeUndefined();
  });

  it("throws ConflictingProtocolVersionPin when pin not advertised", () => {
    expect(() =>
      canonicalizeHostConfigV2(
        base({
          mcpProfile: {
            profileVersion: 1,
            mcpProtocolVersion: "2025-06-18",
            initialize: { supportedProtocolVersions: ["2025-11-25"] },
          },
        }),
      ),
    ).toThrow(/ConflictingProtocolVersionPin/);
  });
});
