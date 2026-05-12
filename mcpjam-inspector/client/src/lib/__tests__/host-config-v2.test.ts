import { describe, expect, it } from "vitest";
import {
  emptyHostConfigInputV2,
  hostConfigDtoToInput,
  hostConfigInputsEqual,
  resolveClientInfo,
  resolveEffectiveHostCapabilities,
  resolveSupportedProtocolVersions,
  type HostConfigDtoV2,
  type HostConfigInputV2,
  type HostConfigMcpProfileV1,
} from "../host-config-v2";

function makeInput(overrides: Partial<HostConfigInputV2> = {}): HostConfigInputV2 {
  return emptyHostConfigInputV2({
    hostStyle: "claude",
    modelId: "claude-sonnet-4-5",
    systemPrompt: "you are helpful",
    temperature: 0.5,
    requireToolApproval: false,
    serverIds: [],
    optionalServerIds: [],
    connectionDefaults: { headers: { "X-A": "1" }, requestTimeout: 10000 },
    clientCapabilities: {},
    hostContext: {},
    ...overrides,
  });
}

describe("hostConfigInputsEqual", () => {
  it("returns true for identical inputs", () => {
    expect(hostConfigInputsEqual(makeInput(), makeInput())).toBe(true);
  });

  it("returns false when modelId differs", () => {
    expect(
      hostConfigInputsEqual(
        makeInput({ modelId: "a" }),
        makeInput({ modelId: "b" }),
      ),
    ).toBe(false);
  });

  it("ignores serverIds order", () => {
    const a = makeInput({ serverIds: ["s1", "s2", "s3"] });
    const b = makeInput({ serverIds: ["s3", "s1", "s2"] });
    expect(hostConfigInputsEqual(a, b)).toBe(true);
  });

  it("ignores nested object key order in clientCapabilities", () => {
    const a = makeInput({
      clientCapabilities: { caps: { a: 1, b: 2 } } as Record<string, unknown>,
    });
    const b = makeInput({
      clientCapabilities: { caps: { b: 2, a: 1 } } as Record<string, unknown>,
    });
    expect(hostConfigInputsEqual(a, b)).toBe(true);
  });

  it("ignores nested object key order in hostContext", () => {
    const a = makeInput({
      hostContext: { ctx: { x: "1", y: "2" } } as Record<string, unknown>,
    });
    const b = makeInput({
      hostContext: { ctx: { y: "2", x: "1" } } as Record<string, unknown>,
    });
    expect(hostConfigInputsEqual(a, b)).toBe(true);
  });

  it("detects nested value changes", () => {
    const a = makeInput({
      clientCapabilities: { caps: { a: 1 } } as Record<string, unknown>,
    });
    const b = makeInput({
      clientCapabilities: { caps: { a: 2 } } as Record<string, unknown>,
    });
    expect(hostConfigInputsEqual(a, b)).toBe(false);
  });

  it("treats optionalServerIds order-insensitively", () => {
    const a = makeInput({ optionalServerIds: ["x", "y"] });
    const b = makeInput({ optionalServerIds: ["y", "x"] });
    expect(hostConfigInputsEqual(a, b)).toBe(true);
  });

  it("returns false when connectionDefaults.requestTimeout differs", () => {
    const a = makeInput({
      connectionDefaults: { headers: {}, requestTimeout: 5000 },
    });
    const b = makeInput({
      connectionDefaults: { headers: {}, requestTimeout: 5001 },
    });
    expect(hostConfigInputsEqual(a, b)).toBe(false);
  });

  it("treats two undefined hostCapabilitiesOverrides as equal", () => {
    expect(
      hostConfigInputsEqual(
        makeInput({ hostCapabilitiesOverride: undefined }),
        makeInput({ hostCapabilitiesOverride: undefined }),
      ),
    ).toBe(true);
  });

  it("distinguishes undefined from an empty {} override", () => {
    const a = makeInput({ hostCapabilitiesOverride: undefined });
    const b = makeInput({ hostCapabilitiesOverride: {} });
    expect(hostConfigInputsEqual(a, b)).toBe(false);
  });

  it("detects nested value changes in hostCapabilitiesOverride", () => {
    const a = makeInput({
      hostCapabilitiesOverride: { openLinks: {} } as Record<string, unknown>,
    });
    const b = makeInput({
      hostCapabilitiesOverride: {} as Record<string, unknown>,
    });
    expect(hostConfigInputsEqual(a, b)).toBe(false);
  });
});

