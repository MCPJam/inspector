/**
 * Unit tests for the mcpProfile-specific paths in `host-config-v2.ts`.
 *
 * These are pure-logic tests (no React, no Convex) covering the contracts
 * the rest of the inspector PR depends on:
 *
 *   - `resolveClientInfo` / `resolveSupportedProtocolVersions` preserve
 *     `undefined` (the "SDK defaults" sentinel) — pinning these wrong
 *     would silently override the SDK fallback path.
 *   - `emptyHostConfigInputV2` and `hostConfigDtoToInput` round-trip
 *     `mcpProfile` faithfully and DO NOT synthesize `{ profileVersion: 1 }`
 *     when the input is `undefined`. The backend hashes the two states
 *     distinctly (PR #269 byte-identical-hash test) so synthesizing the
 *     envelope would defeat the "user opted in" signal.
 *   - `hostConfigInputsEqual` reports a dirty edit when `mcpProfile`
 *     flips between `undefined` and `{ profileVersion: 1 }`.
 */

import { describe, expect, test } from "vitest";
import {
  type HostConfigDtoV2,
  type HostConfigInputV2,
  type HostConfigMcpProfileV1,
  emptyHostConfigInputV2,
  hostConfigDtoToInput,
  hostConfigInputsEqual,
  mergeOpenAiAppsCapabilities,
  resolveClientInfo,
  resolveEffectiveCompatRuntime,
  resolveEffectiveMcpProtocolVersion,
  resolveSupportedProtocolVersions,
} from "../client-config-v2";
import {
  OPENAI_APPS_COPILOT_SURFACE,
  OPENAI_APPS_FULL_SURFACE,
} from "@/lib/client-styles";

const SAMPLE_PROFILE: HostConfigMcpProfileV1 = {
  profileVersion: 1,
  initialize: {
    clientInfo: { name: "chatgpt", version: "1.0.0", title: "ChatGPT" },
    supportedProtocolVersions: ["2025-11-25", "2025-06-18"],
  },
  apps: {
    sandbox: {
      csp: {
        mode: "declared",
        restrictTo: { connectDomains: ["api.openai.com"] },
      },
    },
  },
};

const BASE_DTO: HostConfigDtoV2 = {
  id: "fakeid",
  schemaVersion: 2,
  hostStyle: "claude",
  modelId: "claude-sonnet-4-5",
  systemPrompt: "",
  temperature: 0.7,
  requireToolApproval: false,
  serverIds: [],
  optionalServerIds: [],
  connectionDefaults: { headers: {}, requestTimeout: 10_000 },
  clientCapabilities: {},
  hostContext: {},
};

describe("resolveClientInfo", () => {
  test("returns undefined when profile is undefined (SDK-default sentinel)", () => {
    expect(resolveClientInfo(undefined)).toBeUndefined();
  });

  test("returns undefined when initialize.clientInfo is unset (even with profile present)", () => {
    expect(
      resolveClientInfo({ profileVersion: 1 }),
    ).toBeUndefined();
    expect(
      resolveClientInfo({
        profileVersion: 1,
        initialize: { supportedProtocolVersions: ["2025-11-25"] },
      }),
    ).toBeUndefined();
  });

  test("returns the clientInfo object verbatim when set", () => {
    const ci = resolveClientInfo(SAMPLE_PROFILE);
    expect(ci).toEqual({
      name: "chatgpt",
      version: "1.0.0",
      title: "ChatGPT",
    });
  });

  test("preserves extra (future-spec) fields verbatim", () => {
    const profile: HostConfigMcpProfileV1 = {
      profileVersion: 1,
      initialize: {
        clientInfo: {
          name: "x",
          version: "1",
          // Hypothetical future field — must round-trip without an SDK bump.
          futureSpecField: { nested: true },
        },
      },
    };
    expect(resolveClientInfo(profile)).toEqual({
      name: "x",
      version: "1",
      futureSpecField: { nested: true },
    });
  });
});

