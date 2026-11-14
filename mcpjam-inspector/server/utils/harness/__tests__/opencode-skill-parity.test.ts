/**
 * OpenCode skill parity: the gate for `opencodeAdapter.supportsSkills`.
 *
 * Advertising a capability means enforcing it, so these tests drive the
 * installed `@ai-sdk/harness-opencode` adapter, built the way MCPJam builds it
 * (`createOpenCodeHarness`), to its prompt-time skill write against a fake
 * bridge (`promptWithSkills`), and check the facts the box writer depends on:
 *   1. Skills land in the descriptor's write folder. That is Codex's folder
 *      too, under one adapter manifest, so OpenCode must write it byte for
 *      byte as Codex's adapter does: either runtime then finds the other's
 *      write of the same skills unchanged.
 *   2. The bridge starts OpenCode reading that folder and none of the other
 *      clients' folders, which is what the descriptor's read folders say.
 *   3. A name MCPJam accepts is one the adapter accepts; the adapter's own
 *      check throws mid-turn, failing the whole turn.
 */
import { describe, expect, it } from "vitest";
import matter from "gray-matter";
import { createCodexAppServer } from "../codex-appserver/index.js";
import { boxSkillsFolder, planBoxSkills } from "../box-skills-writer";
import { createOpenCodeHarness } from "../opencode-adapter";
import { buildBrokerDummyAuth, getHarnessAdapter } from "../registry";
import type { RuntimeSkill } from "../runtime-skills";
import { foldersToClear } from "../skills-descriptor";
import { BOX_HOME } from "../../../test/support/fake-skill-box";
import {
  promptWithSkills,
  skillWrites,
  type BoxWrite,
} from "../../../test/support/fake-harness-bridge";

const descriptor = getHarnessAdapter("opencode").skills;
const folder = boxSkillsFolder(descriptor, BOX_HOME);

const openCode = () =>
  createOpenCodeHarness({
    modelId: "anthropic/claude-haiku-4.5",
    auth: buildBrokerDummyAuth("opencode", "https://broker.example"),
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

/** The last content written to `path`. */
const lastWrite = (writes: BoxWrite[], path: string) =>
  writes.filter((write) => write.path === path).at(-1)?.content;

describe("OpenCode skill parity (real adapter)", () => {
  it("writes each skill and its supporting files under the descriptor's write folder", async () => {
    const payload = planBoxSkills(descriptor, [
      skill("pdf-tools"),
      skill("csv-tools", { description: "Read CSVs" }),
    ]).payload.map((entry) =>
      entry.name === "pdf-tools"
        ? { ...entry, files: [{ path: "scripts/run.py", content: "print(1)" }] }
        : entry,
    );

    const { writes, error } = await promptWithSkills(openCode(), payload);

    expect(error).toBeUndefined();
    expect(folder).toBe(`${BOX_HOME}/.agents/skills`);
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

  it("writes the shared folder byte for byte as Codex's adapter does", async () => {
    const payload = planBoxSkills(descriptor, [
      skill("pdf-tools", { description: 'Process: PDFs "safely"' }),
    ]).payload;

    const openCodeRun = await promptWithSkills(openCode(), payload);
    const codexRun = await promptWithSkills(
      createCodexAppServer() as never,
      payload,
    );

    expect(openCodeRun.error).toBeUndefined();
    expect(codexRun.error).toBeUndefined();
    expect(boxSkillsFolder(getHarnessAdapter("codex").skills, BOX_HOME)).toBe(
      folder,
    );
    const skillMd = `${folder}/pdf-tools/SKILL.md`;
    const manifest = `${folder}/.ai-sdk-harness-skills.json`;
    expect(lastWrite(openCodeRun.writes, skillMd)).toBe(
      lastWrite(codexRun.writes, skillMd),
    );
    // The same name and hash in the shared manifest: a Codex turn after an
    // OpenCode turn with the same skills rewrites nothing, and the reverse.
    expect(lastWrite(openCodeRun.writes, manifest)).toBe(
      lastWrite(codexRun.writes, manifest),
    );
    // OpenCode reads `name` and `description`; MCPJam's quoting survives.
    expect(matter(lastWrite(openCodeRun.writes, skillMd)!).data).toEqual({
      name: "pdf-tools",
      description: 'Process: PDFs "safely"',
    });
  });

  it("starts OpenCode reading the write folder and no other client's", async () => {
    const { spawns, error } = await promptWithSkills(openCode(), []);

    expect(error).toBeUndefined();
    expect(spawns).toHaveLength(1);
    // The bridge names this folder in OpenCode's `skills.paths`, its only
    // read of it once external skill folders are off.
    expect(spawns[0]!.command).toContain(`--skills-dir '${folder}'`);
    expect(spawns[0]!.env).toMatchObject({
      OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    });
    // So it reads no folder another adapter writes, and its turn clears none.
    expect(foldersToClear(descriptor)).toEqual([]);
  });

  it("accepts every name MCPJam accepts and throws on one MCPJam leaves off", async () => {
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

    const accepted = await promptWithSkills(openCode(), plan.payload);
    expect(accepted.error).toBeUndefined();
    expect(skillWrites(accepted.writes, folder)).toHaveLength(names.length);

    expect(descriptor.acceptsName("..")).toBe(false);
    const refused = await promptWithSkills(openCode(), [
      { name: "..", description: "d", content: "c" },
    ]);
    expect((refused.error as Error).message).toMatch(
      /Invalid OpenCode skill name/,
    );
  });
});