describe("emptyHostConfigInputV2", () => {
  it("clones every caller-provided array/record (no aliasing)", () => {
    const seedServerIds = ["a", "b"];
    const seedHeaders = { Foo: "bar" };
    const seedCaps = { x: 1 } as Record<string, unknown>;
    const seedCtx = { y: 2 } as Record<string, unknown>;

    const result = emptyHostConfigInputV2({
      serverIds: seedServerIds,
      optionalServerIds: ["a"],
      connectionDefaults: { headers: seedHeaders, requestTimeout: 1234 },
      clientCapabilities: seedCaps,
      hostContext: seedCtx,
    });

    // mutate the result; seeds must not change.
    result.serverIds.push("c");
    result.optionalServerIds.push("c");
    result.connectionDefaults.headers["Other"] = "v";
    (result.clientCapabilities as Record<string, unknown>).z = 99;
    (result.hostContext as Record<string, unknown>).w = 99;

    expect(seedServerIds).toEqual(["a", "b"]);
    expect(seedHeaders).toEqual({ Foo: "bar" });
    expect(seedCaps).toEqual({ x: 1 });
    expect(seedCtx).toEqual({ y: 2 });
  });
});

describe("hostConfigDtoToInput", () => {
  it("clones every array/record so the dto cannot be mutated through the input", () => {
    const dto: HostConfigDtoV2 = {
      id: "host-1",
      schemaVersion: 2,
      hostStyle: "claude",
      modelId: "x",
      systemPrompt: "",
      temperature: 0.7,
      requireToolApproval: false,
      serverIds: ["s1"],
      optionalServerIds: ["o1"],
      connectionDefaults: { headers: { K: "V" }, requestTimeout: 10000 },
      clientCapabilities: { c: 1 } as Record<string, unknown>,
      hostContext: { h: 2 } as Record<string, unknown>,
    };
    const input = hostConfigDtoToInput(dto);

    input.serverIds.push("mutated");
    input.optionalServerIds.push("mutated");
    input.connectionDefaults.headers["Mutated"] = "yes";
    (input.clientCapabilities as Record<string, unknown>).new = 1;
    (input.hostContext as Record<string, unknown>).new = 1;

    expect(dto.serverIds).toEqual(["s1"]);
    expect(dto.optionalServerIds).toEqual(["o1"]);
    expect(dto.connectionDefaults.headers).toEqual({ K: "V" });
    expect(dto.clientCapabilities).toEqual({ c: 1 });
    expect(dto.hostContext).toEqual({ h: 2 });
  });

  it("deep-clones nested clientCapabilities and hostContext", () => {
    const dto: HostConfigDtoV2 = {
      id: "host-2",
      schemaVersion: 2,
      hostStyle: "claude",
      modelId: "x",
      systemPrompt: "",
      temperature: 0.7,
      requireToolApproval: false,
      serverIds: [],
      optionalServerIds: [],
      connectionDefaults: { headers: {}, requestTimeout: 10000 },
      clientCapabilities: {
        extensions: { mimeTypes: ["a", "b"] },
      } as Record<string, unknown>,
      hostContext: {
        nested: { deep: { value: 1 } },
      } as Record<string, unknown>,
    };
    const input = hostConfigDtoToInput(dto);

    // Mutate inside the nested trees and confirm the source DTO is
    // unaffected — proves the clone descends into nested structures.
    (
      (input.clientCapabilities.extensions as Record<string, unknown>)
        .mimeTypes as string[]
    ).push("c");
    (
      (
        (input.hostContext.nested as Record<string, unknown>).deep as Record<
          string,
          unknown
        >
      ) as { value: number }
    ).value = 999;

    expect(
      (dto.clientCapabilities.extensions as Record<string, unknown>).mimeTypes,
    ).toEqual(["a", "b"]);
    expect(
      (
        (dto.hostContext.nested as Record<string, unknown>).deep as Record<
          string,
          unknown
        >
      ),
    ).toEqual({ value: 1 });
  });

  it("deep-clones hostCapabilitiesOverride when present", () => {
    const dto: HostConfigDtoV2 = {
      id: "host-3",
      schemaVersion: 2,
      hostStyle: "claude",
      modelId: "x",
      systemPrompt: "",
      temperature: 0.7,
      requireToolApproval: false,
      serverIds: [],
      optionalServerIds: [],
      connectionDefaults: { headers: {}, requestTimeout: 10000 },
      clientCapabilities: {},
      hostContext: {},
      hostCapabilitiesOverride: {
        serverTools: { listChanged: true },
      } as Record<string, unknown>,
    };
    const input = hostConfigDtoToInput(dto);
    (input.hostCapabilitiesOverride!.serverTools as Record<string, unknown>)
      .listChanged = false;

    expect(
      (dto.hostCapabilitiesOverride!.serverTools as Record<string, unknown>)
        .listChanged,
    ).toBe(true);
  });

  it("leaves hostCapabilitiesOverride undefined when the dto omits it", () => {
    const dto: HostConfigDtoV2 = {
      id: "host-4",
      schemaVersion: 2,
      hostStyle: "claude",
      modelId: "x",
      systemPrompt: "",
      temperature: 0.7,
      requireToolApproval: false,
      serverIds: [],
      optionalServerIds: [],
      connectionDefaults: { headers: {}, requestTimeout: 10000 },
      clientCapabilities: {},
      hostContext: {},
    };
    const input = hostConfigDtoToInput(dto);
    expect(input.hostCapabilitiesOverride).toBeUndefined();
  });
});