describe("resolveSupportedProtocolVersions", () => {
  test("returns undefined when profile is undefined", () => {
    expect(resolveSupportedProtocolVersions(undefined)).toBeUndefined();
  });

  test("returns the array verbatim — first entry is the proposed version", () => {
    const versions = resolveSupportedProtocolVersions(SAMPLE_PROFILE);
    expect(versions).toEqual(["2025-11-25", "2025-06-18"]);
    expect(versions?.[0]).toBe("2025-11-25");
  });

  test("preserves order — order is semantic for protocol negotiation", () => {
    const reversed = resolveSupportedProtocolVersions({
      profileVersion: 1,
      initialize: { supportedProtocolVersions: ["2025-06-18", "2025-11-25"] },
    });
    expect(reversed).toEqual(["2025-06-18", "2025-11-25"]);
    // Different first entry → different proposed version on the wire.
    expect(reversed?.[0]).not.toBe("2025-11-25");
  });
});

describe("emptyHostConfigInputV2 mcpProfile handling", () => {
  test("seeds with mcpProfile undefined when partial is empty", () => {
    // The inspector MUST NOT synthesize `{ profileVersion: 1 }` here —
    // the backend hashes `undefined` and `{ profileVersion: 1 }`
    // distinctly. Synthesizing would silently opt every brand-new
    // chatbox/project into an empty envelope and defeat the
    // "user opted in" signal that PR #269 preserves on the wire.
    const input = emptyHostConfigInputV2();
    expect(input.mcpProfile).toBeUndefined();
  });

  test("clones the mcpProfile when supplied (no aliasing)", () => {
    // Deep-clone SAMPLE_PROFILE so the mutation below doesn't leak into
    // the module-level fixture and break later tests in this file.
    // (Hit this exact bug during initial test writing — shared mutable
    // fixtures + an aliasing assertion is a foot-gun.)
    const source = JSON.parse(
      JSON.stringify(SAMPLE_PROFILE),
    ) as HostConfigMcpProfileV1;
    const partial: Partial<HostConfigInputV2> = { mcpProfile: source };
    const input = emptyHostConfigInputV2(partial);
    expect(input.mcpProfile).toEqual(SAMPLE_PROFILE);
    // Mutate the source — input must be unaffected.
    (source.initialize!.clientInfo as Record<string, unknown>).name =
      "mutated";
    expect(input.mcpProfile?.initialize?.clientInfo?.name).toBe("chatgpt");
  });
});

describe("hostConfigDtoToInput mcpProfile round-trip", () => {
  test("DTO without mcpProfile → input without mcpProfile", () => {
    const input = hostConfigDtoToInput(BASE_DTO);
    expect(input.mcpProfile).toBeUndefined();
  });

  test("DTO with mcpProfile → input with cloned mcpProfile", () => {
    // Same aliasing-test trap — deep-clone the fixture before mutation.
    const sourceProfile = JSON.parse(
      JSON.stringify(SAMPLE_PROFILE),
    ) as HostConfigMcpProfileV1;
    const dto = { ...BASE_DTO, mcpProfile: sourceProfile };
    const input = hostConfigDtoToInput(dto);
    expect(input.mcpProfile).toEqual(SAMPLE_PROFILE);
    (sourceProfile.initialize!.clientInfo as Record<string, unknown>).version =
      "mutated";
    expect(input.mcpProfile?.initialize?.clientInfo?.version).toBe("1.0.0");
  });

  test("empty envelope `{ profileVersion: 1 }` round-trips as-is (NOT collapsed to undefined)", () => {
    // The "user opted in but configured nothing" state — distinct hash on
    // backend, must survive a load → save cycle without normalization.
    const dto: HostConfigDtoV2 = {
      ...BASE_DTO,
      mcpProfile: { profileVersion: 1 },
    };
    const input = hostConfigDtoToInput(dto);
    expect(input.mcpProfile).toEqual({ profileVersion: 1 });
  });
});

