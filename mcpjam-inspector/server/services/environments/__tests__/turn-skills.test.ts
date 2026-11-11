import { describe, expect, it } from "vitest";
import {
  resolveTurnSkills,
  toSkillsAtTurn,
  turnRuntime,
  turnSkillsFromLegacySource,
  type TurnSkills,
} from "../turn-skills";
import { buildLiveEffectiveCapabilities } from "../effective-capabilities";
import {
  agentReceives,
  authoredPin,
  namePin,
  pluginPin,
  preparedRunSkills,
  serverPin,
} from "../../../test/support/skill-delivery";

const AGENT = { kind: "agent" } as const;
const harness = (harnessId: string) =>
  ({ kind: "harness", harnessId }) as const;

const refs = (skills: TurnSkills) => skills.delivered.map((ref) => ref.ref);
const reasons = (skills: TurnSkills) =>
  skills.excluded.map(({ ref, reason }) => [ref.ref, reason]);

const LIVE_SET = buildLiveEffectiveCapabilities({
  standaloneSkills: [
    {
      skillId: "sk_deploy",
      ref: "deploy",
      name: "deploy",
      description: "Deploy.",
      content: "# Deploy",
      aggregateHash: "h",
      files: [],
      channels: [],
    },
  ],
});

describe("resolveTurnSkills", () => {
  it("plans no skills for a turn without a source, on either engine", () => {
    for (const runtime of [AGENT, harness("claude-code")]) {
      const skills = resolveTurnSkills({ source: { kind: "none" }, runtime });
      expect(skills).toMatchObject({
        runtime,
        delivered: [],
        excluded: [],
        serverSkillsVia: "none",
        agent: null,
      });
    }
  });

  it("plans no skills for a run that froze none", async () => {
    const run = await preparedRunSkills([]);
    const skills = resolveTurnSkills({
      source: run.pinnedSkillSource,
      runtime: AGENT,
    });
    expect(skills.agent).toBeNull();
    expect(skills.delivered).toEqual([]);
    expect(await agentReceives(skills)).toEqual({ listed: [], tools: [] });
  });

  it("serves a run with plugin, file or server pins through the ref tools", async () => {
    const run = await preparedRunSkills();
    const skills = resolveTurnSkills({
      source: run.pinnedSkillSource,
      runtime: AGENT,
    });
    expect(skills.agent).toEqual({ kind: "frozen" });
    expect(skills.set).toBe(run.pinnedSkillSource.set);
    expect(refs(skills)).toEqual([
      "release-notes",
      "acme/summarize",
      "docs/search",
    ]);
  });

  it("serves bare-name pins from before plugins through the same ref tools", async () => {
    const run = await preparedRunSkills([namePin("deploy"), namePin("triage")]);
    const skills = resolveTurnSkills({
      source: run.pinnedSkillSource,
      runtime: AGENT,
    });
    expect(skills.agent).toEqual({ kind: "frozen" });
    expect(refs(skills)).toEqual(["deploy", "triage"]);
    expect(skills.serverSkillsVia).toBe("agent-tools");
    const received = await agentReceives(skills);
    expect(received.listed).toEqual(["deploy", "triage"]);
    expect(received.tools).toContain("loadSkill");
  });

  it("reports a pin another skill's ref already holds as a name collision", async () => {
    const run = await preparedRunSkills([
      authoredPin(),
      namePin("release-notes", { skillId: "sk_other_release_notes" }),
    ]);
    const skills = resolveTurnSkills({
      source: run.pinnedSkillSource,
      runtime: AGENT,
    });
    expect(skills.delivered.map((ref) => ref.skillId)).toEqual([
      "sk_release_notes",
    ]);
    expect(
      skills.excluded.map(({ ref, reason }) => [ref.skillId, reason]),
    ).toEqual([["sk_other_release_notes", "name-collision"]]);
  });

  describe("a skill list over the model's budget", () => {
    // 1,000 tokens leave the list 80 characters: one skill and its line.
    const longDescription = "x".repeat(45);
    const pins = ["alpha", "bravo", "charlie"].map((name) =>
      namePin(name, { description: longDescription }),
    );

    it("leaves the omitted skills out of the list", async () => {
      const run = await preparedRunSkills(pins);
      const skills = resolveTurnSkills({
        source: run.pinnedSkillSource,
        runtime: AGENT,
        modelContextTokens: 1_000,
      });
      expect(refs(skills)).toEqual(["alpha"]);
      expect(reasons(skills)).toEqual([
        ["bravo", "omitted-from-catalog"],
        ["charlie", "omitted-from-catalog"],
      ]);
      expect(
        (await agentReceives(skills, { modelContextTokens: 1_000 })).listed,
      ).toEqual(["alpha"]);
    });

    it("leaves the omitted skills out of the ref list", async () => {
      const run = await preparedRunSkills([
        ...pins,
        authoredPin({ description: longDescription }),
      ]);
      const skills = resolveTurnSkills({
        source: run.pinnedSkillSource,
        runtime: AGENT,
        modelContextTokens: 1_000,
      });
      const received = await agentReceives(skills, {
        modelContextTokens: 1_000,
      });
      expect(refs(skills)).toEqual(received.listed);
      expect(skills.excluded.map(({ reason }) => reason)).toEqual([
        "omitted-from-catalog",
        "omitted-from-catalog",
        "omitted-from-catalog",
      ]);
    });
  });

  it("writes a pinned run's copies to a harness box, server skills as plain folders", async () => {
    const run = await preparedRunSkills();
    const skills = resolveTurnSkills({
      source: run.pinnedSkillSource,
      runtime: harness("claude-code"),
    });
    expect(skills.agent).toBeNull();
    expect(skills.serverSkillsVia).toBe("box-files");
    expect(skills.delivered.map((ref) => ref.name)).toEqual([
      "release-notes",
      "summarize",
      "search",
    ]);
  });

  it("reports a name a harness's adapter refuses", async () => {
    const run = await preparedRunSkills([
      namePin("deploy"),
      namePin("Deploy_Tool"),
    ]);
    const skills = resolveTurnSkills({
      source: run.pinnedSkillSource,
      runtime: harness("codex"),
    });
    expect(skills.delivered.map((ref) => ref.name)).toEqual(["deploy"]);
    expect(reasons(skills)).toEqual([["Deploy_Tool", "invalid-skill-name"]]);
  });

  it("serves a live set to MCPJam's agent, with the connected servers' skills", () => {
    const skills = resolveTurnSkills({
      source: { kind: "live", set: LIVE_SET },
      runtime: AGENT,
    });
    expect(skills.agent).toEqual({ kind: "live" });
    expect(skills.set).toBe(LIVE_SET);
    expect(refs(skills)).toEqual(["deploy"]);
  });

  it("hands a harness nothing from a live set, which its box fetches itself", () => {
    const skills = resolveTurnSkills({
      source: { kind: "live", set: LIVE_SET },
      runtime: harness("claude-code"),
    });
    expect(skills).toMatchObject({
      agent: null,
      delivered: [],
      excluded: [],
      serverSkillsVia: "none",
    });
  });

  it("reports every skill on a harness that takes none", async () => {
    const run = await preparedRunSkills();
    const skills = resolveTurnSkills({
      source: run.pinnedSkillSource,
      runtime: harness("cursor"),
    });
    expect(skills.delivered).toEqual([]);
    expect(skills.serverSkillsVia).toBe("none");
    expect(skills.excluded.map(({ reason }) => reason)).toEqual([
      "unsupported-harness",
      "unsupported-harness",
      "unsupported-harness",
    ]);
  });
});

