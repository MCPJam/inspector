import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../logger", () => ({
  logger: mockLogger,
}));

import { generateSkillFileContent, parseSkillFile } from "../skill-parser";

const UNPARSEABLE = "---\nname: my-skill\ndescription: [unclosed\n---\nBody\n";

describe("parseSkillFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it("warns without a Sentry capture when the frontmatter cannot be parsed", () => {
    const skill = parseSkillFile(UNPARSEABLE, "my-skill/SKILL.md");

    expect(skill).toBeNull();
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "[skills] SKILL.md frontmatter could not be parsed",
    );
  });

  it("gives the same warning when the same file is scanned again", () => {
    parseSkillFile(UNPARSEABLE, "my-skill/SKILL.md");
    parseSkillFile(UNPARSEABLE, "my-skill/SKILL.md");

    expect(mockLogger.warn.mock.calls).toEqual([
      ["[skills] SKILL.md frontmatter could not be parsed"],
      ["[skills] SKILL.md frontmatter could not be parsed"],
    ]);
  });
});

describe("generateSkillFileContent", () => {
  it("writes a description with a colon that parses back unchanged", () => {
    const fileContent = generateSkillFileContent(
      "weather",
      "Fetches: weather data",
      "Body",
    );

    expect(parseSkillFile(fileContent, "weather/SKILL.md")).toEqual({
      name: "weather",
      description: "Fetches: weather data",
      content: "Body",
      path: "weather/SKILL.md",
    });
  });
});
