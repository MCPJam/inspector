import { describe, expect, it } from "vitest";
import { normalizeScoreUrl } from "../score-url";

describe("normalizeScoreUrl", () => {
  it("adds https when the visitor pastes a host", () => {
    expect(normalizeScoreUrl("mcp.acme.com/sse")).toBe(
      "https://mcp.acme.com/sse",
    );
  });

  it("keeps an explicit http(s) URL", () => {
    expect(normalizeScoreUrl("https://mcp.acme.com/mcp")).toBe(
      "https://mcp.acme.com/mcp",
    );
  });

  it("rejects empty and unparseable input", () => {
    expect(normalizeScoreUrl("   ")).toBeNull();
    expect(normalizeScoreUrl("http://")).toBeNull();
  });
});
