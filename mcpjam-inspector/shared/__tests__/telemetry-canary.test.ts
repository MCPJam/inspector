import { afterEach, describe, expect, it, vi } from "vitest";
import { buildStrictLogRow } from "../strict-log";
import { sha256Hex } from "@mcpjam/sdk/contract";

afterEach(() => vi.useRealTimers());
describe("collector health probe", () => {
  it("mints the known slot and digest independently of caller fields", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T12:03:00Z"));
    const row = buildStrictLogRow(
      "telemetry_canary",
      {},
      { slot: 1, canaryId: "PRIVATE_SENTINEL", emittedAt: "PRIVATE_SENTINEL" },
    );
    const slot = Math.floor(Date.now() / 300000);
    expect(row).toMatchObject({
      slot,
      route: "inspector",
      canaryId: sha256Hex(`inspector:${slot}`),
    });
    expect(JSON.stringify(row)).not.toContain("PRIVATE_SENTINEL");
  });
  it("turns user agent content into a finite family", () => {
    expect(
      buildStrictLogRow("http.request.failed", {
        userAgent: "curl/PRIVATE_SENTINEL",
      }),
    ).toMatchObject({ userAgentFamily: "curl" });
  });
});
