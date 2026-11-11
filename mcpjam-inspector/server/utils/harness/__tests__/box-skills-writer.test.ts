/**
 * The box writer against an in-memory box: what lands in which folder, what a
 * box keeps across turns of different runtimes, and what the writer reports.
 * The adapter's own write is the real `@ai-sdk/harness` `writeSkills`, run the
 * way each adapter runs it, so "the adapter changes nothing" is checked rather
 * than assumed.
 */
import { describe, expect, it, vi } from "vitest";
import { writeSkills } from "@ai-sdk/harness/utils";
import type { PinnedSkillArtifact } from "../../../../shared/skill-types";
import {
  BOX_HOME,
  fakeSkillBox,
  type FakeSkillBox,
} from "../../../test/support/fake-skill-box";
import { writeTurnToBox } from "../../../test/support/skill-delivery";
import {
  planBoxSkills,
  writeBoxSkills,
  type BoxSkillFiles,
} from "../box-skills-writer";
import { hasAllowedToolsGrant } from "../materialize-skill-frontmatter";
import { getHarnessAdapter } from "../registry";
import type { RuntimeSkill } from "../runtime-skills";
import { HARNESS_SKILLS } from "../skills-descriptor";

const CLAUDE = `${BOX_HOME}/.claude/skills`;
const AGENTS = `${BOX_HOME}/.agents/skills`;

const skill = (
  name: string,
  over: Partial<RuntimeSkill> = {},
): RuntimeSkill => ({
  skillId: `sk_${name}`,
  name,
  description: `The ${name} skill.`,
  content: `# ${name}`,
  aggregateHash: `hash-${name}`,
  ...over,
});

const artifact = (
  name: string,
  over: Partial<PinnedSkillArtifact> = {},
): PinnedSkillArtifact => ({
  skillId: `sk_${name}`,
  name,
  description: `The ${name} skill.`,
  content: `# ${name}`,
  contentHash: `hash-${name}`,
  ...over,
});

const NO_FILES: BoxSkillFiles = { files: [], complete: () => true };

/** A turn of `harnessId` delivering a run's frozen copies. */
const runTurn = (
  harnessId: string,
  box: FakeSkillBox,
  ...artifacts: PinnedSkillArtifact[]
) => writeTurnToBox(harnessId, { pinnedHarnessSkills: artifacts }, box);

/** The adapter's own turn-time write, as `harnessId`'s adapter makes it. */
async function adapterWrite(
  harnessId: string,
  box: FakeSkillBox,
  skills: RuntimeSkill[],
) {
  const descriptor = getHarnessAdapter(harnessId).skills;
  return writeSkills({
    sandbox: box.session as never,
    homePath: BOX_HOME,
    skillsDir: descriptor.writeFolder,
    skills: planBoxSkills(descriptor, skills).payload,
    trailingNewline: descriptor.trailingNewline,
  });
}

describe("planBoxSkills", () => {
  const claude = HARNESS_SKILLS["claude-code"];

  it("leaves off a name the runtime rejects, and a second skill wanting a taken folder", () => {
    const library = skill("summarize");
    const plugin = skill("summarize", { skillId: "sk_acme_summarize" });
    const plan = planBoxSkills(claude, [
      skill("Bad_Name"),
      library,
      plugin,
      skill("notes"),
    ]);
    expect(plan.deliver.map((entry) => entry.skillId)).toEqual([
      "sk_summarize",
      "sk_notes",
    ]);
    expect(plan.skipped).toEqual([
      { skill: skill("Bad_Name"), reason: "invalid-skill-name" },
      { skill: plugin, reason: "name-collision" },
    ]);
    expect(plan.payload.map((entry) => entry.name)).toEqual([
      "summarize",
      "notes",
    ]);
  });

  it("YAML-quotes each description for the adapter, which interpolates it raw", () => {
    const plan = planBoxSkills(claude, [
      skill("notes", { description: 'Process: "PDFs"\nsafely' }),
    ]);
    expect(plan.payload[0]!.description).toBe('"Process: \\"PDFs\\"\\nsafely"');
  });
});

