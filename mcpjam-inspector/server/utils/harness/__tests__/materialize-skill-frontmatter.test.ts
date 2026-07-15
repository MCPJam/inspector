import { describe, it, expect } from "vitest";
import {
  generateSkillMdWithExtras,
  materializeSkillFrontmatter,
  type FrontmatterSession,
} from "../materialize-skill-frontmatter";
import type { RuntimeSkill } from "../runtime-skills";

const SKILLS_BASE = "/home/user/.claude/skills";

function fakeSession() {
  const writes: { path: string; content: string }[] = [];
  const session: FrontmatterSession = {
    writeTextFile: async (args) => {
      writes.push(args);
    },
  };
  return { session, writes };
}

const skill = (over: Partial<RuntimeSkill>): RuntimeSkill => ({
  skillId: "sk_1",
  name: "pdf-tools",
  description: "Process PDFs",
  content: "Do the thing.",
  aggregateHash: "h",
  ...over,
});

describe("generateSkillMdWithExtras", () => {
  it("byte-mirrors the backend generateSkillMd for a full-extras fixture", () => {
    // Assert against a LITERAL — this is the backend `generateSkillMd`
    // emission format (convex/lib/projectSkillValidation.ts). If this test
    // breaks, the backend format moved and the rewrite must move with it.
    const md = generateSkillMdWithExtras({
      name: "pdf-tools",
      description: 'Process: PDFs "safely"\nEven multiline\ttabbed',
      content: "# PDF tools\n\nUse the scripts.",
      extraFrontmatter: {
        license: 'MIT "or later"',
        compatibility: "claude-code >= 1.0",
        allowedTools: ["Bash(git:*)", "Read"],
        metadata: { author: "acme", tier: "gold" },
      },
    });
    expect(md).toBe(
      "---\n" +
        "name: pdf-tools\n" +
        'description: "Process: PDFs \\"safely\\"\\nEven multiline\\ttabbed"\n' +
        'license: "MIT \\"or later\\""\n' +
        'compatibility: "claude-code >= 1.0"\n' +
        'allowed-tools: ["Bash(git:*)","Read"]\n' +
        'metadata: {"author":"acme","tier":"gold"}\n' +
        "---\n" +
        "\n" +
        "# PDF tools\n\nUse the scripts.\n",
    );
  });

  it("strips \\r like the backend (not \\\\r-escaped)", () => {
    const md = generateSkillMdWithExtras({
      name: "s",
      description: "line one\r\nline two",
      content: "c",
    });
    expect(md).toContain('description: "line one\\nline two"');
  });

  it("omits extras lines entirely when extraFrontmatter is absent", () => {
    const md = generateSkillMdWithExtras({
      name: "s",
      description: "d",
      content: "c",
    });
    expect(md).toBe('---\nname: s\ndescription: "d"\n---\n\nc\n');
  });

  it("emits only the extras fields that are present, in backend order", () => {
    const md = generateSkillMdWithExtras({
      name: "s",
      description: "d",
      content: "c",
      extraFrontmatter: { allowedTools: ["Read"] },
    });
    expect(md).toBe(
      '---\nname: s\ndescription: "d"\nallowed-tools: ["Read"]\n---\n\nc\n',
    );
  });
});

describe("materializeSkillFrontmatter", () => {
  it("rewrites SKILL.md only for skills WITH extras (zero calls otherwise)", async () => {
    const { session, writes } = fakeSession();
    const res = await materializeSkillFrontmatter({
      session,
      skills: [
        skill({ skillId: "sk_1", name: "plain" }),
        skill({
          skillId: "sk_2",
          name: "with-extras",
          extraFrontmatter: { allowedTools: ["Read"] },
        }),
        // An empty extras object counts as "no extras" (backend never emits it).
        skill({ skillId: "sk_3", name: "empty-extras", extraFrontmatter: {} }),
      ],
    });
    expect(res).toEqual({ rewritten: 1, skipped: 0 });
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(`${SKILLS_BASE}/with-extras/SKILL.md`);
    expect(writes[0].content).toContain('allowed-tools: ["Read"]');
  });

  it("makes no session call when no skill has extras", async () => {
    const { session, writes } = fakeSession();
    const res = await materializeSkillFrontmatter({
      session,
      skills: [skill({}), skill({ skillId: "sk_2", name: "other" })],
    });
    expect(res).toEqual({ rewritten: 0, skipped: 0 });
    expect(writes).toHaveLength(0);
  });

  it("is fail-soft: a write error skips that skill, never throws", async () => {
    const writes: string[] = [];
    const session: FrontmatterSession = {
      writeTextFile: async ({ path }) => {
        if (path.includes("/boom/")) throw new Error("box unreachable");
        writes.push(path);
      },
    };
    const res = await materializeSkillFrontmatter({
      session,
      skills: [
        skill({
          skillId: "sk_1",
          name: "boom",
          extraFrontmatter: { license: "MIT" },
        }),
        skill({
          skillId: "sk_2",
          name: "fine",
          extraFrontmatter: { license: "MIT" },
        }),
      ],
    });
    expect(res).toEqual({ rewritten: 1, skipped: 1 });
    expect(writes).toEqual([`${SKILLS_BASE}/fine/SKILL.md`]);
  });

  it("never interpolates an invalid skill name into a box path", async () => {
    const { session, writes } = fakeSession();
    const res = await materializeSkillFrontmatter({
      session,
      skills: [
        skill({
          name: "../escape",
          extraFrontmatter: { license: "MIT" },
        }),
      ],
    });
    expect(res).toEqual({ rewritten: 0, skipped: 1 });
    expect(writes).toHaveLength(0);
  });
});
