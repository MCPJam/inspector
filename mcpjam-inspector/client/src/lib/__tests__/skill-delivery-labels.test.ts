import { describe, expect, it } from "vitest";
import { paneSkillReason } from "@/shared/pane-skills-preview";
import { skillExclusionLabel } from "../skill-delivery-labels";

describe("skillExclusionLabel", () => {
  it("never tells a client it doesn't support skills", () => {
    // Claude Code and Codex take skills yet still leave some out; the line
    // says what doesn't load on them instead.
    for (const reason of paneSkillReason.options) {
      for (const subject of [{}, { client: "Cursor", server: "Linear" }]) {
        const label = skillExclusionLabel(reason, subject);
        expect(label).toMatch(/^[A-Z].*\.$/);
        expect(label).not.toMatch(/support/i);
      }
    }
  });

  it("names the client and the MCP server a skill comes from", () => {
    expect(skillExclusionLabel("unsupported-harness")).toBe(
      "Skills don’t load on this client yet.",
    );
    expect(
      skillExclusionLabel("unsupported-harness", { client: "Cursor" }),
    ).toBe("Skills don’t load on Cursor yet.");
    expect(
      skillExclusionLabel("server-skill-unsupported", { server: "Linear" }),
    ).toBe("Skills from Linear don’t load on this client yet.");
    // A row from a server that predates origins names no server.
    expect(skillExclusionLabel("server-skill-unsupported")).toBe(
      "Skills from MCP servers don’t load on this client yet.",
    );
  });

  it("says a skill over a scope's cap doesn't load", () => {
    expect(skillExclusionLabel("over-cap")).toBe(
      "Over the skill limit, so it doesn’t load.",
    );
  });
});