describe("resolveEffectiveHostCapabilities", () => {
  it("strips sandbox from the override before returning", () => {
    // SEP-1865: sandbox is approved per UI resource at runtime, not a
    // vendor trait. If a user pastes sandbox into the JSON editor, it
    // MUST NOT leak into the advertised hostCapabilities blob.
    const resolved = resolveEffectiveHostCapabilities({
      hostStyle: "claude",
      hostCapabilitiesOverride: {
        serverTools: { listChanged: true },
        sandbox: { permissions: { camera: {} } },
      },
    });
    expect(resolved).not.toHaveProperty("sandbox");
    // Sibling fields survive — sandbox stripping must be surgical.
    expect(resolved).toEqual({ serverTools: { listChanged: true } });
  });

  it("returns an empty {} override as 'advertise nothing' (not preset)", () => {
    // The override is explicitly the empty object — must hash distinctly
    // from undefined (which would fall through to the host style preset).
    const resolved = resolveEffectiveHostCapabilities({
      hostStyle: "claude",
      hostCapabilitiesOverride: {},
    });
    expect(resolved).toEqual({});
  });

  it("falls back to the host style preset when no override is set", () => {
    const resolved = resolveEffectiveHostCapabilities({
      hostStyle: "claude",
      hostCapabilitiesOverride: undefined,
    });
    // Claude preset advertises message; sentinel that we picked the
    // preset rather than the spec-default {}.
    expect(resolved).toHaveProperty("message");
  });
});

describe("resolveClientInfo", () => {
  it("returns undefined when the profile is unset (SDK-default sentinel)", () => {
    expect(resolveClientInfo(undefined)).toBeUndefined();
  });

  it("returns undefined when the profile has no initialize.clientInfo", () => {
    // Even an opted-in profile (`profileVersion: 1` present, all
    // subfields undefined) must produce SDK-default sentinel here.
    // Substituting a synthetic `{}` would silently make every
    // upstream `initialize` advertise the wrong identity.
    expect(resolveClientInfo({ profileVersion: 1 })).toBeUndefined();
    expect(
      resolveClientInfo({ profileVersion: 1, initialize: {} }),
    ).toBeUndefined();
  });

  it("returns the clientInfo object verbatim when set", () => {
    const profile: HostConfigMcpProfileV1 = {
      profileVersion: 1,
      initialize: {
        clientInfo: { name: "chatgpt", version: "1.0", title: "ChatGPT" },
      },
    };
    expect(resolveClientInfo(profile)).toEqual({
      name: "chatgpt",
      version: "1.0",
      title: "ChatGPT",
    });
  });

  it("returns a copy (not a reference) so callers can't mutate stored state", () => {
    // Symmetric with the resolveSupportedProtocolVersions
    // defensive-copy test. Step 3 wiring will hand this object to
    // `new Client(clientInfo, ...)`, where the SDK may
    // freeze/augment what it receives — a shared reference would
    // mean a downstream tweak silently mutates the persisted
    // profile state.
    const profile: HostConfigMcpProfileV1 = {
      profileVersion: 1,
      initialize: {
        clientInfo: { name: "chatgpt", version: "1.0" },
      },
    };
    const resolved = resolveClientInfo(profile)!;
    (resolved as Record<string, unknown>).extraField = "hacked";
    // Original profile must be untouched.
    expect(profile.initialize!.clientInfo).toEqual({
      name: "chatgpt",
      version: "1.0",
    });
  });
});

