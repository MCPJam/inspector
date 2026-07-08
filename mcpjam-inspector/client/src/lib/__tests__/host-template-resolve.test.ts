import { describe, expect, it } from "vitest";
import {
  resolveHostTemplateOrThrow,
  getHostTemplateSupportedProtocolVersions,
} from "@/lib/client-templates";

describe("resolveHostTemplateOrThrow", () => {
  it("resolves a known template id", () => {
    expect(resolveHostTemplateOrThrow("claude").id).toBe("claude");
  });

  it("throws on an unknown id — no silent fallback to HOST_TEMPLATES[0]", () => {
    expect(() =>
      // @ts-expect-error — intentionally invalid id
      resolveHostTemplateOrThrow("not-a-real-host"),
    ).toThrow(/Unknown host template id/);
  });
});

describe("getHostTemplateSupportedProtocolVersions", () => {
  it("reads the seed's mcpProfile.initialize.supportedProtocolVersions", () => {
    // Goose's template pins a protocol version; not every template does (e.g.
    // `claude` leaves it unset → undefined, and the check is skipped).
    expect(getHostTemplateSupportedProtocolVersions("goose")).toEqual([
      "2025-03-26",
    ]);
  });

  it("returns undefined for a template that doesn't pin a version", () => {
    expect(getHostTemplateSupportedProtocolVersions("claude")).toBeUndefined();
  });

  it("throws on an unknown id", () => {
    expect(() =>
      // @ts-expect-error — intentionally invalid id
      getHostTemplateSupportedProtocolVersions("not-a-real-host"),
    ).toThrow(/Unknown host template id/);
  });
});
