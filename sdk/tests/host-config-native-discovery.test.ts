import { describe, expect, it } from "vitest";
import { Host } from "../src/host-config/host";
import {
  canonicalizeHostConfigV2,
  computeHostConfigHashV2,
} from "../src/host-config/internal";
import type { HostConfigInputV2 } from "../src/host-config/internal";

const base: HostConfigInputV2 = {
  hostStyle: "claude",
  modelId: "anthropic/claude-haiku-4.5",
  systemPrompt: "",
  temperature: 0,
  requireToolApproval: false,
  harness: "claude-code",
  connectionDefaults: { headers: {}, requestTimeout: 10000 },
  clientCapabilities: {},
  hostContext: {},
};

describe("required native discovery", () => {
  it("keeps absent policies hash-identical", async () => {
    expect(canonicalizeHostConfigV2(base)).not.toHaveProperty(
      "requireNativeToolDiscovery"
    );
    expect(await computeHostConfigHashV2(base)).toBe(
      await computeHostConfigHashV2({
        ...base,
        requireNativeToolDiscovery: undefined,
      })
    );
  });
  it.each([true, false])(
    "preserves %s through public serialization and content hashing",
    async (required) => {
      const host = new Host({
        style: "claude",
        model: base.modelId,
        harness: "claude-code",
        requireNativeToolDiscovery: required,
      });
      expect(new Host(host.toJSON()).toJSON().requireNativeToolDiscovery).toBe(
        required
      );
      expect(
        canonicalizeHostConfigV2({
          ...base,
          requireNativeToolDiscovery: required,
        }).requireNativeToolDiscovery
      ).toBe(required);
      expect(
        await computeHostConfigHashV2({
          ...base,
          requireNativeToolDiscovery: required,
        })
      ).not.toBe(await computeHostConfigHashV2(base));
      expect(
        await computeHostConfigHashV2({
          ...base,
          requireNativeToolDiscovery: required,
        })
      ).toBe(
        required
          ? "3bb87389ac06d1521099fee9abaddc3a1bd6c88848fc27dfae342477d01ae115"
          : "c5ffc3f1e14f805e76d787bea563dfb9788f55afb94f4389b722868c6ec4140f"
      );
    }
  );
  it("preserves a policy before a harness is selected; execution owns admission", () => {
    expect(
      canonicalizeHostConfigV2({
        ...base,
        harness: undefined,
        requireNativeToolDiscovery: true,
      }).requireNativeToolDiscovery
    ).toBe(true);
  });
});
