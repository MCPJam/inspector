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
  it("lists pinned skills from memory (no network)", async () => {
    const tools = createPinnedSkillTools(skills);
    const out = await run(tools.listSkills, {});
    expect(out).toContain("pdf-tools");
    expect(out).toContain("data-viz");
  });

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

  it("handles an empty pinned set", async () => {
    const tools = createPinnedSkillTools([]);
    expect(await run(tools.listSkills, {})).toBe(
      "No skills are available in this project.",
    );
  });

  it("pinned tools never call the network (no fetch)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch" as never);
    const tools = createPinnedSkillTools(skills);
    await run(tools.listSkills, {});
    await run(tools.loadSkill, { name: "pdf-tools" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("getPinnedSkillToolsAndPrompt returns tools + a skills prompt section", () => {
    const { tools, systemPromptSection } = getPinnedSkillToolsAndPrompt(skills);
    expect(tools.listSkills).toBeDefined();
    expect(tools.loadSkill).toBeDefined();
    expect(systemPromptSection).toContain("Skills");
  });
});
