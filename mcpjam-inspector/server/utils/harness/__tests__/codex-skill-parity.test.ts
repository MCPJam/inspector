/**
 * Codex SKILL parity — the gate for `codexAdapter.supportsSkills` (INS-8).
 *
 * The repo rule is that advertising a capability means enforcing it, so the flag
 * may only be on if the REAL adapter actually delivers. These tests therefore
 * drive MCPJam's Codex app-server adapter against a fake sandbox session (no
 * mock of the adapter, no reimplementation of its writer) and assert
 * what it puts on the box, then assert the SAME payload through the installed
 * `@ai-sdk/harness-claude-code` adapter to show the two runtimes are at parity
 * apart from their root.
 *
 * They pin the three facts MCPJam's own skill passes depend on:
 *   1. WHERE the skills land — the descriptor's write folder must equal the
 *      adapter's real target, or the box writer's supporting-file, SKILL.md
 *      and reconcile steps would operate on folders the runtime never reads.
 *   2. That the delivered SKILL.md is valid frontmatter for our descriptions
 *      (both runtimes interpolate `description: ${value}` raw, hence the
 *      plan's YAML-quoted descriptions).
 *   3. That a name MCPJam accepts is a name the adapters accept — the shared
 *      writer's validator THROWS mid-turn, which would fail the whole turn.
 *
 * The adapters are driven the way they run on a box (`promptWithSkills` in
 * `server/test/support/fake-harness-bridge.ts`): skills are written at
 * prompt time, so each test reaches `doPromptTurn` against a fake bridge.
 */
import { describe, expect, it } from "vitest";
import matter from "gray-matter";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createCodexAppServer } from "../codex-appserver/index.js";
import { boxSkillsFolder, planBoxSkills } from "../box-skills-writer";
import { getHarnessAdapter } from "../registry";
import type { RuntimeSkill } from "../runtime-skills";
import { BOX_HOME } from "../../../test/support/fake-skill-box";
import {
  promptWithSkills,
  skillWrites,
} from "../../../test/support/fake-harness-bridge";

/** Writes are "expected to have happened" only if the whole turn setup ran. */
function expectReachedPrompt(error: unknown): void {
  expect(error).toBeUndefined();
}

function skill(p: Partial<RuntimeSkill> & { skillId: string }): RuntimeSkill {
  return {
    name: "pdf-tools",
    description: "Process PDFs",
    content: "# Body",
    aggregateHash: "h1",
    ...p,
  };
}

