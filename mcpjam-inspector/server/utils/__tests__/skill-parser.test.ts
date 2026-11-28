import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLogger } = vi.hoisted(() => ({
  mockLogger: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../logger", () => ({
  logger: mockLogger,
}));

import { readSkillDocument } from "../../../shared/skill-document";
import { generateSkillFileContent, parseSkillFile } from "../skill-parser";

const INVALID_YAML = "---\nname: my-skill\ndescription: [unclosed\n---\nBody\n";
// 101 references to one anchor: the YAML library refuses to expand them.
const ALIAS_BOMB = `---\nname: &n my-skill\ndescription: x\nrefs: [${Array(101).fill("*n").join(", ")}]\n---\nBody\n`;

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

  it("warns without a Sentry capture when the frontmatter cannot be expanded", () => {
    const skill = parseSkillFile(ALIAS_BOMB, "my-skill/SKILL.md");

    expect(skill).toBeNull();
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "[skills] SKILL.md frontmatter could not be parsed",
    );
  });

  it("drops invalid YAML with the same warning on every scan", () => {
    expect(parseSkillFile(INVALID_YAML, "my-skill/SKILL.md")).toBeNull();
    expect(parseSkillFile(INVALID_YAML, "my-skill/SKILL.md")).toBeNull();

    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn.mock.calls[1]).toEqual(
      mockLogger.warn.mock.calls[0],
    );
  });

  it("never runs a ---js frontmatter block", () => {
    const evaluated = globalThis as { skillFrontmatterRan?: boolean };
    const skill = parseSkillFile(
      "---js\n(globalThis.skillFrontmatterRan = true, { name: 'my-skill', description: 'x' })\n---\nBody\n",
      "my-skill/SKILL.md",
    );

    expect(skill).toBeNull();
    expect(evaluated.skillFrontmatterRan).toBeUndefined();
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

  it("writes names that YAML 1.2 reads as other types so they parse back as strings", () => {
    for (const name of ["0o12", "123", "null", "on"]) {
      const fileContent = generateSkillFileContent(
        name,
        "Does a thing",
        "Body",
      );

      expect(parseSkillFile(fileContent, `${name}/SKILL.md`)?.name).toBe(name);
    }
  });

  it("writes frontmatter the upload dialog's reader returns unchanged", () => {
    const description = "Fetches: weather data. ".repeat(10).trim();
    const fileContent = generateSkillFileContent("on", description, "Body");

    expect(readSkillDocument(fileContent).frontmatter).toEqual({
      name: "on",
      description,
    });
    expect(fileContent).not.toContain(">-");
  });

  it("writes a ---javascript body as text without running it", () => {
    const evaluated = globalThis as { skillBodyRan?: boolean };
    const body =
      "---javascript\n(globalThis.skillBodyRan = true, {})\n---\nBody";
    const fileContent = generateSkillFileContent("weather", "Weather", body);

    expect(evaluated.skillBodyRan).toBeUndefined();
    expect(parseSkillFile(fileContent, "weather/SKILL.md")?.content).toBe(body);
  });

  it("keeps a body that opens with its own --- block as written", () => {
    const body = "---\nauthor: someone\n---\nBody";
    const fileContent = generateSkillFileContent("weather", "Weather", body);

    expect(parseSkillFile(fileContent, "weather/SKILL.md")).toEqual({
      name: "weather",
      description: "Weather",
      content: body,
      path: "weather/SKILL.md",
    });
  });
});
