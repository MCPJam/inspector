import { describe, expect, it } from "vitest";
import { Host } from "../src/host-config/host";
import {
  canonicalizeHostConfigV2,
  computeHostConfigHashV2,
} from "../src/host-config/internal";
import type { HostConfigInputV2 } from "../src/host-config/internal";

const base: HostConfigInputV2 = {
  hostStyle: "claude",
  modelId: "anthropic/claude-sonnet-4-6",
  systemPrompt: "",
  temperature: 0.7,
  requireToolApproval: false,
  connectionDefaults: { headers: {}, requestTimeout: 10000 },
  clientCapabilities: {},
  hostContext: {},
};

describe("agent loop contract", () => {
  it("omits an absent loop without changing the legacy hash", async () => {
    expect(canonicalizeHostConfigV2(base)).not.toHaveProperty("agentLoop");
    expect(await computeHostConfigHashV2(base)).toBe(
      await computeHostConfigHashV2({ ...base, agentLoop: undefined })
    );
  });

  it.each(["claude-code", "codex", "cursor"] as const)(
    "round-trips %s through a Host snapshot",
    async (agentLoop) => {
      const input = {
        ...base,
        agentLoop,
        computer: { kind: "personal" as const },
      };
      const canonical = canonicalizeHostConfigV2(input);
      expect(canonical.agentLoop).toBe(agentLoop);
      expect(await computeHostConfigHashV2(input)).not.toBe(
        await computeHostConfigHashV2(base)
      );
      const host = new Host(
        new Host({
          style: "claude",
          model: base.modelId,
          agentLoop,
          computer: { kind: "personal" },
        }).toJSON()
      );
      expect(host.agentLoop).toBe(agentLoop);
      expect(host.toJSON().agentLoop).toBe(agentLoop);
    }
  );

  it("rejects simultaneous harness and agentLoop", () => {
    expect(() =>
      canonicalizeHostConfigV2({
        ...base,
        agentLoop: "codex",
        harness: "claude-code",
        computer: { kind: "personal" },
      })
    ).toThrow("cannot both be set");
  });

  it("rejects a loop without a computer", () => {
    expect(() =>
      canonicalizeHostConfigV2({ ...base, agentLoop: "codex" })
    ).toThrow("requires a computer");
  });

  it("rejects unknown loop ids from untyped callers", () => {
    const input = {
      ...base,
      agentLoop: "unknown",
      computer: { kind: "personal" },
    };
    expect(() =>
      canonicalizeHostConfigV2(JSON.parse(JSON.stringify(input)))
    ).toThrow("known harness id");
  });
});
