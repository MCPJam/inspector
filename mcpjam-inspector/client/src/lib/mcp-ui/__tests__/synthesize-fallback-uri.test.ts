import { describe, it, expect } from "vitest";
import {
  djb2Hex16,
  resolveCanonicalResourceUri,
  synthesizeFallbackResourceUri,
} from "../synthesize-fallback-uri";

describe("synthesizeFallbackResourceUri", () => {
  it("uses ui:// scheme per SEP-1865", () => {
    const uri = synthesizeFallbackResourceUri({
      serverId: "srv_abc",
      toolName: "fetch-weather",
    });
    expect(uri.startsWith("ui://")).toBe(true);
  });

  it("is namespaced under inspector + serverId so two servers cannot forge each other's URIs", () => {
    const a = synthesizeFallbackResourceUri({
      serverId: "srv_a",
      toolName: "tool",
    });
    const b = synthesizeFallbackResourceUri({
      serverId: "srv_b",
      toolName: "tool",
    });
    expect(a).not.toBe(b);
  });

  it("is deterministic — same inputs hash to the same URI", () => {
    const a = synthesizeFallbackResourceUri({
      serverId: "srv_1",
      toolName: "fetch-weather",
    });
    const b = synthesizeFallbackResourceUri({
      serverId: "srv_1",
      toolName: "fetch-weather",
    });
    expect(a).toBe(b);
  });

  it("handles tool names with spaces / slashes / special characters without producing ambiguous paths", () => {
    // Two distinct tool names that would have collapsed under a
    // naive `${serverName}/${toolName}` join must hash to different
    // segments here.
    const a = synthesizeFallbackResourceUri({
      serverId: "srv_1",
      toolName: "fetch weather",
    });
    const b = synthesizeFallbackResourceUri({
      serverId: "srv_1",
      toolName: "fetch/weather",
    });
    expect(a).not.toBe(b);
    expect(a).not.toContain(" ");
    expect(b.endsWith("/")).toBe(false);
    expect(b.includes("/inspector/")).toBe(true);
  });

  it("hash output is 16 hex chars", () => {
    expect(djb2Hex16("anything")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("resolveCanonicalResourceUri", () => {
  const fallback = "ui://mcpjam/inspector/srv_1/abc1234567890def";

  it("accepts a ui:// candidate verbatim", () => {
    expect(
      resolveCanonicalResourceUri({
        candidate: "ui://weather/dashboard",
        legacyOutputTemplate: undefined,
        fallback,
      })
    ).toBe("ui://weather/dashboard");
  });

  it("trims whitespace around a ui:// candidate", () => {
    expect(
      resolveCanonicalResourceUri({
        candidate: "  ui://weather/dashboard  ",
        legacyOutputTemplate: undefined,
        fallback,
      })
    ).toBe("ui://weather/dashboard");
  });

  it("REGRESSION: a non-ui:// candidate does NOT pass through (OpenAI bug)", () => {
    // `getUIResourceUri(UIType.OPENAI_SDK, toolMeta)` returns the raw
    // `openai/outputTemplate` value verbatim — any scheme. Pre-fix,
    // that flowed straight into the canonical column. We must reject
    // the non-compliant value and fall through.
    expect(
      resolveCanonicalResourceUri({
        candidate: "https://example.com/widget",
        legacyOutputTemplate: undefined,
        fallback,
      })
    ).toBe(fallback);
  });

  it("rejects a legacy mcp:// candidate too", () => {
    expect(
      resolveCanonicalResourceUri({
        candidate: "mcp://server/tool",
        legacyOutputTemplate: undefined,
        fallback,
      })
    ).toBe(fallback);
  });

  it("falls through to legacy outputTemplate when it is ui:// and candidate is not", () => {
    expect(
      resolveCanonicalResourceUri({
        candidate: "https://bad",
        legacyOutputTemplate: "ui://weather/dashboard",
        fallback,
      })
    ).toBe("ui://weather/dashboard");
  });

  it("returns fallback when both candidate and legacy template are non-ui://", () => {
    expect(
      resolveCanonicalResourceUri({
        candidate: "https://bad-a",
        legacyOutputTemplate: "https://bad-b",
        fallback,
      })
    ).toBe(fallback);
  });

  it("returns fallback when neither field is provided", () => {
    expect(
      resolveCanonicalResourceUri({
        candidate: undefined,
        legacyOutputTemplate: undefined,
        fallback,
      })
    ).toBe(fallback);
  });

  it("treats empty / whitespace-only candidate as absent", () => {
    expect(
      resolveCanonicalResourceUri({
        candidate: "   ",
        legacyOutputTemplate: undefined,
        fallback,
      })
    ).toBe(fallback);
  });
});