describe("resolveSupportedProtocolVersions", () => {
  it("returns undefined when the profile is unset", () => {
    expect(resolveSupportedProtocolVersions(undefined)).toBeUndefined();
  });

  it("returns undefined when initialize.supportedProtocolVersions is absent", () => {
    expect(
      resolveSupportedProtocolVersions({ profileVersion: 1 }),
    ).toBeUndefined();
  });

  it("returns the version list verbatim (order matters)", () => {
    // First entry is proposed in initialize.params.protocolVersion;
    // remaining entries form the accept-list. Order is semantic —
    // resolveSupportedProtocolVersions must NOT sort or dedupe.
    const versions = ["2025-11-25", "2025-06-18"];
    expect(
      resolveSupportedProtocolVersions({
        profileVersion: 1,
        initialize: { supportedProtocolVersions: versions },
      }),
    ).toEqual(versions);
  });

  it("returns a copy (not a reference) so callers can't mutate stored state", () => {
    const versions = ["2025-11-25", "2025-06-18"];
    const profile: HostConfigMcpProfileV1 = {
      profileVersion: 1,
      initialize: { supportedProtocolVersions: versions },
    };
    const resolved = resolveSupportedProtocolVersions(profile)!;
    resolved.push("hacked");
    // Original profile must be untouched.
    expect(profile.initialize!.supportedProtocolVersions).toEqual([
      "2025-11-25",
      "2025-06-18",
    ]);
  });

  it("returns undefined for explicit empty array (defensive)", () => {
    // The backend canonicalizer rejects empty arrays at write time
    // (PR #269 P2 fix), but if a malformed payload reaches the
    // client, the resolver MUST treat it as "use SDK defaults"
    // rather than handing the SDK a zero-length accept-list and
    // breaking initialize negotiation.
    expect(
      resolveSupportedProtocolVersions({
        profileVersion: 1,
        initialize: { supportedProtocolVersions: [] },
      }),
    ).toBeUndefined();
  });
});

