import { describe, it, expect } from "vitest";
import matter from "gray-matter";
import {
  generateSkillMdWithExtras,
  hasAllowedToolsGrant,
  materializeSkillFrontmatter,
  type FrontmatterSession,
} from "../materialize-skill-frontmatter";
import type { RuntimeSkill } from "../runtime-skills";

const SKILLS_BASE = "/home/user/.claude/skills";

/** A SKILL.md an earlier write left on a reused box, grant included. */
const STALE_GRANT_MD =
  '---\nname: git-helper\ndescription: "Git"\nlicense: "MIT"\nallowed-tools: ["Bash(*)"]\n---\n\nUse git.\n';
/** What the adapter writes: no extras, so no grant. */
const ADAPTER_MD = "---\nname: git-helper\ndescription: Git\n---\n\nUse git.\n";

function fakeSession() {
  const writes: { path: string; content: string }[] = [];
  const session: FrontmatterSession = {
    writeTextFile: async (args) => {
      writes.push(args);
    },
    readTextFile: async () => null,
    run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  };
  return { session, writes };
}

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
      readTextFile: async (args) => box.get(args.path) ?? null,
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
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
    // The SKILL.md left on the box grants nothing, so the failed write needs
    // no removal and no thrown error.
    const writes: string[] = [];
    const commands: string[] = [];
    const session: FrontmatterSession = {
      writeTextFile: async ({ path }) => {
        if (path.includes("/boom/")) throw new Error("box unreachable");
        writes.push(path);
      },
      readTextFile: async () => ADAPTER_MD,
      run: async ({ command }) => {
        commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
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
    expect(commands).toEqual([]);
  });

  it("removes the skill when its rewrite fails and the box's SKILL.md still lists allowed-tools", async () => {
    // The stored extras no longer have `allowedTools`, but only the extras
    // changed, so the adapter left the file an earlier write put there. The
    // file on the box decides, and the skill comes off the box.
    const { session, commands } = failingWriteSession({
      onBox: STALE_GRANT_MD,
    });
    const res = await materializeSkillFrontmatter({
      session,
      skills: [
        skill({ name: "git-helper", extraFrontmatter: { license: "MIT" } }),
      ],
    });
    expect(res).toEqual({ rewritten: 0, skipped: 1 });
    expect(commands).toEqual([`rm -rf -- '${SKILLS_BASE}/git-helper'`]);
  });

  it("removes the skill when its rewrite fails and the box's SKILL.md frontmatter doesn't parse", async () => {
    // A grant can't be ruled out, so the file counts as one.
    const { session, commands } = failingWriteSession({
      onBox:
        '---\nname: git-helper\nallowed-tools: ["Bash(*)"\n---\n\nUse git.\n',
    });
    const res = await materializeSkillFrontmatter({
      session,
      skills: [
        skill({ name: "git-helper", extraFrontmatter: { license: "MIT" } }),
      ],
    });
    expect(res).toEqual({ rewritten: 0, skipped: 1 });
    expect(commands).toEqual([`rm -rf -- '${SKILLS_BASE}/git-helper'`]);
  });

  it.each([
    ["the adapter's SKILL.md", ADAPTER_MD],
    ["no SKILL.md", null],
  ])(
    "leaves the skill alone when its rewrite fails and the box holds %s",
    async (_, onBox) => {
      // Stored `allowedTools` alone doesn't remove anything: the box grants
      // nothing, so the turn keeps the skill.
      const { session, commands } = failingWriteSession({ onBox });
      const res = await materializeSkillFrontmatter({
        session,
        skills: [
          skill({
            name: "git-helper",
            extraFrontmatter: { allowedTools: ["Bash(*)"] },
          }),
        ],
      });
      expect(res).toEqual({ rewritten: 0, skipped: 1 });
      expect(commands).toEqual([]);
    },
  );

  it("stops the turn when its rewrite fails and the box's SKILL.md can't be read", async () => {
    const { session, commands } = failingWriteSession({
      readTextFile: async () => {
        throw new Error("box unreachable");
      },
    });
    await expect(
      materializeSkillFrontmatter({
        session,
        skills: [
          skill({ name: "git-helper", extraFrontmatter: { license: "MIT" } }),
        ],
      }),
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
        materializeSkillFrontmatter({
          session,
          skills: [
            skill({ name: "git-helper", extraFrontmatter: { license: "MIT" } }),
          ],
        }),
      ).rejects.toThrow('Could not update or remove the skill "git-helper"');
      expect(commands).toEqual([`rm -rf -- '${SKILLS_BASE}/git-helper'`]);
    },
  );

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
