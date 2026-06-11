import { describe, it, expect } from "vitest";
import {
  DEFAULT_TEMPERATURE_V2,
  resolveEffectiveMcpProtocolVersion,
} from "../src/host-config/internal";

describe("DEFAULT_TEMPERATURE_V2", () => {
  it("is 0.7 — agreed default shared with the backend's ensureProjectV2Default seed and the inspector's emptyHostConfigInputV2", () => {
    expect(DEFAULT_TEMPERATURE_V2).toBe(0.7);
  });
});

describe("resolveEffectiveMcpProtocolVersion", () => {
  it("returns the per-server override when present (server wins over host default)", () => {
    expect(
      resolveEffectiveMcpProtocolVersion("2025-06-18", "2025-11-25"),
    ).toBe("2025-06-18");
  });

  it("returns the host default when the server has no override", () => {
    expect(
      resolveEffectiveMcpProtocolVersion(undefined, "2025-11-25"),
    ).toBe("2025-11-25");
  });

  it("returns undefined when neither layer has an opinion — load-bearing sentinel: SDK chooses at request time", () => {
    expect(
      resolveEffectiveMcpProtocolVersion(undefined, undefined),
    ).toBeUndefined();
  });

  it("returns the per-server override even when host default is also set (no merge)", () => {
    expect(
      resolveEffectiveMcpProtocolVersion("2026-07-28", "2025-03-26"),
    ).toBe("2026-07-28");
  });

  it("returns the per-server override when host default is undefined", () => {
    expect(
      resolveEffectiveMcpProtocolVersion("2025-03-26", undefined),
    ).toBe("2025-03-26");
  });
});
