import { describe, expect, it } from "vitest";
import { toExecutionProjection } from "../eval-execution-projection.js";

const record = {
  requested: {
    modelId: "anthropic/claude-sonnet-4.5",
    source: "hosted",
    fallback: { provider: "none", model: "none" },
  },
  resolved: {
    rail: "gateway",
    wireModelId: "anthropic/claude-sonnet-4.5",
    offering: { rail: "gateway", providerKey: "gateway" },
  },
  effectiveSettings: { maxOutputTokens: 0 },
  attempts: [
    {
      rail: "gateway",
      wireModelId: "anthropic/claude-sonnet-4.5",
      outcome: "ok",
      at: 1,
    },
  ],
};

describe("toExecutionProjection", () => {
  it("projects a stored record as the contract shape", () => {
    expect(toExecutionProjection(record)).toEqual({ execution: record });
  });

  it("omits the field for a row written before the record existed", () => {
    expect(toExecutionProjection(undefined)).toEqual({});
    expect(toExecutionProjection(null)).toEqual({});
    expect(toExecutionProjection({ resolved: {} })).toEqual({});
  });

  it("never carries a field beyond the contract across the boundary", () => {
    const projected = toExecutionProjection({
      ...record,
      apiKey: "sk-live-secret",
      resolved: {
        ...record.resolved,
        offering: { ...record.resolved.offering, sealedKey: "sk-live-secret" },
      },
    });
    expect(projected).toEqual({ execution: record });
    expect(JSON.stringify(projected)).not.toContain("sk-live");
  });
});