describe("writeBoxSkills", () => {
  it("writes each skill whole, so the adapter's own write changes nothing", async () => {
    const box = fakeSkillBox();
    const result = await runTurn(
      "claude-code",
      box,
      artifact("release-notes", {
        frontmatter: { license: "MIT", "allowed-tools": ["Bash(*)"] },
        files: [{ path: "scripts/check.sh", content: "echo ok" }],
      }),
    );
    expect(result).toEqual({
      delivered: [{ skillId: "sk_release-notes", name: "release-notes" }],
      notDelivered: [],
      failed: [],
    });
    const skillMd = box.files.get(`${CLAUDE}/release-notes/SKILL.md`)!;
    expect(skillMd).toContain('license: "MIT"');
    expect(hasAllowedToolsGrant(skillMd)).toBe(false);
    expect(box.files.get(`${CLAUDE}/release-notes/scripts/check.sh`)).toBe(
      "echo ok",
    );
    const adapter = await adapterWrite("claude-code", box, [
      skill("release-notes", {
        aggregateHash: "hash-release-notes",
        extraFrontmatter: { license: "MIT", allowedTools: ["Bash(*)"] },
      }),
    ]);
    expect(adapter.changed).toBe(false);
    expect(box.files.get(`${CLAUDE}/release-notes/SKILL.md`)).toBe(skillMd);
  });

  it("delivers the first of two skills that want one folder instead of failing the turn", async () => {
    const box = fakeSkillBox();
    const result = await runTurn(
      "codex",
      box,
      artifact("summarize"),
      artifact("summarize", {
        skillId: "sk_acme_summarize",
        content: "# acme",
      }),
    );
    expect(result.delivered).toEqual([
      { skillId: "sk_summarize", name: "summarize" },
    ]);
    expect(result.notDelivered).toEqual([
      {
        skillId: "sk_acme_summarize",
        name: "summarize",
        reason: "name-collision",
      },
    ]);
    expect(box.files.get(`${AGENTS}/summarize/SKILL.md`)).toContain(
      "# summarize",
    );
  });

  it("takes out a grant a box written before the strip still holds", async () => {
    // The skill had `allowed-tools`, an earlier turn wrote it, and the extras
    // were removed since. The adapter's hash is unchanged, so only the
    // writer's read of the box can find the line.
    const box = fakeSkillBox();
    await runTurn("claude-code", box, artifact("git-helper"));
    const path = `${CLAUDE}/git-helper/SKILL.md`;
    box.files.set(
      path,
      box.files
        .get(path)!
        .replace("\n---\n", '\nallowed-tools: ["Bash(*)"]\n---\n'),
    );
    await runTurn("claude-code", box, artifact("git-helper"));
    expect(hasAllowedToolsGrant(box.files.get(path)!)).toBe(false);
  });

  it("reports a skill it had to take off the box as failed", async () => {
    const granted = `${CLAUDE}/granted/SKILL.md`;
    const refused = new Set<string>();
    const box = fakeSkillBox({ failWrite: (path) => refused.has(path) });
    await runTurn("claude-code", box, artifact("granted"), artifact("plain"));
    // Something on the box gave `granted` a grant, and this turn can't
    // rewrite that SKILL.md.
    box.files.set(
      granted,
      box.files
        .get(granted)!
        .replace("\n---\n", '\nallowed-tools: ["Bash"]\n---\n'),
    );
    refused.add(granted);
    const result = await runTurn(
      "claude-code",
      box,
      artifact("granted"),
      artifact("plain"),
    );
    expect(result.delivered).toEqual([{ skillId: "sk_plain", name: "plain" }]);
    expect(result.failed).toEqual([
      {
        skillId: "sk_granted",
        name: "granted",
        error:
          "SKILL.md could not be rewritten and may grant tools, so the skill was removed",
      },
    ]);
    expect(box.skillFolders(CLAUDE)).toEqual(["plain"]);
  });

  it("reports a skill missing a supporting file as failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403 })),
    );
    const box = fakeSkillBox();
    const descriptor = HARNESS_SKILLS.codex;
    const result = await writeBoxSkills({
      session: box.session,
      descriptor,
      home: BOX_HOME,
      plan: planBoxSkills(descriptor, [skill("notes")]),
      readFiles: async () => ({
        files: [
          {
            skillId: "sk_notes",
            path: "ref.md",
            size: 3,
            url: "https://f/ref",
          },
        ],
        complete: () => true,
      }),
    });
    vi.unstubAllGlobals();
    expect(result.failed).toEqual([
      {
        skillId: "sk_notes",
        name: "notes",
        error: "ref.md: download failed (HTTP 403)",
      },
    ]);
    expect(box.skillFolders(AGENTS)).toEqual(["notes"]);
  });

  it("keeps a skill's files when its list could not be read this turn", async () => {
    const box = fakeSkillBox();
    await runTurn(
      "claude-code",
      box,
      artifact("notes", { files: [{ path: "a.md", content: "kept" }] }),
    );
    await writeBoxSkills({
      session: box.session,
      descriptor: HARNESS_SKILLS["claude-code"],
      home: BOX_HOME,
      plan: planBoxSkills(HARNESS_SKILLS["claude-code"], [
        skill("notes", { aggregateHash: "hash-notes" }),
      ]),
      readFiles: async () => ({ files: [], complete: () => false }),
    });
    expect(box.files.get(`${CLAUDE}/notes/a.md`)).toBe("kept");
  });
});

