/**
 * What a harness turn's skill plan prepares for its box, for every runtime and
 * every kind of source. The expectations are written by hand from the sources'
 * fixtures, never read back from the plan, so a change to what a runtime
 * receives shows up here as a diff.
 *
 * These cases held the plan to the runner's older, separate source selection
 * until that selection was deleted; the values below are what it produced.
 */
import { describe, expect, it } from "vitest";
import { environmentTurnSkills } from "../../../services/environments/live-turn-skills";
import { pinnedArtifactsToRuntimeSkills } from "../../../services/environments/harness-skill-delivery";
import { runtimeSkills } from "../../../services/environments/runtime";
import {
  resolveTurnSkills,
  type TurnSkills,
} from "../../../services/environments/turn-skills";
import { sha256 } from "../../../test/support/server-skill-wire";
import {
  authoredPin,
  evalEnvironment,
  pluginPin,
  preparedRunSkills,
  serverPin,
} from "../../../test/support/skill-delivery";
import { harnessServerSkills } from "../harness-server-skills";
import { getHarnessAdapter } from "../registry";
import { harnessTurnSkillsFromPlan } from "../skill-delivery";
import { skillsFingerprint } from "../runtime-skills";

const HARNESSES = [
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "copilot-cli",
] as const;

const NO_SERVERS = {
  getSkillsSupport: () => ({ active: false }),
} as never;

const runtimeOf = (harnessId: string) =>
  ({ kind: "harness", harnessId }) as const;

/** What a turn hands its box writer, with the file listing read out. */
async function prepared(plan: TurnSkills, harnessId: string) {
  const turn = harnessTurnSkillsFromPlan(plan, harnessId);
  const listing = await turn.readFiles();
  return {
    mode: turn.mode,
    names: turn.skills?.map((skill) => skill.name) ?? null,
    skillsHash: turn.skillsHash,
    live: turn.live,
    files: listing.files.map((file) => ({
      skillId: file.skillId,
      path: file.path,
    })),
    knowsFilesOf: listing.complete("sk_release_notes"),
  };
}

const CHECK_SH = { skillId: "sk_release_notes", path: "scripts/check.sh" };

describe.each(HARNESSES)("%s runs its turn's skill plan", (harnessId) => {
  it("for a run's frozen skills, with the captured server skill kept off its box", async () => {
    const run = await preparedRunSkills();
    const plan = resolveTurnSkills({
      source: run.pinnedSkillSource,
      runtime: runtimeOf(harnessId),
    });
    const turn = await prepared(plan, harnessId);
    expect(turn).toMatchObject({
      mode: "pinned",
      // Every runtime here takes server skills through MCPJam's tools, so the
      // run's library and plugin skills are all the box gets.
      names: ["release-notes", "summarize"],
      live: false,
      files: [CHECK_SH],
      knowsFilesOf: true,
    });
    // The fingerprint that forks a resumed session is over the frozen copies,
    // computed here from the run's artifacts rather than from the plan.
    const copies = run.pinnedSkillSource.harnessSkills.filter(
      (copy) => !copy.server,
    );
    expect(turn.skillsHash).toBe(
      skillsFingerprint(pinnedArtifactsToRuntimeSkills(copies)),
    );
  });

  it("for a run that froze no skills, which clears the box", async () => {
    const run = await preparedRunSkills([]);
    const plan = resolveTurnSkills({
      source: run.pinnedSkillSource,
      runtime: runtimeOf(harnessId),
    });
    expect(await prepared(plan, harnessId)).toMatchObject({
      mode: "pinned",
      names: [],
      skillsHash: "",
      live: false,
      files: [],
    });
  });

  it("for a turn that names no source, which leaves the box as it is", async () => {
    const plan = resolveTurnSkills({
      source: { kind: "none" },
      runtime: runtimeOf(harnessId),
    });
    expect(await prepared(plan, harnessId)).toMatchObject({
      mode: "none",
      names: null,
      skillsHash: undefined,
      live: false,
      files: [],
      knowsFilesOf: false,
    });
  });

  it.each([
    ["a named environment", undefined, false],
    ["a client's environment, whose servers are connected now", {}, true],
  ])("for %s", async (_name, liveExtras, live) => {
    const { spec, attribution } = evalEnvironment();
    const { skills: plan } = environmentTurnSkills({
      spec,
      attribution,
      ...(liveExtras ? { liveExtras } : {}),
      runtime: runtimeOf(harnessId),
    });
    const turn = await prepared(plan, harnessId);
    expect(turn).toMatchObject({
      mode: "environment",
      names: ["release-notes", "summarize"],
      live,
      files: [CHECK_SH],
      knowsFilesOf: true,
    });
    // The environment's own skills fork a session by their fingerprint.
    expect(turn.skillsHash).toBe(skillsFingerprint(runtimeSkills(spec)));
  });

  it("for an environment whose files could not be read, which keeps the box's other files", async () => {
    const { spec, attribution } = evalEnvironment();
    const { skills: plan } = environmentTurnSkills({
      spec,
      attribution,
      liveExtras: {},
      filesUnread: true,
      runtime: runtimeOf(harnessId),
    });
    expect(await prepared(plan, harnessId)).toMatchObject({
      mode: "environment",
      names: ["release-notes", "summarize"],
      live: true,
      files: [],
      knowsFilesOf: false,
    });
  });

  it("for a live turn that read no skills, which offers only its servers' own", async () => {
    const plan = resolveTurnSkills({
      source: { kind: "live", projectSkills: [] },
      runtime: runtimeOf(harnessId),
    });
    expect(await prepared(plan, harnessId)).toMatchObject({
      mode: "none",
      names: null,
      live: true,
    });
  });

  it("serves a run's captured server skill, its files and its digest-checked body", async () => {
    const run = await preparedRunSkills([
      authoredPin(),
      pluginPin(),
      serverPin({
        contentHash: await sha256("# Search"),
        files: [
          {
            path: "docs/guide.md",
            contentHash: "hash-guide",
            size: 7,
            url: `data:text/markdown;base64,${Buffer.from("# Guide").toString("base64")}`,
          },
        ],
      }),
    ]);
    const plan = resolveTurnSkills({
      source: run.pinnedSkillSource,
      runtime: runtimeOf(harnessId),
    });
    const turn = await harnessServerSkills(getHarnessAdapter(harnessId), {
      live: false,
      capturedServerSkills: plan.set.serverSkills,
      manager: NO_SERVERS,
      serverIds: [],
      messages: [],
    });
    expect(turn?.served).toEqual([
      { skillId: "ss_docs_search", name: "search" },
    ]);
    expect(turn?.promptSection).toContain("**docs/search**");
    const call = async (tool: string, input: Record<string, unknown>) =>
      (
        turn?.tools[tool] as {
          execute: (input: unknown, options: unknown) => Promise<unknown>;
        }
      ).execute(input, { toolCallId: "probe", messages: [] });
    // The server's own text, read through the run's frozen bytes.
    expect(await call("loadSkill", { name: "docs/search" })).toContain(
      "# Search",
    );
    expect(await call("listSkillFiles", { name: "docs/search" })).toContain(
      "docs/guide.md",
    );
    expect(
      await call("readSkillFile", {
        name: "docs/search",
        path: "docs/guide.md",
      }),
    ).toContain("# Guide");
  });
});
