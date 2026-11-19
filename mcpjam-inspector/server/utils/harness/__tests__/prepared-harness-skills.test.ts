/**
 * A harness turn runs its skill plan instead of choosing a source of its own.
 * The runner's older selection (`harnessTurnSkills`) is the reference: for every
 * runtime and every kind of source, the plan must prepare what that selection
 * produced, so moving a caller onto the plan changes nothing a box receives, no
 * session fingerprint, and nothing a skill tool serves.
 */
import { describe, expect, it } from "vitest";
import {
  environmentTurnSkills,
  type LiveTurnSkills,
} from "../../../services/environments/live-turn-skills";
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
import {
  harnessTurnSkills,
  harnessTurnSkillsFromPlan,
  type HarnessTurnSkills,
} from "../skill-delivery";
import { takesServerSkillsAsTools } from "../skills-descriptor";

const HARNESSES = [
  "claude-code",
  "codex",
  "opencode",
  "cursor",
  "copilot-cli",
] as const;

type Legacy = Parameters<typeof harnessTurnSkills>[0];

const NO_SERVERS = {
  getSkillsSupport: () => ({ active: false }),
} as never;

/** What a turn hands its box writer, with the file listing read out. */
async function observed(turn: HarnessTurnSkills) {
  const listing = await turn.readFiles();
  return {
    mode: turn.mode,
    skills: turn.skills,
    skillsHash: turn.skillsHash,
    live: turn.live,
    files: listing.files,
    complete: [
      "sk_release_notes",
      "sk_acme_summarize",
      "ss_docs_search",
      "unknown",
    ].map((skillId) => listing.complete(skillId)),
  };
}

async function selected(harnessId: string, source: Legacy) {
  return observed(
    await harnessTurnSkills({
      ...source,
      serverSkillsAsTools: takesServerSkillsAsTools(getHarnessAdapter(harnessId)),
    }),
  );
}

function planned(plan: TurnSkills, harnessId: string) {
  return observed(harnessTurnSkillsFromPlan(plan, harnessId));
}

const runtimeOf = (harnessId: string) =>
  ({ kind: "harness", harnessId }) as const;

/** An environment turn as the legacy inputs carried it. */
function legacyOf(turn: LiveTurnSkills): Legacy {
  return {
    ...(turn.box
      ? {
          runtimeSkillsOverride: turn.box.skills,
          ...(turn.box.set ? { effectiveCapabilities: turn.box.set } : {}),
        }
      : {}),
    ...(turn.live ? { liveTurn: true } : {}),
  };
}

