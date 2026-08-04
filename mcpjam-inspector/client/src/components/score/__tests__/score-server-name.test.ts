import { describe, expect, it } from "vitest";
import { deriveScoreServerName } from "../score-server-name";

/**
 * The derived name is what `buildServerRequest` resolves against
 * `serverIdsByName`, so determinism is the whole requirement: the same URL
 * twice must land on the same row instead of piling up duplicates in a
 * guest's project.
 */
describe("deriveScoreServerName", () => {
  it("is stable for the same URL", () => {
    expect(deriveScoreServerName("https://mcp.example.com/mcp")).toBe(
      deriveScoreServerName("https://mcp.example.com/mcp")
    );
  });

  it("ignores the universal /mcp and /sse endpoint suffixes", () => {
    // These say nothing about WHICH server this is.
    expect(deriveScoreServerName("https://mcp.example.com/mcp")).toBe(
      "mcp.example.com"
    );
    expect(deriveScoreServerName("https://mcp.example.com/sse")).toBe(
      "mcp.example.com"
    );
    expect(deriveScoreServerName("https://mcp.example.com/mcp/")).toBe(
      "mcp.example.com"
    );
  });

  it("keeps a path that actually distinguishes two servers on one host", () => {
    expect(deriveScoreServerName("https://example.com/team-a/mcp")).toBe(
      "example.com-team-a-mcp"
    );
    expect(deriveScoreServerName("https://example.com/team-a/mcp")).not.toBe(
      deriveScoreServerName("https://example.com/team-b/mcp")
    );
  });

  it("drops a leading www so the label reads like the product", () => {
    expect(deriveScoreServerName("https://www.example.com/mcp")).toBe(
      "example.com"
    );
  });

  it("produces a safe slug from hostile input", () => {
    const name = deriveScoreServerName("https://ex ample.com/a b/../c?x=1#y");
    expect(name).toMatch(/^[a-z0-9.-]+$/);
    expect(name.startsWith("-")).toBe(false);
    expect(name.endsWith("-")).toBe(false);
  });

  it("never returns an empty name", () => {
    expect(deriveScoreServerName("")).toBe("mcp-server");
    expect(deriveScoreServerName("!!!").length).toBeGreaterThan(0);
  });

  it("bounds the length so a pathological URL cannot become the label", () => {
    const name = deriveScoreServerName(
      `https://example.com/${"segment/".repeat(50)}mcp`
    );
    expect(name.length).toBeLessThanOrEqual(64);
  });
});
