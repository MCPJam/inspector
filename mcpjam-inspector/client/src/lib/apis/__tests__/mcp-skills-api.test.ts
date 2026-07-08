import { describe, it, expect } from "vitest";
import { buildSkillFileTree } from "../mcp-skills-api";

const meta = (path: string, size = 10) => ({
  path,
  size,
  contentHash: "h",
  updatedAt: 0,
});

describe("buildSkillFileTree", () => {
  it("always includes SKILL.md first", () => {
    const tree = buildSkillFileTree([]);
    expect(tree[0]).toMatchObject({ name: "SKILL.md", type: "file" });
  });

  it("nests directories from flat paths", () => {
    const tree = buildSkillFileTree([
      meta("scripts/run.py"),
      meta("scripts/lib/util.py"),
      meta("refs/guide.md"),
    ]);
    const byName = Object.fromEntries(tree.map((n) => [n.name, n]));
    expect(byName["scripts"].type).toBe("directory");
    // scripts/ has run.py + a nested lib/ directory.
    const scriptsChildren = byName["scripts"].children!;
    expect(scriptsChildren.some((c) => c.name === "run.py")).toBe(true);
    const lib = scriptsChildren.find((c) => c.name === "lib");
    expect(lib?.type).toBe("directory");
    expect(lib?.children?.[0].name).toBe("util.py");
    expect(byName["refs"].children?.[0].name).toBe("guide.md");
  });

  it("carries file size and extension on leaf nodes", () => {
    const tree = buildSkillFileTree([meta("a/data.json", 42)]);
    const file = tree.find((n) => n.name === "a")!.children![0];
    expect(file).toMatchObject({
      name: "data.json",
      type: "file",
      size: 42,
      extension: ".json",
    });
  });
});