describe("emptyHostConfigInputV2 + hostConfigDtoToInput — mcpProfile preservation", () => {
  it("preserves `mcpProfile: undefined` round-trip (NEVER synthesizes a default envelope)", () => {
    // The single most important invariant on the inspector side: a
    // DTO with `mcpProfile: undefined` must produce a save payload
    // with `mcpProfile: undefined`. The backend treats undefined /
    // `{ profileVersion: 1 }` / `{}` as three distinct canonical
    // hashes — synthesizing any default here would silently churn
    // the persisted hostConfig row's _id on every editor open.
    const empty = emptyHostConfigInputV2({});
    expect(empty.mcpProfile).toBeUndefined();
    // JSON.stringify must NOT include the key — that's what the
    // backend canonicalizer relies on to dedupe absent-vs-set hashes.
    expect(JSON.parse(JSON.stringify(empty))).not.toHaveProperty(
      "mcpProfile",
    );
  });

  it("preserves a populated mcpProfile verbatim through DTO → input → save round-trip", () => {
    const profile: HostConfigMcpProfileV1 = {
      profileVersion: 1,
      initialize: {
        clientInfo: { name: "chatgpt", version: "1.0" },
        supportedProtocolVersions: ["2025-11-25"],
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
    const dto: HostConfigDtoV2 = {
      id: "hc_1",
      schemaVersion: 2,
      hostStyle: "claude",
      modelId: "x",
      systemPrompt: "",
      temperature: 0.7,
      requireToolApproval: false,
      serverIds: [],
      optionalServerIds: [],
      connectionDefaults: { headers: {}, requestTimeout: 10_000 },
      clientCapabilities: {},
      hostContext: {},
      mcpProfile: profile,
    };
    const input = hostConfigDtoToInput(dto);
    expect(input.mcpProfile).toEqual(profile);
    // Deep clone — not the same reference (caller mutations don't
    // leak into the source DTO).
    expect(input.mcpProfile).not.toBe(profile);
    expect(input.mcpProfile?.apps?.sandbox?.csp).not.toBe(
      profile.apps?.sandbox?.csp,
    );
  });

  it("hostConfigInputsEqual returns true for identical mcpProfile + false on any difference", () => {
    const base = emptyHostConfigInputV2({
      hostStyle: "claude",
      modelId: "x",
      systemPrompt: "",
      temperature: 0.7,
      requireToolApproval: false,
      serverIds: [],
      optionalServerIds: [],
      connectionDefaults: { headers: {}, requestTimeout: 10_000 },
      clientCapabilities: {},
      hostContext: {},
      mcpProfile: {
        profileVersion: 1,
        initialize: {
          clientInfo: { name: "x", version: "1" },
          supportedProtocolVersions: ["2025-11-25", "2025-06-18"],
        },
      },
    });
    const same = emptyHostConfigInputV2({
      ...base,
      mcpProfile: base.mcpProfile,
    });
    expect(hostConfigInputsEqual(base, same)).toBe(true);

    // Order of supportedProtocolVersions is SEMANTIC (first entry is
    // proposed). Different orderings must compare as not-equal —
    // matches backend canonical hash divergence.
    const reordered = emptyHostConfigInputV2({
      ...base,
      mcpProfile: {
        profileVersion: 1,
        initialize: {
          clientInfo: { name: "x", version: "1" },
          supportedProtocolVersions: ["2025-06-18", "2025-11-25"],
        },
      },
    });
    expect(hostConfigInputsEqual(base, reordered)).toBe(false);
  });

  it("hostConfigInputsEqual treats CSP domain array order as a SET (matches backend canonicalization)", () => {
    // Backend canonicalizes CSP domain arrays as sets: trim, dedupe,
    // sort. The editor's dirty-detection MUST agree — otherwise a
    // cosmetic reorder shows up as dirty when the backend would
    // dedupe to the same canonical hash.
    const a = emptyHostConfigInputV2({
      hostStyle: "claude",
      modelId: "x",
      systemPrompt: "",
      temperature: 0.7,
      requireToolApproval: false,
      serverIds: [],
      optionalServerIds: [],
      connectionDefaults: { headers: {}, requestTimeout: 10_000 },
      clientCapabilities: {},
      hostContext: {},
      mcpProfile: {
        profileVersion: 1,
        apps: {
          sandbox: {
            csp: {
              restrictTo: { connectDomains: ["b.com", "a.com"] },
              deny: { connectDomains: ["spam.com", "evil.com"] },
            },
          },
        },
      },
    });
    const b = emptyHostConfigInputV2({
      ...a,
      mcpProfile: {
        profileVersion: 1,
        apps: {
          sandbox: {
            csp: {
              restrictTo: { connectDomains: ["a.com", "b.com"] },
              deny: { connectDomains: ["evil.com", "spam.com"] },
            },
          },
        },
      },
    });
    expect(hostConfigInputsEqual(a, b)).toBe(true);
  });

  it("hostConfigInputsEqual distinguishes `undefined` from `{ profileVersion: 1 }`", () => {
    // Mirrors the backend's tri-state contract: undefined ≠ an empty
    // envelope (the user "opting in" to a profile but configuring
    // nothing). Two configs that differ only in this signal must NOT
    // dedupe via the editor's dirty check.
    const undef = emptyHostConfigInputV2({});
    const empty = emptyHostConfigInputV2({
      mcpProfile: { profileVersion: 1 },
    });
    expect(hostConfigInputsEqual(undef, empty)).toBe(false);
  });
});