describe("hostConfigInputsEqual mcpProfile semantics", () => {
  test("two inputs with mcpProfile undefined compare equal", () => {
    const a = emptyHostConfigInputV2();
    const b = emptyHostConfigInputV2();
    expect(hostConfigInputsEqual(a, b)).toBe(true);
  });

  test("flipping mcpProfile from undefined → empty envelope reports DIRTY", () => {
    // The inspector relies on this: when a user clicks "Enable" in the
    // editor (which stamps `{ profileVersion: 1 }`), the editor's dirty
    // indicator MUST light up even though no inner field has changed.
    const a = emptyHostConfigInputV2();
    const b: HostConfigInputV2 = {
      ...a,
      mcpProfile: { profileVersion: 1 },
    };
    expect(hostConfigInputsEqual(a, b)).toBe(false);
  });

  test("two inputs with same mcpProfile (key-order independent) compare equal", () => {
    const a: HostConfigInputV2 = {
      ...emptyHostConfigInputV2(),
      mcpProfile: SAMPLE_PROFILE,
    };
    // Build the same profile in a different key order.
    const b: HostConfigInputV2 = {
      ...emptyHostConfigInputV2(),
      mcpProfile: {
        initialize: {
          supportedProtocolVersions: ["2025-11-25", "2025-06-18"],
          clientInfo: { title: "ChatGPT", version: "1.0.0", name: "chatgpt" },
        },
        apps: {
          sandbox: {
            csp: {
              restrictTo: { connectDomains: ["api.openai.com"] },
              mode: "declared",
            },
          },
        },
        profileVersion: 1,
      },
    };
    expect(hostConfigInputsEqual(a, b)).toBe(true);
  });

  test("a single clientInfo field change reports DIRTY", () => {
    const a: HostConfigInputV2 = {
      ...emptyHostConfigInputV2(),
      mcpProfile: SAMPLE_PROFILE,
    };
    const b: HostConfigInputV2 = {
      ...emptyHostConfigInputV2(),
      mcpProfile: {
        ...SAMPLE_PROFILE,
        initialize: {
          ...SAMPLE_PROFILE.initialize,
          clientInfo: {
            ...SAMPLE_PROFILE.initialize!.clientInfo,
            version: "9.9.9",
          },
        },
      },
    };
    expect(hostConfigInputsEqual(a, b)).toBe(false);
  });

  test("supportedProtocolVersions ORDER change reports DIRTY (order is semantic)", () => {
    const a: HostConfigInputV2 = {
      ...emptyHostConfigInputV2(),
      mcpProfile: {
        profileVersion: 1,
        initialize: { supportedProtocolVersions: ["a", "b"] },
      },
    };
    const b: HostConfigInputV2 = {
      ...emptyHostConfigInputV2(),
      mcpProfile: {
        profileVersion: 1,
        initialize: { supportedProtocolVersions: ["b", "a"] },
      },
    };
    expect(hostConfigInputsEqual(a, b)).toBe(false);
  });
});

