import { describe, it, expect } from "vitest";
import matter from "gray-matter";
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
  it("mirrors the backend generateSkillMd for a full-extras fixture, minus allowed-tools", () => {
    // Assert against a LITERAL — this is the backend `generateSkillMd`
    // emission format (convex/lib/projectSkillValidation.ts). If this test
    // breaks, the backend format moved and the rewrite must move with it.
    // The one difference is deliberate: `allowed-tools` never reaches a box.
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
        'metadata: {"author":"acme","tier":"gold"}\n' +
        "---\n" +
        "\n" +
        "# PDF tools\n\nUse the scripts.\n",
    );
  });

  it("RATCHET: emits only name, description and the kept extras, whatever the wire carries", () => {
    // These keys change what a runtime does with a skill (`hooks` runs
    // commands, `model`/`agent`/`context` pick who runs it and where), and
    // `allowed-tools` pre-approves tools. The backend never stores the first
    // four, but the rewrite must not depend on that: a drifted wire object,
    // or a value carrying a newline, must not put any of them on the box.
    const drifted = {
      license: "MIT\nmodel: opus",
      metadata: { owner: "acme" },
      allowedTools: ["Bash(*)"],
      "allowed-tools": ["Bash(*)"],
      hooks: { PreToolUse: [{ matcher: "*", hooks: [] }] },
      model: "opus",
      agent: "general-purpose",
      context: "fork",
    };
    const md = generateSkillMdWithExtras({
      name: "s",
      description: "d\ncontext: fork",
      content: "c",
      extraFrontmatter: drifted,
    });
    const { data } = matter(md);
    expect(Object.keys(data).sort()).toEqual([
      "description",
      "license",
      "metadata",
      "name",
    ]);
    for (const key of [
      "hooks",
      "model",
      "agent",
      "context",
      "allowed-tools",
      "allowedTools",
    ]) {
      expect(md).not.toMatch(new RegExp(`^${key}:`, "m"));
    }
    expect(data.license).toBe("MIT\nmodel: opus");
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
      extraFrontmatter: { metadata: { tier: "gold" }, compatibility: "any" },
    });
    expect(md).toBe(
      '---\nname: s\ndescription: "d"\ncompatibility: "any"\nmetadata: {"tier":"gold"}\n---\n\nc\n',
    );
  });

  it("drops allowed-tools when it is the only extra", () => {
    const md = generateSkillMdWithExtras({
      name: "s",
      description: "d",
      content: "c",
      extraFrontmatter: { allowedTools: ["Read"] },
    });
    expect(md).toBe('---\nname: s\ndescription: "d"\n---\n\nc\n');
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
          extraFrontmatter: { license: "MIT", allowedTools: ["Read"] },
        }),
        // An empty extras object counts as "no extras" (backend never emits it).
        skill({ skillId: "sk_3", name: "empty-extras", extraFrontmatter: {} }),
      ],
    });
    expect(res).toEqual({ rewritten: 1, skipped: 0 });
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(`${SKILLS_BASE}/with-extras/SKILL.md`);
    expect(writes[0].content).toContain('license: "MIT"');
    expect(writes[0].content).not.toContain("allowed-tools");
  });

  it("rewrites a skill whose only extra is allowedTools, so a reused box drops the line", async () => {
    // A box reused across turns can still hold a SKILL.md an earlier rewrite
    // wrote WITH `allowed-tools`. The adapter leaves a hash-unchanged skill
    // alone, so only this pass can take the line out.
    const path = `${SKILLS_BASE}/git-helper/SKILL.md`;
    const box = new Map([
      [
        path,
        '---\nname: git-helper\ndescription: "Git"\nallowed-tools: ["Bash(*)"]\n---\n\nUse git.\n',
      ],
    ]);
    const session: FrontmatterSession = {
      writeTextFile: async (args) => {
        box.set(args.path, args.content);
      },
    };
    const res = await materializeSkillFrontmatter({
      session,
      skills: [
        skill({
          name: "git-helper",
          description: "Git",
          content: "Use git.",
          extraFrontmatter: { allowedTools: ["Bash(*)"] },
        }),
      ],
    });
    expect(res).toEqual({ rewritten: 1, skipped: 0 });
    expect(box.get(path)).toBe(
      '---\nname: git-helper\ndescription: "Git"\n---\n\nUse git.\n',
    );
  });

  it("rewrites under the runtime's own root when given one (codex)", async () => {
    // The rewrite REPLACES the SKILL.md the adapter just wrote. Aiming it at
    // the Claude root during a Codex turn would leave codex's file (without
    // extras) in place and drop a stray file the CLI never reads.
    const { session, writes } = fakeSession();
    const res = await materializeSkillFrontmatter({
      session,
      skills: [
        skill({
          skillId: "sk_1",
          name: "with-extras",
          extraFrontmatter: { allowedTools: ["Read"] },
        }),
      ],
      skillsBase: "/home/user/.agents/skills",
    });
    expect(res).toEqual({ rewritten: 1, skipped: 0 });
    expect(writes[0].path).toBe(
      "/home/user/.agents/skills/with-extras/SKILL.md"
    );
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
