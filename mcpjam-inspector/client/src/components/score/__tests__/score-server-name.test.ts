import { describe, expect, it } from "vitest";
import { deriveScoreServerName } from "../score-server-name";

/**
 * The derived name is what `buildServerRequest` resolves against
 * `serverIdsByName`, so determinism is the whole requirement: the same URL
 * twice must land on the same row instead of piling up duplicates in a
 * guest's project.
 */
describe("deriveScoreServerName", () => {
  it("is stable for the same URL", async () => {
    expect(await deriveScoreServerName("https://mcp.example.com/mcp")).toBe(
      await deriveScoreServerName("https://mcp.example.com/mcp"),
    );
  });

  it("ignores the universal /mcp and /sse endpoint suffixes", async () => {
    // These say nothing about WHICH server this is.
    // The readable part drops the suffix; the digest still distinguishes them.
    expect(await deriveScoreServerName("https://mcp.example.com/mcp")).toMatch(
      /^mcp-example-com-[a-z0-9]+$/,
    );
    expect(await deriveScoreServerName("https://mcp.example.com/sse")).toMatch(
      /^mcp-example-com-/,
    );
    expect(await deriveScoreServerName("https://mcp.example.com/mcp/")).toBe(
      await deriveScoreServerName("https://mcp.example.com/mcp"),
    );
  });

  it("keeps a path that actually distinguishes two servers on one host", async () => {
    expect(
      await deriveScoreServerName("https://example.com/team-a/mcp"),
    ).toMatch(/^example-com-team-a-mcp-/);
    expect(
      await deriveScoreServerName("https://example.com/team-a/mcp"),
    ).not.toBe(await deriveScoreServerName("https://example.com/team-b/mcp"));
  });

  it("drops a leading www so the label reads like the product", async () => {
    expect(await deriveScoreServerName("https://www.example.com/mcp")).toMatch(
      /^example-com-/,
    );
  });

  it("produces a safe slug from hostile input", async () => {
    const name = await deriveScoreServerName(
      "https://ex ample.com/a b/../c?x=1#y",
    );
    // Matches the product's own `slugifyName` shape.
    expect(name).toMatch(/^[a-z0-9-]+$/);
    expect(name.startsWith("-")).toBe(false);
    expect(name.endsWith("-")).toBe(false);
  });

  it("never returns an empty name", async () => {
    expect(await deriveScoreServerName("")).toMatch(/^mcp-server-/);
    expect((await deriveScoreServerName("!!!")).length).toBeGreaterThan(0);
  });

  it("keeps servers apart that the readable slug alone would merge", async () => {
    // Each pair collides on the slug and must NOT collide on the name — a
    // merged name means the second scan silently grades the first server.
    const collidingPairs: Array<[string, string]> = [
      // Port is not part of the hostname.
      ["https://mcp.example.com:8443/mcp", "https://mcp.example.com/mcp"],
      // Punctuation collapses in the slug.
      ["https://example.com/team a/mcp", "https://example.com/team-a/mcp"],
      // Scheme alone.
      ["https://mcp.example.com/mcp", "http://mcp.example.com/mcp"],
      // Query string alone.
      [
        "https://mcp.example.com/mcp?tenant=a",
        "https://mcp.example.com/mcp?tenant=b",
      ],
    ];
    for (const [left, right] of collidingPairs) {
      expect(await deriveScoreServerName(left)).not.toBe(
        await deriveScoreServerName(right),
      );
    }
  });

  it("bounds the length so a pathological URL cannot become the label", async () => {
    const name = await deriveScoreServerName(
      `https://example.com/${"segment/".repeat(50)}mcp`,
    );
    expect(name.length).toBeLessThanOrEqual(64);
  });
});
