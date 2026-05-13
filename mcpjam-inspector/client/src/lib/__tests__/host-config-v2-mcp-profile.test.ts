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
  resolveClientInfo,
  resolveOpenAiCompatEnabled,
  resolveSupportedProtocolVersions,
} from "../host-config-v2";

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
        deny: { connectDomains: ["evil.com"] },
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
              deny: { connectDomains: ["evil.com"] },
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

describe("resolveOpenAiCompatEnabled (Stage 2 tri-state resolver)", () => {
  // The four-consumer single source of truth (server inject, advertise,
  // banner, handler gating). These tests pin the resolution order
  // (explicit > hostStyle default > false) so the four call sites can
  // never drift.

  test("returns the explicit value when the persisted record sets it", () => {
    expect(
      resolveOpenAiCompatEnabled({
        mcpProfile: {
          profileVersion: 1,
          apps: { compat: { openai: { enabled: true } } },
        },
        hostStyle: "claude",
      }),
    ).toBe(true);
    expect(
      resolveOpenAiCompatEnabled({
        mcpProfile: {
          profileVersion: 1,
          apps: { compat: { openai: { enabled: false } } },
        },
        // Explicit false MUST win over chatgpt's default true. This is the
        // editor's "opt out on a ChatGPT-themed profile" path.
        hostStyle: "chatgpt",
      }),
    ).toBe(false);
  });

  test("falls back to hostStyle default when no explicit value is set", () => {
    // ChatGPT-family host: default true.
    expect(
      resolveOpenAiCompatEnabled({
        mcpProfile: undefined,
        hostStyle: "chatgpt",
      }),
    ).toBe(true);
    // Other hosts: default false.
    expect(
      resolveOpenAiCompatEnabled({
        mcpProfile: undefined,
        hostStyle: "claude",
      }),
    ).toBe(false);
  });

  test("treats a partial profile envelope as 'no explicit value'", () => {
    // A user who set clientInfo but not the compat field must still
    // resolve to the hostStyle default — the resolver must not interpret
    // 'profileVersion: 1' as an opt-in or opt-out signal.
    expect(
      resolveOpenAiCompatEnabled({
        mcpProfile: { profileVersion: 1 },
        hostStyle: "chatgpt",
      }),
    ).toBe(true);
    expect(
      resolveOpenAiCompatEnabled({
        mcpProfile: {
          profileVersion: 1,
          initialize: { clientInfo: { name: "x", version: "1" } },
        },
        hostStyle: "claude",
      }),
    ).toBe(false);
  });

  test("custom hostStyle ids default to false (HostStyleDefinition is not extended)", () => {
    // Hard constraint #3: apps.compat.openai.enabled lives in the
    // persisted mcpProfile, NOT on HostStyleDefinition. Custom hosts
    // registered via registerHostStyle therefore default to false until
    // their persisted profile opts in explicitly.
    expect(
      resolveOpenAiCompatEnabled({
        mcpProfile: undefined,
        hostStyle: "some-custom-host" as never,
      }),
    ).toBe(false);
  });
});
