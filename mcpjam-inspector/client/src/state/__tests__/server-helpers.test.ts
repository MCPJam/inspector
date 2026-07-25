import { describe, expect, it } from "vitest";
import { toMCPConfig } from "../server-helpers";
import type { ServerFormData } from "@/shared/types.js";

function httpForm(overrides: Partial<ServerFormData> = {}): ServerFormData {
  return {
    type: "http",
    url: "https://example.com/mcp",
    ...overrides,
  } as ServerFormData;
}

describe("toMCPConfig OAuth wire-era stamp", () => {
  it("stamps mcpProtocolVersion for a 2026-07-28 OAuth mode", () => {
    const config = toMCPConfig(
      httpForm({ oauthProtocolMode: "2026-07-28" }),
    );
    expect((config as { mcpProtocolVersion?: string }).mcpProtocolVersion).toBe(
      "2026-07-28",
    );
  });

  it("leaves the wire era unset for older OAuth modes and auto", () => {
    for (const mode of ["auto", "2025-11-25", "2025-06-18"] as const) {
      const config = toMCPConfig(httpForm({ oauthProtocolMode: mode }));
      expect(
        (config as { mcpProtocolVersion?: string }).mcpProtocolVersion,
      ).toBeUndefined();
    }
  });
});
