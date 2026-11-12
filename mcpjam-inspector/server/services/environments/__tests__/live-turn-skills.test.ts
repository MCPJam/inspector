import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedEnvironmentRuntime } from "../runtime";

const reads = vi.hoisted(() => ({
  fetchRuntimeSkills: vi.fn(),
  fetchRuntimeSkillFiles: vi.fn(),
}));

vi.mock("../../../utils/harness/runtime-skills.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../utils/harness/runtime-skills.js")
  >()),
  fetchRuntimeSkills: reads.fetchRuntimeSkills,
  fetchRuntimeSkillFiles: reads.fetchRuntimeSkillFiles,
}));

import {
  environmentTurnSkills,
  studyLibraryTurnSkills,
  turnSkillProvenance,
} from "../live-turn-skills";
import { resolveTurnSkills } from "../turn-skills";

const AGENT = { kind: "agent" } as const;
const harness = (harnessId: string) =>
  ({ kind: "harness", harnessId }) as const;

const ENVIRONMENT_REF = {
  environmentId: "env_1",
  name: "Staging",
  revision: 7,
};

const AUTHORED_ROW = {
  skillId: "sk_1",
  projectSkillVersionNumber: 3,
  versionPinned: true,
  name: "pdf-processing",
  contentHash: "h1",
  sharing: "project",
  channels: ["host", "environment"],
};
const SERVER_ROW = {
  serverSkillId: "ss_1",
  serverSkillVersionId: "ssv_1",
  serverSkillVersionNumber: 2,
  name: "refunds",
  modelRef: "acme/refunds",
  contentHash: "h_capture",
  sharing: "project",
  channels: ["mcp-server"],
};

/** An environment with an authored skill and a captured server skill. */
function environment(
  overrides: Partial<ResolvedEnvironmentRuntime> = {},
): ResolvedEnvironmentRuntime {
  return {
    environmentRef: ENVIRONMENT_REF,
    host: { hostId: "host_1", runtimeConfig: {} },
    servers: { effectiveServerIds: ["srv_1"] },
    skills: [
      {
        skillId: "sk_1",
        name: "pdf-processing",
        description: "Process PDFs",
        content: "SECRET INSTRUCTIONS",
        aggregateHash: "agg1",
        channels: ["host", "environment"],
        provenance: AUTHORED_ROW,
        files: [{ path: "ref.md", size: 3, url: "https://signed/ref" }],
      },
    ],
    serverSkills: [
      {
        serverSkillId: "ss_1",
        versionId: "ssv_1",
        serverId: "srv_1",
        serverSlug: "acme",
        serverLabel: "Acme",
        ref: "acme/refunds",
        skillUri: "skill://acme/refunds/SKILL.md",
        name: "refunds",
        description: "Handle refunds",
        content: "CAPTURED SECRET",
        contentSha256: "raw-digest",
        versionHash: "vh_1",
        versionNumber: 2,
        capturedAt: 1,
        provenance: SERVER_ROW,
        files: [],
      },
    ],
    ...overrides,
  };
}

describe("environmentTurnSkills", () => {
  it("records every skill MCPJam's agent is handed, captures included, with the environment binding", () => {
    const turn = environmentTurnSkills({
      spec: environment(),
      attribution: null,
      runtime: AGENT,
    });
    expect(turn.turnProvenance).toEqual({
      environmentAtTurn: ENVIRONMENT_REF,
      skillsAtTurn: [AUTHORED_ROW, SERVER_ROW],
    });
    // Provenance is metadata: no skill's content rides the record.
    expect(JSON.stringify(turn.turnProvenance)).not.toContain("SECRET");
  });

  it("records only what a harness's box gets: a live turn leaves captures off it", () => {
    const turn = environmentTurnSkills({
      spec: environment(),
      attribution: null,
      runtime: harness("claude-code"),
    });
    expect(turn.turnProvenance?.skillsAtTurn).toEqual([AUTHORED_ROW]);
    expect(turn.skills.excluded).toEqual([
      expect.objectContaining({ reason: "server-skill-unsupported" }),
    ]);
  });

  it("records nothing delivered on a harness with no skill channel", () => {
    const turn = environmentTurnSkills({
      spec: environment(),
      attribution: null,
      runtime: harness("cursor"),
    });
    expect(turn.turnProvenance).toEqual({
      environmentAtTurn: ENVIRONMENT_REF,
      skillsAtTurn: [],
    });
  });

  it("skips a skill the backend sent no metadata row for", () => {
    const spec = environment();
    const turn = environmentTurnSkills({
      spec: {
        ...spec,
        skills: spec.skills!.map(({ provenance: _row, ...skill }) => skill),
      },
      attribution: null,
      runtime: AGENT,
    });
    expect(turn.turnProvenance?.skillsAtTurn).toEqual([SERVER_ROW]);
  });

  it("hands a harness the environment's skills and the set that carries their files", () => {
    const turn = environmentTurnSkills({
      spec: environment(),
      attribution: null,
      runtime: harness("claude-code"),
    });
    expect(turn.box?.skills.map((skill) => skill.name)).toEqual([
      "pdf-processing",
    ]);
    expect(turn.box?.set?.standaloneSkills[0]?.files).toEqual([
      { path: "ref.md", size: 3, url: "https://signed/ref" },
    ]);
  });

  it("plans a client's turn as live and a named environment's as captured", () => {
    const client = environmentTurnSkills({
      spec: environment(),
      attribution: null,
      liveExtras: {},
      runtime: AGENT,
    });
    const named = environmentTurnSkills({
      spec: environment(),
      attribution: null,
      runtime: AGENT,
    });
    expect(client.skills.agent).toEqual({ kind: "live" });
    expect(named.skills.agent).toEqual({ kind: "environment" });
    // The same answer reaches a harness, as `liveTurn`.
    expect(client.live).toBe(true);
    expect(named.live).toBe(false);
  });
});

