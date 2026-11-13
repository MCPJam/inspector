/**
 * Cursor skill parity: the gate for `cursorAdapter.supportsSkills`.
 *
 * Advertising a capability means enforcing it, so these tests drive the
 * Cursor harness exactly as the registry builds it (the pinned install, the
 * file login and the approval wrappers around `@ai-sdk/harness-cursor`) from
 * `doStart` to its prompt-time skill write against a fake bridge
 * (`promptWithSkills`), and check the facts the box writer depends on:
 *   1. A turn starts and its skills land in the descriptor's write folder,
 *      inside the CLI's private home.
 *   2. A name MCPJam accepts is one the ACP adapter accepts; a non-kebab name
 *      or a second skill with one name throws mid-turn, failing the whole
 *      turn, which is why the writer leaves both off.
 *   3. The SKILL.md Cursor gets keeps every skill one the model loads when it
 *      needs it, and names Cursor's surface when the skill lists surfaces.
 */
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { boxSkillsFolder, planBoxSkills } from "../box-skills-writer";
import { getHarnessAdapter } from "../registry";
import type { RuntimeSkill } from "../runtime-skills";
import { BOX_HOME, fakeSkillBox } from "../../../test/support/fake-skill-box";
import {
  promptWithSkills,
  skillWrites,
} from "../../../test/support/fake-harness-bridge";
import { writeTurnToBox } from "../../../test/support/skill-delivery";

const adapter = getHarnessAdapter("cursor");
const descriptor = adapter.skills;
const folder = boxSkillsFolder(descriptor, BOX_HOME);

const cursor = () =>
  adapter.createHarness({
    modelId: "cursor/auto",
    auth: { CURSOR_API_KEY: "cursor-test-key" },
    mcpJson: { mcpServers: {} },
  }) as never;

const skill = (
  name: string,
  over: Partial<RuntimeSkill> = {},
): RuntimeSkill => ({
  skillId: `sk_${name}`,
  name,
  description: "Process PDFs",
  content: "# Body",
  aggregateHash: `hash-${name}`,
  ...over,
});

describe("Cursor skill parity (real adapter)", () => {
  it("starts a turn and writes its skills under the descriptor's write folder", async () => {
    const payload = planBoxSkills(descriptor, [
      skill("pdf-tools"),
      skill("csv-tools", { description: "Read CSVs" }),
    ]).payload.map((entry) =>
      entry.name === "pdf-tools"
        ? { ...entry, files: [{ path: "scripts/run.py", content: "print(1)" }] }
        : entry,
    );

    const { writes, error } = await promptWithSkills(cursor(), payload);

    expect(error).toBeUndefined();
    expect(folder).toBe(
      `${BOX_HOME}/.ai-sdk-harness/.harness-bootstrap/cursor/implementation/home/.agents/skills`,
    );
    expect(
      skillWrites(writes, folder)
        .map((write) => write.path)
        .sort(),
    ).toEqual([
      `${folder}/csv-tools/SKILL.md`,
      `${folder}/pdf-tools/SKILL.md`,
      `${folder}/pdf-tools/scripts/run.py`,
    ]);
    // No skill lands in another client's folder.
    expect(
      writes.filter(
        (write) =>
          write.path.includes("/skills/") &&
          !write.path.startsWith(`${folder}/`),
      ),
    ).toEqual([]);
  });

  it("accepts every name MCPJam accepts and throws on the ones the writer leaves off", async () => {
    const names = [
      "a",
      "pdf-tools",
      "skill-2",
      "x9",
      "a-b-c-d",
      "z".repeat(64),
    ];
    const plan = planBoxSkills(
      descriptor,
      names.map((name) => skill(name)),
    );
    expect(plan.skipped).toEqual([]);
    const accepted = await promptWithSkills(cursor(), plan.payload);
    expect(accepted.error).toBeUndefined();
    expect(skillWrites(accepted.writes, folder)).toHaveLength(names.length);

    const library = skill("summarize");
    const plugin = skill("summarize", { skillId: "sk_acme_summarize" });
    expect(
      planBoxSkills(descriptor, [skill("Bad_Name"), library, plugin]).skipped,
    ).toEqual([
      { skill: skill("Bad_Name"), reason: "invalid-skill-name" },
      { skill: plugin, reason: "name-collision" },
    ]);
    const payload = (skills: RuntimeSkill[]) =>
      skills.map(({ name, description, content }) => ({
        name,
        description,
        content,
      }));
    const badName = await promptWithSkills(
      cursor(),
      payload([skill("Bad_Name")]),
    );
    expect((badName.error as Error).message).toMatch(/Invalid ACP skill name/);
    const duplicate = await promptWithSkills(
      cursor(),
      payload([library, plugin]),
    );
    expect((duplicate.error as Error).message).toMatch(
      /Duplicate ACP skill name/,
    );
  });

  it("never makes a skill an always-on rule, and names Cursor's surface", async () => {
    // Cursor reads `alwaysApply: true` at the top of the frontmatter as "add
    // this skill to every request", and drops a skill whose
    // `metadata.surfaces` lacks `cli`. A frozen copy can carry any key the
    // skill's own SKILL.md had.
    const box = fakeSkillBox();
    const written = await writeTurnToBox(
      "cursor",
      {
        pinnedHarnessSkills: [
          {
            skillId: "sk_release-notes",
            name: "release-notes",
            description: "Write release notes.",
            content: "# Release notes",
            contentHash: "hash-release-notes",
            frontmatter: {
              alwaysApply: true,
              metadata: { surfaces: "ide", alwaysApply: "true" },
            },
          },
        ],
      },
      box,
    );
    expect(written.delivered).toEqual([
      { skillId: "sk_release-notes", name: "release-notes" },
    ]);

    const skillMd = box.files.get(`${folder}/release-notes/SKILL.md`)!;
    const frontmatter = parseYaml(/^---\n([\s\S]*?)\n---\n/.exec(skillMd)![1]!);
    expect(frontmatter.alwaysApply).toBeUndefined();
    expect(frontmatter.metadata).toEqual({
      surfaces: "ide,cli",
      alwaysApply: "true",
    });
  });
});
