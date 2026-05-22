import { describe, expect, it } from "vitest";
import {
  emptyHostConfigInputV2,
  hostCapabilitiesOverrideToMatrix,
  hostConfigDtoToInput,
  hostConfigInputsEqual,
  mergeMcpAppsCapabilities,
  resolveEffectiveHostCapabilities,
  resolveEffectiveMcpAppsCapabilities,
  type HostConfigDtoV2,
  type HostConfigInputV2,
} from "../client-config-v2";

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

  it("uses the new matrix path when profile carries mcpAppsOverrides", () => {
    // Regression: the matrix override must actually flow through to the
    // advertised wire shape. Previously this path was reachable only via
    // explicit profile arg, but the four real callsites (renderer,
    // canvas, AppsExtensionTab editor + JSON parser) didn't thread it,
    // so a saved `mcpProfile.apps.mcpAppsOverrides` was dead.
    const resolved = resolveEffectiveHostCapabilities({
      hostStyle: "claude",
      profile: {
        profileVersion: 1,
        apps: {
          mcpAppsOverrides: { serverResources: false, logging: false },
        },
      },
    });
    // Claude preset advertises serverResources + logging; the matrix
    // override strips both.
    expect(resolved).not.toHaveProperty("serverResources");
    expect(resolved).not.toHaveProperty("logging");
    // Other Claude rows still advertised.
    expect(resolved).toHaveProperty("openLinks");
    expect(resolved).toHaveProperty("updateModelContext");
    expect(resolved).toHaveProperty("message");
  });

  it("matrix override beats legacy hostCapabilitiesOverride when both are set", () => {
    // Precedence rule: mcpAppsOverrides wins. Legacy field stays
    // readable for one release window during migration.
    const resolved = resolveEffectiveHostCapabilities({
      hostStyle: "claude",
      profile: {
        profileVersion: 1,
        apps: {
          mcpAppsOverrides: { serverResources: false },
        },
      },
      hostCapabilitiesOverride: { serverResources: {} },
    });
    expect(resolved).not.toHaveProperty("serverResources");
  });
});

describe("resolveEffectiveMcpAppsCapabilities", () => {
  it("returns the host style preset when profile is undefined", () => {
    const resolved = resolveEffectiveMcpAppsCapabilities({
      hostStyle: "copilot",
      profile: undefined,
    });
    // Copilot preset: fullscreen-only, no serverResources / logging,
    // no notification gates.
    expect(resolved.availableDisplayModes).toEqual(["fullscreen"]);
    expect(resolved.serverResources).toBe(false);
    expect(resolved.logging).toBe(false);
    expect(resolved.toolInputPartial).toBe(false);
  });

  it("merges sparse overrides over the preset", () => {
    const resolved = resolveEffectiveMcpAppsCapabilities({
      hostStyle: "claude",
      profile: {
        profileVersion: 1,
        apps: { mcpAppsOverrides: { serverResources: false } },
      },
    });
    // Claude preset is FULL_SURFACE; override flips one row.
    expect(resolved.serverResources).toBe(false);
    expect(resolved.logging).toBe(true);
    expect(resolved.openLinks).toBe(true);
    expect(resolved.serverTools).toBe(true);
  });

  it("falls back to NO_CLAIMS for unknown host styles (not FULL_SURFACE)", () => {
    // Regression: a persisted mcpAppsOverrides against a removed host
    // must NOT advertise near-full support. Mirrors getHostCapabilities-
    // ForStyle's honest "no claims" baseline.
    const resolved = resolveEffectiveMcpAppsCapabilities({
      hostStyle: "does-not-exist",
      profile: {
        profileVersion: 1,
        apps: { mcpAppsOverrides: { serverResources: true } },
      },
    });
    expect(resolved.openLinks).toBe(false);
    expect(resolved.serverTools).toBe(false);
    // The override only turns ON what the user asked for, against a
    // no-claims baseline.
    expect(resolved.serverResources).toBe(true);
    expect(resolved.logging).toBe(false);
  });
});

describe("mergeMcpAppsCapabilities", () => {
  it("returns the base unchanged when override is undefined", () => {
    const base = {
      ...MCP_APPS_FULL_SURFACE_FOR_TEST,
    };
    expect(mergeMcpAppsCapabilities(base, undefined)).toBe(base);
  });

  it("replaces availableDisplayModes (not unioned)", () => {
    const merged = mergeMcpAppsCapabilities(
      { ...MCP_APPS_FULL_SURFACE_FOR_TEST },
      { availableDisplayModes: ["fullscreen"] },
    );
    expect(merged.availableDisplayModes).toEqual(["fullscreen"]);
  });

  it("coerces empty availableDisplayModes to ['inline'] (spec default)", () => {
    const merged = mergeMcpAppsCapabilities(
      { ...MCP_APPS_FULL_SURFACE_FOR_TEST },
      { availableDisplayModes: [] },
    );
    expect(merged.availableDisplayModes).toEqual(["inline"]);
  });

  it("treats explicit false in override as a real value (not falsy passthrough)", () => {
    // `?? base.x` semantics: false replaces, undefined falls through.
    const merged = mergeMcpAppsCapabilities(
      { ...MCP_APPS_FULL_SURFACE_FOR_TEST },
      { serverResources: false, logging: false },
    );
    expect(merged.serverResources).toBe(false);
    expect(merged.logging).toBe(false);
    expect(merged.openLinks).toBe(true);
  });
});

describe("hostCapabilitiesOverrideToMatrix", () => {
  it("returns undefined for an undefined legacy override", () => {
    expect(hostCapabilitiesOverrideToMatrix(undefined)).toBeUndefined();
  });

  it("maps legacy {} to all-false (advertise nothing) — lossless migration", () => {
    // Previously lossy: the helper produced a matrix that still let
    // buildHostCapabilities re-add openLinks / serverTools. Now every
    // advertise key is represented so empty legacy maps cleanly.
    const matrix = hostCapabilitiesOverrideToMatrix({});
    expect(matrix).toEqual({
      openLinks: false,
      serverTools: false,
      serverResources: false,
      logging: false,
      updateModelContext: false,
      message: false,
    });
  });

  it("maps a populated legacy override to the matching matrix rows", () => {
    const matrix = hostCapabilitiesOverrideToMatrix({
      openLinks: {},
      serverTools: { listChanged: false },
      message: { text: {} },
    });
    expect(matrix).toEqual({
      openLinks: true,
      serverTools: true,
      serverResources: false,
      logging: false,
      updateModelContext: false,
      message: true,
    });
  });
});

// Shared helper for mergeMcpAppsCapabilities tests; mirrors the
// presets/FULL_SURFACE constant without coupling these tests to a
// specific import path that might shift around during the migration.
const MCP_APPS_FULL_SURFACE_FOR_TEST = {
  availableDisplayModes: ["inline", "fullscreen", "pip"] as const,
  toolInputPartial: true,
  toolCancelled: true,
  hostContextChanged: true,
  resourceTeardown: true,
  toolInfo: true,
  openLinks: true,
  serverTools: true,
  serverResources: true,
  logging: true,
  updateModelContext: true,
  message: true,
  sandboxPermissions: true,
  cspFrameDomains: true,
  cspBaseUriDomains: true,
  resourcePrefersBorder: true,
};