describe("turnSkillProvenance", () => {
  const skills = resolveTurnSkills({
    source: { kind: "none" },
    runtime: AGENT,
  });

  it("records nothing without an environment to name", () => {
    expect(turnSkillProvenance(undefined, skills)).toBeUndefined();
  });

  it("rejects an EMPTY environment name rather than recording a blank one", () => {
    // `readScenarioEnvironment` reads a missing name as `""`, which would
    // export as a real environment called nothing.
    expect(
      turnSkillProvenance({ ...ENVIRONMENT_REF, name: "" }, skills),
    ).toBeUndefined();
  });

  it("records an empty list for a turn that ran with none", () => {
    expect(turnSkillProvenance(ENVIRONMENT_REF, skills)).toEqual({
      environmentAtTurn: ENVIRONMENT_REF,
      skillsAtTurn: [],
    });
  });
});

describe("studyLibraryTurnSkills", () => {
  const SHARED = {
    skillId: "sk_shared",
    name: "onboarding",
    description: "Project onboarding",
    content: "onboarding body",
    aggregateHash: "agg_shared",
  };
  const SCOPE = {
    kind: "swarm" as const,
    swarmId: "sw_1",
    accessVersion: 3,
    projectId: "p_1",
    workspaceId: "ws_1",
  };

  beforeEach(() => {
    reads.fetchRuntimeSkills.mockReset().mockResolvedValue({
      ok: true,
      skills: [SHARED],
    });
    reads.fetchRuntimeSkillFiles.mockReset().mockResolvedValue({
      ok: true,
      files: [
        { skillId: "sk_shared", path: "guide.md", size: 5, url: "https://f/g" },
      ],
    });
  });

  it("reads the study's Library through its scope and plans a live turn", async () => {
    const turn = await studyLibraryTurnSkills({
      bearer: "Bearer tester",
      projectId: "p_1",
      executionScope: SCOPE,
      runtime: AGENT,
    });
    expect(reads.fetchRuntimeSkills).toHaveBeenCalledWith(
      "Bearer tester",
      "p_1",
      SCOPE,
    );
    expect(turn.skills.delivered.map((ref) => ref.ref)).toEqual(["onboarding"]);
    // The study's servers are connected now, so their own skills join.
    expect(turn.skills.agent).toEqual({ kind: "live" });
    expect(turn.live).toBe(true);
    expect(turn.skills.set.standaloneSkills[0]?.files).toEqual([
      { path: "guide.md", size: 5, url: "https://f/g" },
    ]);
    // A study with no environment names none to record.
    expect(turn.turnProvenance).toBeUndefined();
  });

  it("keeps the turn live, and a harness's box as it is, when the Library can't be read", async () => {
    reads.fetchRuntimeSkills.mockResolvedValue({ ok: false });
    const turn = await studyLibraryTurnSkills({
      bearer: "Bearer tester",
      projectId: "p_1",
      runtime: harness("claude-code"),
    });
    expect(turn.skills.delivered).toEqual([]);
    expect(turn.box).toBeUndefined();
    expect(turn.live).toBe(true);
  });

  it("writes each skill's SKILL.md and keeps its other files when their list can't be read", async () => {
    reads.fetchRuntimeSkillFiles.mockResolvedValue({ ok: false });
    const turn = await studyLibraryTurnSkills({
      bearer: "Bearer tester",
      projectId: "p_1",
      runtime: harness("claude-code"),
    });
    expect(turn.box).toEqual({
      skills: [{ ...SHARED }],
    });
  });
});
