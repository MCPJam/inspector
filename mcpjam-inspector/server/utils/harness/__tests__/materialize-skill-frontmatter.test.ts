import { describe, it, expect } from "vitest";
import matter from "gray-matter";
import { parse as parseYaml } from "yaml";
import { writeSkills } from "@ai-sdk/harness/utils";
import { planBoxSkills } from "../box-skills-writer";
import {
  generateSkillMdWithExtras,
  hasAllowedToolsGrant,
  materializeSkillFrontmatter,
  renderSkillMd,
  type FrontmatterSession,
} from "../materialize-skill-frontmatter";
import type { RuntimeSkill } from "../runtime-skills";
import { HARNESS_SKILLS } from "../skills-descriptor";

const SKILLS_BASE = "/home/user/.claude/skills";

/** A SKILL.md an earlier write left on a reused box, grant included. */
const STALE_GRANT_MD =
  '---\nname: git-helper\ndescription: "Git"\nlicense: "MIT"\nallowed-tools: ["Bash(*)"]\n---\n\nUse git.\n';
/** What the adapter writes: no extras, so no grant. */
const ADAPTER_MD = "---\nname: git-helper\ndescription: Git\n---\n\nUse git.\n";

/**
 * A box whose SKILL.md writes all fail. A read returns `onBox` unless
 * `readTextFile` is given; each command it runs is recorded.
 */