describe("codex skill parity (real adapter)", () => {
  it("writes each delivered skill under the descriptor's write folder", async () => {
    const adapter = getHarnessAdapter("codex");
    const plan = planBoxSkills(adapter.skills, [
      skill({ skillId: "s1", name: "pdf-tools" }),
      skill({ skillId: "s2", name: "csv-tools", description: "Read CSVs" }),
    ]);

    const { writes, error } = await promptWithSkills(
      createCodexAppServer() as never,
      plan.payload
    );

    expectReachedPrompt(error);
    // The load-bearing assertion: the registry's root IS where codex writes.
    // If the adapter ever moves its root, every MCPJam skill pass would silently
    // target a directory the CLI does not read — this fails first.
    expect(boxSkillsFolder(adapter.skills, BOX_HOME)).toBe(`${BOX_HOME}/.agents/skills`);
    // (The stable writer syncs skills sorted by name, so csv-tools lands first.)
    expect(
      skillWrites(writes, boxSkillsFolder(adapter.skills, BOX_HOME)).map((w) => w.path)
    ).toEqual([
      `${boxSkillsFolder(adapter.skills, BOX_HOME)}/csv-tools/SKILL.md`,
      `${boxSkillsFolder(adapter.skills, BOX_HOME)}/pdf-tools/SKILL.md`,
    ]);
    // Nothing lands anywhere else under $HOME's skill roots — in particular not
    // Claude Code's, which MCPJam's passes would then also have to reconcile.
    expect(writes.filter((w) => w.path.includes("/.claude/skills/"))).toEqual(
      []
    );
  });

  it("writes a skill's supporting files beside its SKILL.md", async () => {
    // MCPJam materializes supporting files itself (Convex blobs, byte budget),
    // but it must write them into the SAME dir layout the adapter uses.
    const adapter = getHarnessAdapter("codex");
    const { writes, error } = await promptWithSkills(createCodexAppServer() as never, [
      {
        name: "pdf-tools",
        description: "Process PDFs",
        content: "# Body",
        files: [{ path: "scripts/run.py", content: "print(1)" }],
      },
    ]);

    expectReachedPrompt(error);
    // Within a skill the writer orders files by locale, so compare as a set.
    expect(
      skillWrites(writes, boxSkillsFolder(adapter.skills, BOX_HOME))
        .map((w) => w.path)
        .sort()
    ).toEqual([
      `${boxSkillsFolder(adapter.skills, BOX_HOME)}/pdf-tools/SKILL.md`,
      `${boxSkillsFolder(adapter.skills, BOX_HOME)}/pdf-tools/scripts/run.py`,
    ]);
  });

  it("produces PARSEABLE frontmatter for MCPJam-encoded descriptions", async () => {
    // codex builds `description: ${value}` by string interpolation, so a raw
    // description containing a quote or colon would emit broken YAML. This is
    // why the plan quotes each description — assert on the file the adapter
    // actually wrote, not on our own encoder.
    const runtime = [
      skill({ skillId: "s1", description: 'Process: PDFs "safely"' }),
    ];
    const { writes, error } = await promptWithSkills(
      createCodexAppServer() as never,
      planBoxSkills(getHarnessAdapter("codex").skills, runtime).payload
    );

    expectReachedPrompt(error);
    const parsed = matter(
      skillWrites(writes, boxSkillsFolder(getHarnessAdapter("codex").skills, BOX_HOME))[0]!.content
    );
    expect(parsed.data.name).toBe("pdf-tools");
    expect(parsed.data.description).toBe('Process: PDFs "safely"');
    expect(parsed.content.trim()).toBe("# Body");
  });

  it("would emit BROKEN frontmatter without the encoding (control)", async () => {
    // The negative half of the previous test: the semantic payload — what a
    // structurally-composing adapter could take — yields YAML that does not
    // round-trip through codex's raw interpolation.
    const { writes, error } = await promptWithSkills(
      createCodexAppServer() as never,
      [
        {
          name: "pdf-tools",
          description: 'Process: PDFs "safely"',
          content: "# Body",
        },
      ]
    );

    expectReachedPrompt(error);
    const written = skillWrites(
      writes,
      boxSkillsFolder(getHarnessAdapter("codex").skills, BOX_HOME)
    )[0]!;
    let parsedDescription: unknown;
    try {
      parsedDescription = matter(written.content).data.description;
    } catch {
      parsedDescription = undefined; // YAML refused it outright
    }
    expect(parsedDescription).not.toBe('Process: PDFs "safely"');
  });

  it("accepts every name MCPJam's validator accepts", async () => {
    // The descriptor's name rule is MCPJam's `isValidSkillName`; that is only
    // safe if it is a SUBSET of codex's own rule. Names at the edges of the
    // shared spec (digits, hyphens, length) must all survive `doStart`.
    const names = [
      "a",
      "pdf-tools",
      "skill-2",
      "x9",
      "a-b-c-d",
      "z".repeat(64),
    ];
    const plan = planBoxSkills(
      getHarnessAdapter("codex").skills,
      names.map((name, i) => skill({ skillId: `s${i}`, name }))
    );
    expect(plan.skipped).toEqual([]);

    const { writes, error } = await promptWithSkills(
      createCodexAppServer() as never,
      plan.payload
    );

    expectReachedPrompt(error);
    expect(
      skillWrites(writes, boxSkillsFolder(getHarnessAdapter("codex").skills, BOX_HOME))
    ).toHaveLength(names.length);
  });

  it("THROWS on a name MCPJam filters out — which is why it filters", async () => {
    // Demonstrates the failure mode the name rule exists to prevent: on
    // the stable line the rejection happens inside `doPromptTurn` (skills are
    // synced per turn), so an unfiltered bad name takes down the entire turn
    // (not just that skill).
    const { error } = await promptWithSkills(createCodexAppServer() as never, [
      { name: "..", description: "d", content: "c" },
    ]);
    expect((error as Error).message).toMatch(/Invalid skill name/);
  });

  it("parity with Claude Code: same payload, same SKILL.md, own root", async () => {
    // Both runtimes are driven from one prepared payload, so a skill delivered
    // to Codex is the same skill the user sees on Claude Code — only the root
    // differs, and each adapter's root is the one the registry advertises.
    const codexAdapter = getHarnessAdapter("codex");
    const claudeAdapter = getHarnessAdapter("claude-code");
    const payload = planBoxSkills(codexAdapter.skills, [
      skill({ skillId: "s1", description: 'Process: PDFs "safely"' }),
    ]).payload;

    const codexRun = await promptWithSkills(createCodexAppServer() as never, payload);
    const claudeRun = await promptWithSkills(
      createClaudeCode() as never,
      payload
    );

    expectReachedPrompt(codexRun.error);
    expectReachedPrompt(claudeRun.error);
    const codexWrite = codexRun.writes.find((w) =>
      w.path.endsWith("/SKILL.md")
    )!;
    const claudeWrite = claudeRun.writes.find((w) =>
      w.path.endsWith("/SKILL.md")
    )!;
    expect(codexWrite.path).toBe(
      `${boxSkillsFolder(codexAdapter.skills, BOX_HOME)}/pdf-tools/SKILL.md`
    );
    expect(claudeWrite.path).toBe(
      `${boxSkillsFolder(claudeAdapter.skills, BOX_HOME)}/pdf-tools/SKILL.md`
    );
    expect(boxSkillsFolder(claudeAdapter.skills, BOX_HOME)).toBe(`${BOX_HOME}/.claude/skills`);
    // Same frontmatter + body (claude-code appends a trailing newline).
    const codexParsed = matter(codexWrite.content);
    const claudeParsed = matter(claudeWrite.content);
    expect(codexParsed.data).toEqual(claudeParsed.data);
    expect(codexParsed.content.trim()).toBe(claudeParsed.content.trim());
  });
});

