import { describe, expect, it, vi } from "vitest";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../logger", () => ({
  logger: mockLogger,
}));

import { parseSkillFile } from "../skill-parser";

describe("parseSkillFile", () => {
  it("returns the skill for valid frontmatter", () => {
    const skill = parseSkillFile(
      "---\nname: my-skill\ndescription: Does a thing\n---\nBody\n",
      "my-skill/SKILL.md",
    );

    expect(skill).toEqual({
      name: "my-skill",
      description: "Does a thing",
      content: "Body",
      path: "my-skill/SKILL.md",
    });
  });

  it("warns without a Sentry capture when the frontmatter is not valid YAML", () => {
    const skill = parseSkillFile(
      "---\nname: my-skill\ndescription: [unclosed\n---\nBody\n",
      "my-skill/SKILL.md",
    );

    expect(skill).toBeNull();
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Skill at my-skill/SKILL.md has unparseable frontmatter",
      { error: expect.any(String) },
    );
  });
});
