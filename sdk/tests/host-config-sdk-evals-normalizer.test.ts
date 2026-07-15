/**
 * Tests for `normalizeSdkEvalHostConfigForWire` (Stage 5, Step 1).
 *
 * Behavior under test:
 *  1. Strips `serverIds`, `optionalServerIds`, `serverConnectionOverrides`
 *     regardless of input shape.
 *  2. Preserves every other top-level field verbatim.
 *  3. Accepts both canonical `HostConfigInputV2` and public `HostJson`
 *     (from `Host.toJSON()`).
 *  4. Is pure: never mutates the input.
 *  5. Is idempotent under canonicalize+hash: running through normalize twice
 *     produces the same canonical bytes as once.
 *  6. After normalize, canonicalize+hash is independent of any server-id
 *     strings the original may have carried.
 */

import {
  canonicalizeHostConfigV2,
  computeHostConfigHashV2,
  normalizeSdkEvalHostConfigForWire,
} from "../src/host-config/internal";
import type {
  HostConfigInputV2,
  HostConfigMcpProfileV1,
} from "../src/host-config/internal";
import { Host } from "../src/host-config/index";
import type { HostJson } from "../src/host-config/index";

function baseInput(
  overrides: Partial<HostConfigInputV2> = {}
): HostConfigInputV2 {
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

describe("normalizeSdkEvalHostConfigForWire — stripping", () => {
  it("strips serverIds, optionalServerIds, and serverConnectionOverrides from a canonical input", () => {
    const input = baseInput({
      serverIds: ["runtime_srv_alpha", "runtime_srv_beta"],
      optionalServerIds: ["runtime_srv_gamma"],
      serverConnectionOverrides: {
        runtime_srv_alpha: {
          headersOverride: { Authorization: "Bearer x" },
          requestTimeoutOverride: 5000,
        },
      },
    });

    const out = normalizeSdkEvalHostConfigForWire(input);

    expect((out as Record<string, unknown>).serverIds).toBeUndefined();
    expect((out as Record<string, unknown>).optionalServerIds).toBeUndefined();
    expect(
      (out as Record<string, unknown>).serverConnectionOverrides
    ).toBeUndefined();
  });

  it("returns a fresh object — never mutates the source", () => {
    const input = baseInput({
      serverIds: ["a", "b"],
      optionalServerIds: ["c"],
      serverConnectionOverrides: { a: { requestTimeoutOverride: 1 } },
    });
    const snapshotBefore = JSON.parse(JSON.stringify(input));

    const out = normalizeSdkEvalHostConfigForWire(input);

    expect(out).not.toBe(input);
    expect(input).toEqual(snapshotBefore);
    // serverIds still on the source object after the call.
    expect(input.serverIds).toEqual(["a", "b"]);
  });

  it("strips computer from a canonical input — evals never carry one", async () => {
    const input = baseInput({
      computer: { kind: "personal", toolset: "bash", workdir: "/srv" },
    });

    const out = normalizeSdkEvalHostConfigForWire(input);

    expect((out as Record<string, unknown>).computer).toBeUndefined();
    // Source untouched.
    expect(input.computer).toEqual({
      kind: "personal",
      toolset: "bash",
      workdir: "/srv",
    });
    // The wire hash is independent of the computer the host carried.
    expect(await computeHostConfigHashV2(out)).toBe(
      await computeHostConfigHashV2(
        normalizeSdkEvalHostConfigForWire(baseInput())
      )
    );
  });

  it("strips computer from a Host.toJSON() snapshot too", () => {
    const host = new Host({
      style: "claude",
      model: "anthropic/claude-sonnet-4-6",
      computer: { kind: "personal", toolset: "bash" },
    });
    const json = host.toJSON();
    expect(json.computer).toEqual({ kind: "personal" });

    const out = normalizeSdkEvalHostConfigForWire(json);
    expect((out as Record<string, unknown>).computer).toBeUndefined();
  });
});

describe("normalizeSdkEvalHostConfigForWire — preservation", () => {
  it("preserves every non-stripped top-level field verbatim", () => {
    const mcpProfile: HostConfigMcpProfileV1 = {
      profileVersion: 1,
      mcpProtocolVersion: "2025-11-25",
      initialize: {
        clientInfo: { name: "my-app", version: "1.0" },
        supportedProtocolVersions: ["2025-11-25", "2025-06-18"],
      },
      apps: {
        sandbox: { csp: { mode: "declared" } },
      },
    };

    const input: HostConfigInputV2 = {
      hostStyle: "mcpjam",
      modelId: "anthropic/claude-sonnet-4-6",
      systemPrompt: "be helpful",
      temperature: 0.4,
      requireToolApproval: true,
      progressiveToolDiscovery: true,
      respectToolVisibility: false,
      serverIds: ["runtime_x"],
      optionalServerIds: ["runtime_y"],
      connectionDefaults: {
        headers: { "x-trace": "abc" },
        requestTimeout: 12345,
      },
      clientCapabilities: { sampling: {} },
      hostContext: { theme: "dark" },
      hostCapabilitiesOverride: { serverTools: undefined },
      chatUiOverride: { logoUrl: "https://example.com/logo.png" },
      mcpProfile,
      serverConnectionOverrides: { runtime_x: { requestTimeoutOverride: 9 } },
    };

    const out = normalizeSdkEvalHostConfigForWire(input);

    // Every non-stripped field round-trips.
    expect(out.hostStyle).toBe("mcpjam");
    expect(out.modelId).toBe("anthropic/claude-sonnet-4-6");
    expect(out.systemPrompt).toBe("be helpful");
    expect(out.temperature).toBe(0.4);
    expect(out.requireToolApproval).toBe(true);
    expect(out.progressiveToolDiscovery).toBe(true);
    expect(out.respectToolVisibility).toBe(false);
    expect(out.connectionDefaults).toEqual({
      headers: { "x-trace": "abc" },
      requestTimeout: 12345,
    });
    expect(out.clientCapabilities).toEqual({ sampling: {} });
    expect(out.hostContext).toEqual({ theme: "dark" });
    expect(out.hostCapabilitiesOverride).toEqual({ serverTools: undefined });
    expect(out.chatUiOverride).toEqual({
      logoUrl: "https://example.com/logo.png",
    });
    expect(out.mcpProfile).toEqual(mcpProfile);

    // Stripped fields are gone.
    expect(out.serverIds).toBeUndefined();
    expect(out.optionalServerIds).toBeUndefined();
    expect(out.serverConnectionOverrides).toBeUndefined();
  });

  it("preserves absent optionals as absent (no spurious undefineds)", () => {
    const input = baseInput();
    const out = normalizeSdkEvalHostConfigForWire(input);

    // None of the optional-only fields should suddenly materialize as keys.
    expect("progressiveToolDiscovery" in out).toBe(false);
    expect("respectToolVisibility" in out).toBe(false);
    expect("hostCapabilitiesOverride" in out).toBe(false);
    expect("chatUiOverride" in out).toBe(false);
    expect("mcpProfile" in out).toBe(false);
  });
});

describe("normalizeSdkEvalHostConfigForWire — public HostJson acceptance", () => {
  it("accepts a `Host.toJSON()` snapshot and projects to canonical shape", () => {
    const host = new Host({
      style: "mcpjam",
      model: "anthropic/claude-sonnet-4-6",
    })
      .requireServer("everything")
      .requireServer("filesystem");
    host.mcp.protocolVersion = "2025-11-25";

    const json: HostJson = host.toJSON();

    // Sanity: HostJson uses public vocabulary.
    expect(json.style).toBe("mcpjam");
    expect(json.servers).toEqual(["everything", "filesystem"]);
    expect(json.mcp?.protocolVersion).toBe("2025-11-25");

    const out = normalizeSdkEvalHostConfigForWire(json);

    // Projected to canonical vocabulary.
    expect(out.hostStyle).toBe("mcpjam");
    expect(out.modelId).toBe("anthropic/claude-sonnet-4-6");
    // Stripped — neither public nor canonical server-list field survives.
    expect(out.serverIds).toBeUndefined();
    expect((out as Record<string, unknown>).servers).toBeUndefined();
    expect(out.optionalServerIds).toBeUndefined();
    expect((out as Record<string, unknown>).optionalServers).toBeUndefined();
    expect(out.serverConnectionOverrides).toBeUndefined();
    expect((out as Record<string, unknown>).serverOverrides).toBeUndefined();
    // mcpProfile preserved.
    expect(out.mcpProfile?.mcpProtocolVersion).toBe("2025-11-25");
    expect(out.mcpProfile?.profileVersion).toBe(1);
  });

  it("strips public-shape per-server overrides too", () => {
    const host = new Host({ style: "mcpjam", model: "test-model" })
      .requireServer("a")
      .setServerOverride("a", { requestTimeout: 4321 });
    const json = host.toJSON();
    expect(json.serverOverrides?.a?.requestTimeout).toBe(4321);

    const out = normalizeSdkEvalHostConfigForWire(json);
    expect(out.serverConnectionOverrides).toBeUndefined();
    expect((out as Record<string, unknown>).serverOverrides).toBeUndefined();
  });
});

describe("normalizeSdkEvalHostConfigForWire — hash semantics", () => {
  it("makes the canonical hash independent of original serverIds", async () => {
    const withIdsA = baseInput({
      serverIds: ["runtime_alpha", "runtime_beta"],
      optionalServerIds: ["runtime_gamma"],
      serverConnectionOverrides: {
        runtime_alpha: { requestTimeoutOverride: 999 },
      },
    });
    const withIdsB = baseInput({
      serverIds: ["k_xxxxxxxxxxxxxxxxxx", "k_yyyyyyyyyyyyyyyyyy"],
      optionalServerIds: ["k_zzzzzzzzzzzzzzzzzz"],
      serverConnectionOverrides: {
        k_xxxxxxxxxxxxxxxxxx: { requestTimeoutOverride: 12345 },
      },
    });
    const withNoIds = baseInput();

    const hashA = await computeHostConfigHashV2(
      normalizeSdkEvalHostConfigForWire(withIdsA)
    );
    const hashB = await computeHostConfigHashV2(
      normalizeSdkEvalHostConfigForWire(withIdsB)
    );
    const hashEmpty = await computeHostConfigHashV2(
      normalizeSdkEvalHostConfigForWire(withNoIds)
    );

    expect(hashA).toBe(hashB);
    expect(hashA).toBe(hashEmpty);
  });

  it("is idempotent: normalize(normalize(x)) hashes identically to normalize(x)", async () => {
    const input = baseInput({
      serverIds: ["a"],
      optionalServerIds: ["b"],
      mcpProfile: {
        profileVersion: 1,
        mcpProtocolVersion: "2025-11-25",
      },
    });

    const once = normalizeSdkEvalHostConfigForWire(input);
    const twice = normalizeSdkEvalHostConfigForWire(once);

    const hashOnce = await computeHostConfigHashV2(once);
    const hashTwice = await computeHostConfigHashV2(twice);

    expect(hashTwice).toBe(hashOnce);
  });

  it("HostJson snapshot and canonical input with same logical config hash identically", async () => {
    // Same logical host, built two ways: one as canonical input + runtime ids,
    // one via `Host.toJSON()` with the same runtime ids in `servers`.
    const canonical = baseInput({
      hostStyle: "mcpjam",
      modelId: "anthropic/claude-sonnet-4-6",
      serverIds: ["everything"],
      mcpProfile: { profileVersion: 1, mcpProtocolVersion: "2025-11-25" },
    });

    const host = new Host({
      style: "mcpjam",
      model: "anthropic/claude-sonnet-4-6",
      // Match the default `baseInput` so the two paths agree on every
      // canonicalized field, not just the renamed ones.
      systemPrompt: "You are a helpful assistant.",
      temperature: 0.7,
      requireToolApproval: false,
      connectionDefaults: { headers: {}, requestTimeout: 10000 },
      clientCapabilities: {},
      hostContext: {},
    }).requireServer("everything");
    host.mcp.protocolVersion = "2025-11-25";
    const json = host.toJSON();

    const hashCanonical = await computeHostConfigHashV2(
      normalizeSdkEvalHostConfigForWire(canonical)
    );
    const hashFromJson = await computeHostConfigHashV2(
      normalizeSdkEvalHostConfigForWire(json)
    );

    expect(hashFromJson).toBe(hashCanonical);
  });

  it("produces a deterministic golden hash for a fully-specified normalized input", async () => {
    // Tiny inline golden — protects the wire shape from accidental schema
    // drift. If this hash changes, BOTH this fixture and the backend mirror
    // need updating in lockstep (same parity discipline as
    // `host-config-parity-fixtures.json`).
    const input: HostConfigInputV2 = {
      hostStyle: "claude",
      modelId: "anthropic/claude-sonnet-4-6",
      systemPrompt: "You are a helpful assistant.",
      temperature: 0.7,
      requireToolApproval: false,
      // These three are stripped by the normalizer — included to assert that
      // the golden hash is independent of them.
      serverIds: ["should_be_stripped_a", "should_be_stripped_b"],
      optionalServerIds: ["should_be_stripped_c"],
      serverConnectionOverrides: {
        should_be_stripped_a: { requestTimeoutOverride: 99 },
      },
      connectionDefaults: { headers: {}, requestTimeout: 10000 },
      clientCapabilities: {},
      hostContext: {},
    };

    const normalized = normalizeSdkEvalHostConfigForWire(input);
    const canonicalJson = JSON.stringify(canonicalizeHostConfigV2(normalized));
    const hash = await computeHostConfigHashV2(normalized);

    // Canonical JSON must not contain any of the stripped runtime ids.
    expect(canonicalJson).not.toContain("should_be_stripped");

    // The hash equals the hash of the same logical config with no runtime
    // ids at all — this is the golden invariant the backend (Step 2) and
    // the reporter (Step 3) will both rely on.
    const expectedHash = await computeHostConfigHashV2(
      baseInput({ hostStyle: "claude" })
    );
    expect(hash).toBe(expectedHash);
  });
});

describe("normalizeSdkEvalHostConfigForWire — defensive shape handling", () => {
  it("does not throw on a source missing both style and hostStyle", () => {
    // Contract: shape-only normalizer. Validation lives in the canonicalizer
    // downstream; the normalizer must not duplicate it.
    const weird = {
      modelId: "x",
      serverIds: ["should_be_stripped"],
    } as unknown as HostConfigInputV2;

    expect(() => normalizeSdkEvalHostConfigForWire(weird)).not.toThrow();
    const out = normalizeSdkEvalHostConfigForWire(weird);
    expect(out.serverIds).toBeUndefined();
  });
});
