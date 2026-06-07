/**
 * Tests for `buildSdkEvalsWireHostConfig` (Stage 5, Step 3).
 *
 * Contract:
 *  - The returned `hostConfig` is post-normalization (runtime ids stripped).
 *  - The returned `hostConfigHash` is byte-equivalent to what
 *    `computeHostConfigHashV2(normalizeSdkEvalHostConfigForWire(input))`
 *    produces — i.e., the backend re-running the same pipeline must agree.
 *  - The same logical host produces the same hash whether the caller
 *    supplies a `HostConfigInputV2` (canonical) or a `HostJson` (public).
 *  - `serverIds`/`optionalServerIds` on the input have no influence on
 *    the hash.
 */

import {
  computeHostConfigHashV2,
  normalizeSdkEvalHostConfigForWire,
} from "../src/host-config/internal";
import type { HostConfigInputV2 } from "../src/host-config/internal";
import { Host } from "../src/host-config/index";
import { buildSdkEvalsWireHostConfig } from "../src/sdk-evals-wire-host-config";

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

describe("buildSdkEvalsWireHostConfig", () => {
  it("strips runtime ids from the wire hostConfig", async () => {
    const input = baseInput({
      serverIds: ["runtime_srv_alpha"],
      optionalServerIds: ["runtime_srv_beta"],
      serverConnectionOverrides: {
        runtime_srv_alpha: { headersOverride: { X: "y" } },
      },
    });
    const out = await buildSdkEvalsWireHostConfig(input);
    expect(
      (out.hostConfig as Record<string, unknown>).serverIds
    ).toBeUndefined();
    expect(
      (out.hostConfig as Record<string, unknown>).optionalServerIds
    ).toBeUndefined();
    expect(
      (out.hostConfig as Record<string, unknown>).serverConnectionOverrides
    ).toBeUndefined();
  });

  it("hash matches an independent re-canonicalize+rehash (round-trip)", async () => {
    const input = baseInput({
      serverIds: ["runtime_srv_alpha", "runtime_srv_beta"],
    });
    const out = await buildSdkEvalsWireHostConfig(input);
    const reHash = await computeHostConfigHashV2(
      normalizeSdkEvalHostConfigForWire(out.hostConfig)
    );
    expect(out.hostConfigHash).toBe(reHash);
  });

  it("hash is stable across HostConfigInputV2 and HostJson inputs", async () => {
    const host = new Host({
      style: "claude",
      model: "anthropic/claude-sonnet-4-6",
      systemPrompt: "You are a helpful assistant.",
      temperature: 0.7,
      requireToolApproval: false,
      connectionDefaults: { headers: {}, requestTimeout: 10000 },
    });
    const hostJson = host.toJSON();

    const internalInput = baseInput();
    const fromInternal = await buildSdkEvalsWireHostConfig(internalInput);
    const fromPublic = await buildSdkEvalsWireHostConfig(hostJson);
    expect(fromInternal.hostConfigHash).toBe(fromPublic.hostConfigHash);
  });

  it("hash is independent of serverIds / optionalServerIds in the input", async () => {
    const withIds = await buildSdkEvalsWireHostConfig(
      baseInput({
        serverIds: ["runtime_srv_alpha", "runtime_srv_beta"],
        optionalServerIds: ["runtime_srv_gamma"],
        serverConnectionOverrides: {
          runtime_srv_alpha: {
            headersOverride: { Authorization: "Bearer secret" },
          },
        },
      })
    );
    const withoutIds = await buildSdkEvalsWireHostConfig(baseInput());
    expect(withIds.hostConfigHash).toBe(withoutIds.hostConfigHash);
  });

  it("differs when a non-id field changes (sanity)", async () => {
    const a = await buildSdkEvalsWireHostConfig(
      baseInput({ temperature: 0.7 })
    );
    const b = await buildSdkEvalsWireHostConfig(
      baseInput({ temperature: 0.4 })
    );
    expect(a.hostConfigHash).not.toBe(b.hostConfigHash);
  });
});
