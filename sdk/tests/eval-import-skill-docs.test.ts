import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const skillDir = fileURLToPath(
  new URL("../../skills/mcpjam-eval-import/", import.meta.url)
);
const markdownPaths = [
  path.join(skillDir, "SKILL.md"),
  path.join(skillDir, "references/promptfoo-yaml.md"),
  path.join(skillDir, "references/pytest.md"),
  path.join(skillDir, "references/jest.md"),
  path.join(skillDir, "references/csv.md"),
];

describe("MCP eval import skill documentation", () => {
  it("keeps every fenced YAML example syntactically valid", async () => {
    for (const markdownPath of markdownPaths) {
      const relativePath = path.relative(skillDir, markdownPath);
      const markdown = await readFile(markdownPath, "utf8");
      const blocks = [...markdown.matchAll(/^```yaml\n([\s\S]*?)^```/gm)];
      expect(blocks.length, relativePath).toBeGreaterThan(0);

      for (const [index, block] of blocks.entries()) {
        const document = parseDocument(block[1]);
        expect(
          document.errors,
          `${relativePath} YAML block ${index + 1}`
        ).toHaveLength(0);
      }
    }
  });
});