describe("toSkillsAtTurn", () => {
  it("records each delivered pin's metadata row and nothing else", async () => {
    const run = await preparedRunSkills([authoredPin(), serverPin()]);
    const rows = toSkillsAtTurn(
      resolveTurnSkills({ source: run.pinnedSkillSource, runtime: AGENT }),
    );
    expect(rows).toEqual([
      {
        skillId: "sk_release_notes",
        projectSkillVersionId: "skv_release_notes_3",
        projectSkillVersionNumber: 3,
        versionPinned: false,
        name: "release-notes",
        description: "Write release notes from merged changes.",
        contentHash: "hash-release-notes",
        aggregateHash: "agg-release-notes",
        sharing: "project",
        channels: ["environment"],
      },
      {
        serverSkillId: "ss_docs_search",
        serverSkillVersionId: "ssv_docs_search_2",
        serverId: "srv_docs",
        serverLabel: "Docs",
        skillUri: "skill://docs/search",
        serverSkillVersionNumber: 2,
        serverSkillCapturedAt: 1_700_000_000_000,
        name: "search",
        description: "Search the docs server.",
        contentHash: "hash-search",
        modelRef: "docs/search",
        sharing: "project",
        channels: ["mcp-server"],
      },
    ]);
  });

  it("records only what the engine was handed", async () => {
    const run = await preparedRunSkills([
      namePin("deploy"),
      namePin("Deploy_Tool"),
    ]);
    const rows = toSkillsAtTurn(
      resolveTurnSkills({
        source: run.pinnedSkillSource,
        runtime: harness("codex"),
      }),
    );
    expect(rows.map((row) => row.name)).toEqual(["deploy"]);
  });

  it("leaves out a pin an older backend sent without its sharing", async () => {
    const run = await preparedRunSkills([
      namePin("deploy", { sharing: undefined }),
      namePin("triage"),
    ]);
    const rows = toSkillsAtTurn(
      resolveTurnSkills({ source: run.pinnedSkillSource, runtime: AGENT }),
    );
    expect(rows.map((row) => row.name)).toEqual(["triage"]);
  });
});

describe("turnRuntime", () => {
  it("runs a client's agent loop, else its harness, else MCPJam's agent", () => {
    expect(turnRuntime({ agentLoop: "codex", harness: "claude-code" })).toEqual(
      harness("codex"),
    );
    expect(turnRuntime({ harness: "claude-code" })).toEqual(
      harness("claude-code"),
    );
    expect(turnRuntime({})).toEqual(AGENT);
    expect(turnRuntime(undefined)).toEqual(AGENT);
  });
});

describe("turnSkillsFromLegacySource", () => {
  const set = LIVE_SET;

  it("gives a turn that says none no plan", () => {
    expect(turnSkillsFromLegacySource({ kind: "none" })).toBeUndefined();
  });

  it("keeps a live turn without skills of its own on the connected servers' skills", () => {
    const skills = turnSkillsFromLegacySource(undefined);
    expect(skills?.agent).toEqual({ kind: "live" });
    expect(skills?.delivered).toEqual([]);
  });

  it("tells an environment's set from a live one", () => {
    expect(
      turnSkillsFromLegacySource({ kind: "resolved", capabilities: set })
        ?.agent,
    ).toEqual({ kind: "environment" });
    const live = turnSkillsFromLegacySource({
      kind: "resolved",
      capabilities: set,
      composeLiveServerSkills: true,
    });
    expect(live?.agent).toEqual({ kind: "live" });
    expect(live && refs(live)).toEqual(["deploy"]);
  });
});
