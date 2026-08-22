import { describe, it, expect, vi } from "vitest";
import {
  createPinnedSkillTools,
  getPinnedSkillToolsAndPrompt,
} from "../cloud-skill-tools";
import type { PinnableSkill } from "../../../../shared/skill-types";

const skills: PinnableSkill[] = [
  {
    name: "pdf-tools",
    description: "Process PDFs",
    content: "Step 1. Extract text.",
    contentHash: "h1",
  },
  {
    name: "data-viz",
    description: "Make charts",
    content: "Use a bar chart.",
    contentHash: "h2",
  },
];

async function run(tool: any, input: unknown): Promise<string> {
  return (await tool.execute(input)) as string;
}

describe("createPinnedSkillTools", () => {
  it("loads a skill's frozen content by name", async () => {
    const tools = createPinnedSkillTools(skills);
    const out = await run(tools.loadSkill, { name: "pdf-tools" });
    expect(out).toBe("# Skill: pdf-tools\n\nStep 1. Extract text.");
  });

  it("returns the same not-found / invalid-name error strings as live", async () => {
    const tools = createPinnedSkillTools(skills);
    expect(await run(tools.loadSkill, { name: "missing" })).toBe(
      'Error: Skill "missing" not found.',
    );
    expect(await run(tools.loadSkill, { name: "BAD NAME" })).toContain(
      "Invalid skill name format",
    );
  });

  it("does not advertise listSkills", () => {
    const tools = createPinnedSkillTools(skills);
    expect(tools).not.toHaveProperty("listSkills");
  });

  it("pinned tools never call the network (no fetch)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch" as never);
    const tools = createPinnedSkillTools(skills);
    await run(tools.loadSkill, { name: "pdf-tools" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("getPinnedSkillToolsAndPrompt", () => {
  it("inlines a sorted catalog and advertises loadSkill, not listSkills", () => {
    const { tools, systemPromptSection } = getPinnedSkillToolsAndPrompt(skills);
    expect(tools.loadSkill).toBeDefined();
    expect(tools).not.toHaveProperty("listSkills");
    expect(systemPromptSection).toContain("## Skills");
    expect(systemPromptSection).toContain("loadSkill");
    expect(systemPromptSection).toContain("- **data-viz**: Make charts");
    expect(systemPromptSection).toContain("- **pdf-tools**: Process PDFs");
    // Sorted by name: data-viz before pdf-tools.
    expect(systemPromptSection.indexOf("data-viz")).toBeLessThan(
      systemPromptSection.indexOf("pdf-tools")
    );
    // Pinned skills are file-free (decision 8c) — the prompt must NOT advertise
    // the file tools the pinned tool set doesn't expose.
    expect(systemPromptSection).not.toContain("listSkillFiles");
    expect(systemPromptSection).not.toContain("readSkillFile");
    expect(tools).not.toHaveProperty("listSkillFiles");
  });

  it("returns empty tools and no stanza for an empty pinned set", () => {
    const { tools, systemPromptSection } = getPinnedSkillToolsAndPrompt([]);
    expect(tools).toEqual({});
    expect(systemPromptSection).toBe("");
  });

  it("budgets the inlined catalog and reports overflow", () => {
    const many: PinnableSkill[] = Array.from({ length: 40 }, (_, index) => ({
      name: `skill-${String(index).padStart(2, "0")}`,
      description: "d".repeat(400),
      content: "body",
      contentHash: `h${index}`,
    }));
    const { systemPromptSection } = getPinnedSkillToolsAndPrompt(many, {
      modelContextTokens: 1_000,
    });
    expect(systemPromptSection).toMatch(
      /could not be listed within this model's skill-metadata budget/
    );
  });
});