function failingWriteSession(
  opts: {
    onBox?: string | null;
    readTextFile?: FrontmatterSession["readTextFile"];
    run?: FrontmatterSession["run"];
  } = {},
) {
  const commands: string[] = [];
  const session: FrontmatterSession = {
    writeTextFile: async () => {
      throw new Error("box unreachable");
    },
    readTextFile: opts.readTextFile ?? (async () => opts.onBox ?? null),
    run: async (args) => {
      commands.push(args.command);
      return opts.run
        ? opts.run(args)
        : { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return { session, commands };
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

describe("hasAllowedToolsGrant", () => {
  it.each([
    ["a block mapping with a flow list", STALE_GRANT_MD, true],
    [
      "a comma string",
      "---\nname: s\ndescription: d\nallowed-tools: Bash, Read\n---\n\nc\n",
      true,
    ],
    [
      "a flow mapping",
      "---\n{name: s, description: d, allowed-tools: [Bash]}\n---\n\nc\n",
      true,
    ],
    [
      "a quoted key",
      '---\nname: s\n"allowed-tools": ["Read"]\n---\n\nc\n',
      true,
    ],
    [
      "a single-quoted, upper-case key",
      "---\nname: s\n'ALLOWED-TOOLS': Read\n---\n\nc\n",
      true,
    ],
    [
      "the camelCase key",
      "---\nname: s\nallowedTools: [Read]\n---\n\nc\n",
      true,
    ],
    [
      "the underscore key",
      "---\nname: s\nallowed_tools: Read\n---\n\nc\n",
      true,
    ],
    [
      "a merge key",
      "---\nbase: &b {allowed-tools: [Bash]}\nname: s\n<<: *b\n---\n\nc\n",
      true,
    ],
    ["the adapter's SKILL.md", ADAPTER_MD, false],
    [
      "the key only in the body",
      "---\nname: s\ndescription: d\n---\n\nallowed-tools: Read\n",
      false,
    ],
    [
      "the key only nested under metadata",
      '---\nname: s\nmetadata: {"allowed-tools": "Read"}\n---\n\nc\n',
      false,
    ],
  ])("finds the grant in %s", (_, md, expected) => {
    expect(hasAllowedToolsGrant(md)).toBe(expected);
  });

  it.each([
    ["malformed YAML", "---\nname: [unclosed\n---\n\nc\n"],
    ["duplicate keys", "---\nname: s\nname: t\n---\n\nc\n"],
    ["a list, not a mapping", "---\n- allowed-tools\n---\n\nc\n"],
    ["a scalar, not a mapping", "---\njust text\n---\n\nc\n"],
    ["no frontmatter block", "allowed-tools: Read\n"],
    [
      "an opening line with a language marker",
      "---js\n({ name: 's' })\n---\n",
    ],
  ])("fails closed on %s", (_, md) => {
    expect(hasAllowedToolsGrant(md)).toBe(true);
  });
});

const RULES = HARNESS_SKILLS["claude-code"].frontmatter;

/** A box holding `files`, whose writes land in the same map. */
function boxSession(files: Record<string, string> = {}) {
  const box = new Map(Object.entries(files));
  const writes: string[] = [];
  const session: FrontmatterSession = {
    writeTextFile: async ({ path, content }) => {
      writes.push(path);
      box.set(path, content);
    },
    readTextFile: async ({ path }) => box.get(path) ?? null,
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
  return { session, box, writes };
}

describe("materializeSkillFrontmatter", () => {
  const settle = (
    session: FrontmatterSession,
    skills: RuntimeSkill[],
    skillsBase = SKILLS_BASE,
  ) =>
    materializeSkillFrontmatter({ session, skills, skillsBase, rules: RULES });

  it("writes each SKILL.md that differs from what MCPJam renders, and no other", async () => {
    const plain = skill({ skillId: "sk_1", name: "plain" });
    const { session, box, writes } = boxSession({
      [`${SKILLS_BASE}/plain/SKILL.md`]: renderSkillMd(plain, RULES),
    });
    const res = await settle(session, [
      plain,
      skill({
        skillId: "sk_2",
        name: "with-extras",
        extraFrontmatter: { license: "MIT", allowedTools: ["Read"] },
      }),
    ]);
    expect(res).toEqual({ rewritten: 1, skipped: 0, removed: new Map() });
    expect(writes).toEqual([`${SKILLS_BASE}/with-extras/SKILL.md`]);
    const written = box.get(`${SKILLS_BASE}/with-extras/SKILL.md`)!;
    expect(written).toContain('license: "MIT"');
    expect(written).not.toContain("allowed-tools");
  });

  it("takes out a grant an earlier write left on a skill whose extras are now gone", async () => {
    // The stored skill has no extras left, so the adapter's hash is the same
    // as when the box got the file and the adapter leaves it alone.
    const path = `${SKILLS_BASE}/git-helper/SKILL.md`;
    const { session, box } = boxSession({ [path]: STALE_GRANT_MD });
    const gitHelper = skill({
      name: "git-helper",
      description: "Git",
      content: "Use git.",
    });
    const res = await settle(session, [gitHelper]);
    expect(res.rewritten).toBe(1);
    expect(box.get(path)).toBe(
      '---\nname: git-helper\ndescription: "Git"\n---\n\nUse git.\n',
    );
  });

  it("takes out a grant something on the box added since the last turn", async () => {
    const gitHelper = skill({ name: "git-helper", content: "Use git." });
    const path = `${SKILLS_BASE}/git-helper/SKILL.md`;
    const tampered = renderSkillMd(gitHelper, RULES).replace(
      "\n---\n",
      '\nallowed-tools: ["Bash(*)"]\n---\n',
    );
    const { session, box } = boxSession({ [path]: tampered });
    await settle(session, [gitHelper]);
    expect(hasAllowedToolsGrant(box.get(path)!)).toBe(false);
  });

  it("writes under the runtime's own folder (codex)", async () => {
    const { session, writes } = boxSession();
    await settle(
      session,
      [skill({ name: "pdf-tools" })],
      "/home/user/.agents/skills",
    );
    expect(writes).toEqual(["/home/user/.agents/skills/pdf-tools/SKILL.md"]);
  });

  it("is fail-soft: a failed write that leaves a file with no grant keeps the skill", async () => {
    const { session, commands } = failingWriteSession({ onBox: ADAPTER_MD });
    const res = await settle(session, [
      skill({ name: "git-helper", extraFrontmatter: { license: "MIT" } }),
    ]);
    expect(res).toEqual({ rewritten: 0, skipped: 1, removed: new Map() });
    expect(commands).toEqual([]);
  });

  it.each([
    ["still lists allowed-tools", STALE_GRANT_MD],
    // A grant can't be ruled out, so the file counts as one.
    [
      "has frontmatter that doesn't parse",
      '---\nname: git-helper\nallowed-tools: ["Bash(*)"\n---\n\nUse git.\n',
    ],
  ])(
    "takes the skill off the box when its write fails and the box's SKILL.md %s",
    async (_, onBox) => {
      const { session, commands } = failingWriteSession({ onBox });
      const res = await settle(session, [
        skill({ name: "git-helper", extraFrontmatter: { license: "MIT" } }),
      ]);
      expect([...res.removed.keys()]).toEqual(["git-helper"]);
      expect(commands).toEqual([`rm -rf -- '${SKILLS_BASE}/git-helper'`]);
    },
  );

  it("leaves the skill alone when its write fails and the box holds no SKILL.md", async () => {
    const { session, commands } = failingWriteSession({ onBox: null });
    const res = await settle(session, [skill({ name: "git-helper" })]);
    expect(res.removed).toEqual(new Map());
    expect(commands).toEqual([]);
  });

  it("stops the turn when its write fails and the box's SKILL.md can't be read", async () => {
    const { session, commands } = failingWriteSession({
      readTextFile: async () => {
        throw new Error("box unreachable");
      },
    });
    await expect(
      settle(session, [skill({ name: "git-helper" })]),
    ).rejects.toThrow('Could not update or read the skill "git-helper"');
    expect(commands).toEqual([]);
  });

  it.each([
    [
      "exits non-zero",
      async () => ({ exitCode: 1, stdout: "", stderr: "Permission denied" }),
    ],
    [
      "throws",
      async () => {
        throw new Error("box unreachable");
      },
    ],
  ])(
    "stops the turn when removing a skill that still grants tools %s",
    async (_, run) => {
      const { session, commands } = failingWriteSession({
        onBox: STALE_GRANT_MD,
        run,
      });
      await expect(
        settle(session, [skill({ name: "git-helper" })]),
      ).rejects.toThrow('Could not update or remove the skill "git-helper"');
      expect(commands).toEqual([`rm -rf -- '${SKILLS_BASE}/git-helper'`]);
    },
  );

  it("never interpolates an invalid skill name into a box path", async () => {
    const { session, writes } = boxSession();
    const res = await settle(session, [skill({ name: "../escape" })]);
    expect(res.rewritten).toBe(0);
    expect(writes).toHaveLength(0);
  });
});

describe("renderSkillMd, by the runtime's frontmatter rules", () => {
  it("renders exactly what Claude Code's adapter writes for a skill with no extras", async () => {
    // The adapter writes its `skills` param; the box writer's SKILL.md step
    // then has nothing to rewrite for such a skill.
    const pdf = skill({ description: 'Process "PDFs"\nsafely' });
    const { session, box } = boxSession();
    const claude = HARNESS_SKILLS["claude-code"];
    await writeSkills({
      sandbox: session as never,
      homePath: "/home/user",
      skillsDir: claude.writeFolder,
      skills: planBoxSkills(claude, [pdf]).payload,
      trailingNewline: claude.trailingNewline,
    });
    expect(box.get(`${SKILLS_BASE}/pdf-tools/SKILL.md`)).toBe(
      renderSkillMd(pdf, claude.frontmatter),
    );
  });

  it("cuts the description to the runtime's limit", () => {
    const text = renderSkillMd(skill({ description: "x".repeat(2000) }), {
      ...RULES,
      descriptionMaxLength: 1024,
    });
    expect(matter(text).data.description).toHaveLength(1024);
  });

  it("adds Cursor's surface to a skill that lists surfaces without it", () => {
    const rules = HARNESS_SKILLS.cursor.frontmatter;
    const render = (surfaces: string) =>
      matter(
        renderSkillMd(
          skill({ extraFrontmatter: { metadata: { surfaces, team: "docs" } } }),
          rules,
        ),
      ).data.metadata;
    expect(render("ide")).toEqual({ surfaces: "ide,cli", team: "docs" });
    expect(render("cli, ide")).toEqual({ surfaces: "cli, ide", team: "docs" });
    // No surfaces: Cursor loads the skill everywhere already.
    expect(
      matter(
        renderSkillMd(skill({ extraFrontmatter: { license: "MIT" } }), rules),
      ).data.metadata,
    ).toBeUndefined();
  });

  it.each(
    Object.entries(HARNESS_SKILLS).filter(
      ([, descriptor]) => descriptor.frontmatter.strictYaml,
    ),
  )("writes frontmatter %s's strict YAML parser accepts", (_, descriptor) => {
    const text = renderSkillMd(
      skill({
        description: 'Use when: "quoted"\n\ttabbed \\ and a # not a comment',
        extraFrontmatter: {
          license: "MIT: see LICENSE",
          compatibility: "node >= 20, - not a list",
          metadata: {
            "key: with colon": "value, with [brackets] {and braces}",
          },
        },
      }),
      descriptor.frontmatter,
    );
    const block = /^---\n([\s\S]*?)\n---\n/.exec(text)![1]!;
    expect(() =>
      parseYaml(block, { strict: true, uniqueKeys: true }),
    ).not.toThrow();
    expect(parseYaml(block)).toMatchObject({
      description: 'Use when: "quoted"\n\ttabbed \\ and a # not a comment',
      metadata: { "key: with colon": "value, with [brackets] {and braces}" },
    });
  });
});