describe("resolveEffectiveCompatRuntime — per-method capability matrix", () => {
  test('host style with `compatRuntime.openaiApps: false` resolves to `{ injected: false }` regardless of overrides', () => {
    // Claude doesn't inject the shim. Per-method overrides without
    // injection are meaningless — the resolver must short-circuit.
    const result = resolveEffectiveCompatRuntime({
      profile: {
        profileVersion: 1,
        apps: {
          compatRuntime: {
            // Explicit user override flipping injection off.
            openaiApps: false,
            // Stale per-method overrides from a previous "on" state.
            openaiAppsOverrides: { requestModal: true },
          },
        },
      },
      hostStyle: "chatgpt",
    });
    expect(result).toEqual({ injected: false });
  });

  test("preset injection on, no overrides → preset capabilities verbatim", () => {
    const result = resolveEffectiveCompatRuntime({
      profile: undefined,
      hostStyle: "copilot",
    });
    // Copilot's preset = the published Copilot surface (fullscreen-only
    // displayMode, requestModal off, etc.).
    expect(result).toEqual({
      injected: true,
      capabilities: OPENAI_APPS_COPILOT_SURFACE,
    });
  });

  test("sparse overrides merge field-by-field over preset", () => {
    const result = resolveEffectiveCompatRuntime({
      profile: {
        profileVersion: 1,
        apps: {
          compatRuntime: {
            openaiAppsOverrides: {
              // Override one field; everything else should fall back
              // to the chatgpt preset (full surface).
              requestModal: false,
            },
          },
        },
      },
      hostStyle: "chatgpt",
    });
    expect(result.injected).toBe(true);
    if (!result.injected) throw new Error("unreachable");
    expect(result.capabilities.requestModal).toBe(false);
    // Untouched fields stay at the preset value.
    expect(result.capabilities.callTool).toBe(true);
    expect(result.capabilities.requestDisplayMode).toBe("all");
  });

  test("user flipping injection on for a Claude-style host → full ChatGPT surface", () => {
    // Claude's preset has no per-method `openaiAppsCapabilities` (the
    // preset doesn't inject the shim at all). If the user explicitly
    // turns injection on, the resolver must pick the full ChatGPT
    // surface as the baseline — anything sparser would have weird
    // undefined-method semantics.
    const result = resolveEffectiveCompatRuntime({
      profile: {
        profileVersion: 1,
        apps: { compatRuntime: { openaiApps: true } },
      },
      hostStyle: "claude",
    });
    expect(result).toEqual({
      injected: true,
      capabilities: OPENAI_APPS_FULL_SURFACE,
    });
  });

  test("requestDisplayMode override survives merge as the tri-state value", () => {
    const result = resolveEffectiveCompatRuntime({
      profile: {
        profileVersion: 1,
        apps: {
          compatRuntime: {
            openaiAppsOverrides: { requestDisplayMode: "fullscreen-only" },
          },
        },
      },
      // chatgpt's preset uses "all" — override flips it to fullscreen-only.
      hostStyle: "chatgpt",
    });
    expect(result.injected).toBe(true);
    if (!result.injected) throw new Error("unreachable");
    expect(result.capabilities.requestDisplayMode).toBe("fullscreen-only");
  });

  test("mergeOpenAiAppsCapabilities — undefined override returns baseline unchanged", () => {
    const baseline = OPENAI_APPS_FULL_SURFACE;
    const merged = mergeOpenAiAppsCapabilities(baseline, undefined);
    expect(merged).toEqual(baseline);
  });
});

// Regression tests for the per-server protocol-version override flow.
// `resolveEffectiveMcpProtocolVersion` is the actual resolution helper
// `buildResolverConnectionDefaults` calls in `use-server-state.ts`. If
// these break, per-server pins silently revert to the host default —
// the bug reported on PR #2257 review (override looks saved in the UI
// but the runtime always uses the host default).
describe("resolveEffectiveMcpProtocolVersion — per-server override precedence", () => {
  test("server override wins over host default", () => {
    expect(
      resolveEffectiveMcpProtocolVersion("2026-07-28", "2025-11-25"),
    ).toBe("2026-07-28");
  });

  test("host default applies when no server override", () => {
    expect(resolveEffectiveMcpProtocolVersion(undefined, "2025-11-25")).toBe(
      "2025-11-25",
    );
  });

  test("returns undefined when neither layer has an opinion (SDK default semantics)", () => {
    expect(resolveEffectiveMcpProtocolVersion(undefined, undefined)).toBe(
      undefined,
    );
  });

  test("stateful server override wins over stateless host default", () => {
    // Symmetric scenario: host pinned to 2026-07-28 globally for a
    // migration test, one legacy server overridden back to 2025-11-25.
    // The override must reach the connect path or the legacy server
    // will fail with -32004.
    expect(
      resolveEffectiveMcpProtocolVersion("2025-11-25", "2026-07-28"),
    ).toBe("2025-11-25");
  });
});