/** Supporting files, the absence of a Claude Code root, and the name rule. */
describe("codex skill delivery details", () => {
  it("writes delivered skills and supporting files under the descriptor's write folder", async () => {
    const adapter = getHarnessAdapter("codex");
    const { writes, error } = await promptWithSkills(
      createCodexAppServer() as never,
      [
        ...planBoxSkills(adapter.skills, [
          skill({ skillId: "s1", name: "pdf-tools" }),
          skill({ skillId: "s2", name: "csv-tools", description: "Read CSVs" }),
        ]).payload,
      ].map((entry) =>
        entry.name === "pdf-tools"
          ? { ...entry, files: [{ path: "scripts/run.py", content: "print(1)" }] }
          : entry
      )
    );

    expectReachedPrompt(error);
    expect(
      skillWrites(writes, boxSkillsFolder(adapter.skills, BOX_HOME))
        .map((w) => w.path)
        .sort()
    ).toEqual([
      `${boxSkillsFolder(adapter.skills, BOX_HOME)}/csv-tools/SKILL.md`,
      `${boxSkillsFolder(adapter.skills, BOX_HOME)}/pdf-tools/SKILL.md`,
      `${boxSkillsFolder(adapter.skills, BOX_HOME)}/pdf-tools/scripts/run.py`,
    ]);
    expect(writes.filter((w) => w.path.includes("/.claude/skills/"))).toEqual(
      []
    );
  });

  it("accepts every name MCPJam accepts and refuses what MCPJam filters", async () => {
    const names = ["a", "pdf-tools", "skill-2", "z".repeat(64)];
    const plan = planBoxSkills(
      getHarnessAdapter("codex").skills,
      names.map((name, i) => skill({ skillId: `s${i}`, name }))
    );
    const ok = await promptWithSkills(
      createCodexAppServer() as never,
      plan.payload
    );
    expectReachedPrompt(ok.error);
    expect(
      skillWrites(ok.writes, boxSkillsFolder(getHarnessAdapter("codex").skills, BOX_HOME))
    ).toHaveLength(names.length);

    const bad = await promptWithSkills(createCodexAppServer() as never, [
      { name: "..", description: "d", content: "c" },
    ]);
    expect(bad.error).toBeDefined();
  });
});
