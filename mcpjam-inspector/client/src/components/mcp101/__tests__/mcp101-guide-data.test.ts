import { describe, expect, it } from "vitest";
import {
  MCP101_STEP_ORDER,
  MCP101_GUIDE_METADATA,
  MCP101_PHASE_ACCENT,
} from "../mcp101-guide-data";

describe("MCP101_GUIDE_METADATA", () => {
  it("has metadata for all 5 steps", () => {
    expect(MCP101_STEP_ORDER).toHaveLength(5);
    for (const step of MCP101_STEP_ORDER) {
      expect(MCP101_GUIDE_METADATA[step]).toBeDefined();
    }
  });

  it("MCP101_STEP_ORDER matches expected step sequence", () => {
    expect(MCP101_STEP_ORDER).toEqual([
      "what_is_mcp",
      "why_standards",
      "architecture",
      "capabilities",
      "security",
    ]);
  });

  it("each step has required fields: title, summary, phase, teachableMoments, tips", () => {
    for (const step of MCP101_STEP_ORDER) {
      const guide = MCP101_GUIDE_METADATA[step];
      expect(guide.title).toBeTruthy();
      expect(guide.summary).toBeTruthy();
      expect(["fundamentals", "architecture", "capabilities", "security"]).toContain(
        guide.phase,
      );
      expect(guide.teachableMoments.length).toBeGreaterThan(0);
      expect(guide.tips.length).toBeGreaterThan(0);
    }
  });

  it("code examples are valid JSON strings where provided", () => {
    for (const step of MCP101_STEP_ORDER) {
      const guide = MCP101_GUIDE_METADATA[step];
      if (guide.codeExample) {
        expect(() => JSON.parse(guide.codeExample!)).not.toThrow();
      }
    }
  });

  it("tables have consistent column counts", () => {
    for (const step of MCP101_STEP_ORDER) {
      const guide = MCP101_GUIDE_METADATA[step];
      if (guide.table) {
        const headerCount = guide.table.headers.length;
        for (const row of guide.table.rows) {
          expect(row).toHaveLength(headerCount);
        }
      }
    }
  });

  it("what_is_mcp has a code example", () => {
    expect(MCP101_GUIDE_METADATA.what_is_mcp.codeExample).toBeTruthy();
  });

  it("architecture and capabilities steps have tables", () => {
    expect(MCP101_GUIDE_METADATA.architecture.table).toBeDefined();
    expect(MCP101_GUIDE_METADATA.capabilities.table).toBeDefined();
  });
});

describe("MCP101_PHASE_ACCENT", () => {
  it("has colors for all four phases", () => {
    expect(MCP101_PHASE_ACCENT.fundamentals).toBeTruthy();
    expect(MCP101_PHASE_ACCENT.architecture).toBeTruthy();
    expect(MCP101_PHASE_ACCENT.capabilities).toBeTruthy();
    expect(MCP101_PHASE_ACCENT.security).toBeTruthy();
  });
});