describe.each(HARNESSES)("%s runs its turn's skill plan", (harnessId) => {
  it("for a run's frozen skills, files and captured server skill included", async () => {
    const run = await preparedRunSkills();
    const plan = resolveTurnSkills({
      source: run.pinnedSkillSource,
      runtime: runtimeOf(harnessId),
    });
    const reference = await selected(harnessId, {
      pinnedHarnessSkills: run.pinnedHarnessSkills,
    });
    expect(reference.mode).toBe("pinned");
    expect(reference.files.length).toBeGreaterThan(0);
    expect(await planned(plan, harnessId)).toEqual(reference);
  });

  it("for a run that froze no skills, which clears the box", async () => {
    const run = await preparedRunSkills([]);
    const plan = resolveTurnSkills({
      source: run.pinnedSkillSource,
      runtime: runtimeOf(harnessId),
    });
    const reference = await selected(harnessId, { pinnedHarnessSkills: [] });
    expect(reference).toMatchObject({ mode: "pinned", skills: [] });
    expect(await planned(plan, harnessId)).toEqual(reference);
  });

  it("for a turn that names no source, which leaves the box as it is", async () => {
    const plan = resolveTurnSkills({
      source: { kind: "none" },
      runtime: runtimeOf(harnessId),
    });
    const reference = await selected(harnessId, {});
    expect(reference).toMatchObject({ mode: "none", skills: null });
    expect(await planned(plan, harnessId)).toEqual(reference);
  });

  it.each([
    ["a named environment", undefined],
    ["a client's environment, whose servers are connected now", {}],
  ])("for %s", async (_name, liveExtras) => {
    const { spec, attribution } = evalEnvironment();
    const turn = environmentTurnSkills({
      spec,
      attribution,
      ...(liveExtras ? { liveExtras } : {}),
      runtime: runtimeOf(harnessId),
    });
    const reference = await selected(harnessId, legacyOf(turn));
    expect(reference.mode).toBe("environment");
    expect(reference.live).toBe(liveExtras !== undefined);
    expect(await planned(turn.skills, harnessId)).toEqual(reference);
  });

  it("for an environment whose files could not be read, which keeps the box's other files", async () => {
    const { spec, attribution } = evalEnvironment();
    const turn = environmentTurnSkills({
      spec,
      attribution,
      liveExtras: {},
      filesUnread: true,
      runtime: runtimeOf(harnessId),
    });
    const reference = await selected(harnessId, {
      runtimeSkillsOverride: runtimeSkills(spec),
      liveTurn: true,
    });
    expect(reference.complete).toEqual([false, false, false, false]);
    expect(await planned(turn.skills, harnessId)).toEqual(reference);
  });

  it("for a live turn that read no skills, which offers only its servers' own", async () => {
    const plan = resolveTurnSkills({
      source: { kind: "live", projectSkills: [] },
      runtime: runtimeOf(harnessId),
    });
    const reference = await selected(harnessId, { liveTurn: true });
    expect(reference).toMatchObject({ mode: "none", live: true });
    expect(await planned(plan, harnessId)).toEqual(reference);
  });

  it("serves a run's captured server skill as the copies it was frozen from do", async () => {
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
    const adapter = getHarnessAdapter(harnessId);
    const base = {
      mode: "pinned" as const,
      live: false,
      manager: NO_SERVERS,
      serverIds: [],
      messages: [],
    };
    const fromCopies = await harnessServerSkills(adapter, {
      ...base,
      pinnedHarnessSkills: run.pinnedHarnessSkills,
    });
    const fromPlan = await harnessServerSkills(adapter, {
      ...base,
      plannedServerSkills: plan.set.serverSkills,
    });
    expect(fromPlan?.served).toEqual(fromCopies?.served);
    expect(fromPlan?.promptSection).toEqual(fromCopies?.promptSection);
    const probe = async (
      turn: typeof fromCopies,
      tool: string,
      input: Record<string, unknown>,
    ) =>
      (
        turn?.tools[tool] as {
          execute: (input: unknown, options: unknown) => Promise<unknown>;
        }
      ).execute(input, { toolCallId: "probe", messages: [] });
    // Each answer is the skill's real text, so equal answers are not equal
    // refusals.
    for (const [tool, input, text] of [
      ["loadSkill", { name: "docs/search" }, "# Search"],
      ["listSkillFiles", { name: "docs/search" }, "docs/guide.md"],
      ["readSkillFile", { name: "docs/search", path: "docs/guide.md" }, "# Guide"],
    ] as const) {
      const expected = await probe(fromCopies, tool, input);
      expect(expected).toContain(text);
      expect(await probe(fromPlan, tool, input)).toEqual(expected);
    }
  });
});

describe("a plan made for another engine", () => {
  it("fails before it writes to a box", () => {
    const plan = resolveTurnSkills({
      source: { kind: "none" },
      runtime: runtimeOf("codex"),
    });
    expect(() => harnessTurnSkillsFromPlan(plan, "claude-code")).toThrow(
      "made for codex, but claude-code is running it",
    );
    expect(() =>
      harnessTurnSkillsFromPlan(
        resolveTurnSkills({ source: { kind: "none" }, runtime: { kind: "agent" } }),
        "codex",
      ),
    ).toThrow("made for MCPJam's agent");
  });
});