describe("a box that runs more than one runtime", () => {
  const HAND_PLACED = `${CLAUDE}/hand-placed/SKILL.md`;

  it("holds exactly each turn's skills in every folder that turn's runtime reads", async () => {
    const box = fakeSkillBox({
      files: { [HAND_PLACED]: "a person's own skill" },
    });
    await runTurn("claude-code", box, artifact("alpha"), artifact("beta"));
    await runTurn("codex", box, artifact("gamma"));
    // Codex reads only its own folder; Claude Code's turn is untouched.
    expect(box.skillFolders(AGENTS)).toEqual(["gamma"]);
    expect(box.skillFolders(CLAUDE)).toEqual(["alpha", "beta", "hand-placed"]);

    // OpenCode takes no skills, and reads both folders: it finds no MCPJam
    // skill in either, while the hand-placed one stays.
    await runTurn("opencode", box, artifact("delta"));
    expect(box.skillFolders(AGENTS)).toEqual([]);
    expect(box.skillFolders(CLAUDE)).toEqual(["hand-placed"]);

    // The next Claude Code turn delivers a different set: nothing stale.
    await runTurn("claude-code", box, artifact("beta"));
    expect(box.skillFolders(CLAUDE)).toEqual(["beta", "hand-placed"]);
    expect(box.files.get(HAND_PLACED)).toBe("a person's own skill");
  });

  it("puts a Codex turn's skills back whole after an OpenCode turn cleared their shared folder", async () => {
    // OpenCode's adapter writes Codex's folder under the same manifest, so an
    // OpenCode turn takes Codex's skills off; Codex's next turn must not find
    // the manifest calling them unchanged.
    const box = fakeSkillBox();
    const notes = artifact("notes", {
      frontmatter: { license: "MIT" },
      files: [{ path: "ref.md", content: "reference" }],
    });
    await runTurn("codex", box, notes);
    const written = box.files.get(`${AGENTS}/notes/SKILL.md`);
    await runTurn("opencode", box);
    expect(box.skillFolders(AGENTS)).toEqual([]);
    await runTurn("codex", box, notes);
    expect(box.files.get(`${AGENTS}/notes/SKILL.md`)).toBe(written);
    expect(box.files.get(`${AGENTS}/notes/ref.md`)).toBe("reference");
    const adapter = await adapterWrite("codex", box, [
      skill("notes", {
        aggregateHash: "hash-notes",
        extraFrontmatter: { license: "MIT" },
      }),
    ]);
    expect(adapter.changed).toBe(false);
  });

  it("leaves every folder alone on a runtime that takes no skills and reads none of them", async () => {
    const box = fakeSkillBox();
    await runTurn("claude-code", box, artifact("alpha"));
    await runTurn("codex", box, artifact("gamma"));
    const before = new Map(box.files);
    for (const harnessId of ["cursor", "copilot-cli"]) {
      await runTurn(harnessId, box, artifact("delta"));
    }
    expect(box.files).toEqual(before);
  });

  it("writes nothing to a folder the turn neither delivers to nor finds MCPJam's skills in", async () => {
    const box = fakeSkillBox();
    const result = await writeBoxSkills({
      session: box.session,
      descriptor: HARNESS_SKILLS.opencode,
      home: BOX_HOME,
      plan: planBoxSkills(HARNESS_SKILLS.opencode, []),
      readFiles: async () => NO_FILES,
    });
    expect(result).toEqual({ delivered: [], notDelivered: [], failed: [] });
    expect(box.files.size).toBe(0);
    expect(box.commands).toEqual([]);
  });
});
