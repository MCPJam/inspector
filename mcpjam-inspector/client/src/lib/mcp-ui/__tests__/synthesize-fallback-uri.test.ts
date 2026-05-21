import { describe, it, expect } from "vitest";
import {
  synthesizeFallbackResourceUri,
  djb2Hex16,
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
