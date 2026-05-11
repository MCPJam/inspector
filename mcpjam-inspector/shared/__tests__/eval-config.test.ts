import { describe, it, expect } from "vitest";
import { computeExecutionConfigKey } from "../eval-config";
import type { ClientConfigToolChoice } from "../eval-config";

describe("computeExecutionConfigKey", () => {
  it("is deterministic for the same input", () => {
    const k1 = computeExecutionConfigKey({
      hostConfigId: "hc_1",
      provider: "anthropic",
      toolChoice: "auto",
    });
    const k2 = computeExecutionConfigKey({
      hostConfigId: "hc_1",
      provider: "anthropic",
      toolChoice: "auto",
    });
    expect(k1).toBe(k2);
  });

  it("differs when hostConfigId differs", () => {
    expect(
      computeExecutionConfigKey({
        hostConfigId: "hc_1",
        provider: "anthropic",
        toolChoice: "auto",
      }),
    ).not.toBe(
      computeExecutionConfigKey({
        hostConfigId: "hc_2",
        provider: "anthropic",
        toolChoice: "auto",
      }),
    );
  });

  it("differs when provider differs even if hostConfigId matches (the disambiguation case)", () => {
    expect(
      computeExecutionConfigKey({
        hostConfigId: "hc_shared",
        provider: "anthropic",
        toolChoice: "auto",
      }),
    ).not.toBe(
      computeExecutionConfigKey({
        hostConfigId: "hc_shared",
        provider: "openai",
        toolChoice: "auto",
      }),
    );
  });

  it("differs when toolChoice differs even if hostConfigId and provider match", () => {
    const t1: ClientConfigToolChoice = "required";
    const t2: ClientConfigToolChoice = { type: "tool", toolName: "search" };
    expect(
      computeExecutionConfigKey({
        hostConfigId: "hc_shared",
        provider: "anthropic",
        toolChoice: t1,
      }),
    ).not.toBe(
      computeExecutionConfigKey({
        hostConfigId: "hc_shared",
        provider: "anthropic",
        toolChoice: t2,
      }),
    );
  });

  it("treats missing toolChoice as a stable empty value", () => {
    expect(
      computeExecutionConfigKey({
        hostConfigId: "hc",
        provider: "p",
        toolChoice: undefined,
      }),
    ).toBe(
      computeExecutionConfigKey({
        hostConfigId: "hc",
        provider: "p",
        toolChoice: null,
      }),
    );
  });

  it("emits 8-character lowercase hex", () => {
    const key = computeExecutionConfigKey({
      hostConfigId: "hc",
      provider: "p",
      toolChoice: "auto",
    });
    expect(key).toMatch(/^[0-9a-f]{8}$/);
  });

  it("treats string tool-choice and tool-call tool-choice as different keys", () => {
    const k1 = computeExecutionConfigKey({
      hostConfigId: "hc",
      provider: "p",
      toolChoice: "auto",
    });
    const k2 = computeExecutionConfigKey({
      hostConfigId: "hc",
      provider: "p",
      toolChoice: { type: "tool", toolName: "auto" },
    });
    expect(k1).not.toBe(k2);
  });
});
