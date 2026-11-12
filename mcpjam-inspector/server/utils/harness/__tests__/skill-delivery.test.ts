import { describe, expect, it, vi } from "vitest";
import {
  harnessTurnSkills,
  pinnedArtifactsToRuntimeSkills,
  selectHarnessSkillSource,
} from "../skill-delivery.js";
import { skillsFingerprint, type RuntimeSkill } from "../runtime-skills.js";
import type { PinnedSkillArtifact } from "../../../../shared/skill-types.js";
import { buildLiveEffectiveCapabilities } from "../../../services/environments/effective-capabilities.js";

const PINNED: PinnedSkillArtifact[] = [
  {
    skillId: "sk_pinned",
    name: "pinned-skill",
    description: "frozen",
    content: "frozen body",
    contentHash: "hash_pinned",
  },
];

const RESOLVED: RuntimeSkill[] = [
  {
    skillId: "sk_env",
    name: "env-skill",
    description: "resolved",
    content: "resolved body",
    aggregateHash: "hash_env",
  },
];

describe("selectHarnessSkillSource", () => {
  it("prefers frozen run artifacts over an environment override", () => {
    // Reproducibility outranks live resolution: a pinned run must re-execute
    // identically, so nothing live may be consulted — not even an environment.
    const source = selectHarnessSkillSource({
      pinnedHarnessSkills: PINNED,
      runtimeSkillsOverride: RESOLVED,
    });
    expect(source.mode).toBe("pinned");
    expect("skills" in source && source.skills).toEqual([
      {
        skillId: "sk_pinned",
        name: "pinned-skill",
        description: "frozen",
        content: "frozen body",
        aggregateHash: "hash_pinned",
      },
    ]);
  });

  it("uses the environment override when there is no pinned set", () => {
    const source = selectHarnessSkillSource({
      runtimeSkillsOverride: RESOLVED,
    });
    expect(source.mode).toBe("environment");
    expect("skills" in source && source.skills).toEqual(RESOLVED);
  });

  it("treats an EMPTY environment override as authoritative, not as absent", () => {
    // The regression this locks: falling through to `live` here would deliver
    // the whole project skill pool to a turn whose environment pinned none.
    const source = selectHarnessSkillSource({ runtimeSkillsOverride: [] });
    expect(source.mode).toBe("environment");
    expect("skills" in source && source.skills).toEqual([]);
  });

  it("treats an EMPTY pinned set as authoritative too", () => {
    const source = selectHarnessSkillSource({ pinnedHarnessSkills: [] });
    expect(source.mode).toBe("pinned");
    expect("skills" in source && source.skills).toEqual([]);
  });

  it("falls back to the live project-wide fetch only when neither is present", () => {
    expect(selectHarnessSkillSource({})).toEqual({ mode: "live" });
  });
});

describe("harnessTurnSkills", () => {
  const LIVE = [
    {
      skillId: "sk_notes",
      name: "notes",
      description: "n",
      content: "n",
      aggregateHash: "a",
    },
  ];
  const project = (
    over: {
      skills?: () => Promise<
        { ok: true; skills: RuntimeSkill[] } | { ok: false }
      >;
      files?: () => Promise<
        | {
            ok: true;
            files: Array<{
              skillId: string;
              path: string;
              size: number;
              url: string;
            }>;
          }
        | { ok: false }
      >;
    } = {},
  ) => ({
    skills: vi.fn(
      over.skills ?? (async () => ({ ok: true as const, skills: LIVE })),
    ),
    files: vi.fn(
      over.files ??
        (async () => ({
          ok: true as const,
          files: [
            { skillId: "sk_notes", path: "a.md", size: 1, url: "https://f/a" },
          ],
        })),
    ),
  });

  it("takes a run's frozen copies and reads nothing live", async () => {
    const live = project();
    const turn = await harnessTurnSkills({
      pinnedHarnessSkills: [
        { ...PINNED[0]!, files: [{ path: "scripts/run.sh", content: "echo" }] },
      ],
      project: live,
    });
    expect(turn.mode).toBe("pinned");
    expect(turn.skills?.map((entry) => entry.name)).toEqual(["pinned-skill"]);
    expect(turn.skillsHash).toBe(skillsFingerprint(turn.skills!));
    // Each copy's files ride with it, read at run start.
    const listing = await turn.readFiles();
    expect(listing.files).toEqual([
      { path: "scripts/run.sh", content: "echo", skillId: "sk_pinned" },
    ]);
    expect(listing.complete("sk_pinned")).toBe(true);
    expect(live.skills).not.toHaveBeenCalled();
    expect(live.files).not.toHaveBeenCalled();
  });

  it("takes an environment's files from its capability set, the only source of a plugin skill's", async () => {
    const live = project();
    const set = buildLiveEffectiveCapabilities({
      standaloneSkills: [
        {
          ...RESOLVED[0]!,
          ref: "env-skill",
          channels: ["environment"],
          files: [{ path: "ref.md", size: 3, url: "https://f/ref" }],
        },
      ],
    });
    const turn = await harnessTurnSkills({
      runtimeSkillsOverride: RESOLVED,
      effectiveCapabilities: set,
      project: live,
    });
    expect(turn.mode).toBe("environment");
    const files = await turn.readFiles();
    expect(files.files).toEqual([
      { skillId: "sk_env", path: "ref.md", size: 3, url: "https://f/ref" },
    ]);
    expect(live.files).not.toHaveBeenCalled();
  });

  it("leaves the set unknown when the live fetch fails, and reads the files only on demand", async () => {
    const live = project({ skills: async () => ({ ok: false }) });
    const turn = await harnessTurnSkills({ project: live });
    expect(turn).toMatchObject({
      mode: "live",
      skills: null,
      skillsHash: undefined,
    });
    expect(live.files).not.toHaveBeenCalled();
  });

  it("calls a turn live when its servers are connected now: a client's environment or the project's pool", async () => {
    const live = async (args: Parameters<typeof harnessTurnSkills>[0]) =>
      (await harnessTurnSkills(args)).live;
    expect(await live({ runtimeSkillsOverride: [], liveTurn: true })).toBe(
      true,
    );
    expect(await live({ project: project() })).toBe(true);
    // A named environment captured its server skills, and a run froze its own.
    expect(await live({ runtimeSkillsOverride: [] })).toBe(false);
    expect(await live({ pinnedHarnessSkills: [], liveTurn: true })).toBe(false);
  });

  it("knows none of the pool's files when their list could not be read", async () => {
    const turn = await harnessTurnSkills({
      project: project({ files: async () => ({ ok: false }) }),
    });
    expect(turn.skills).toEqual(LIVE);
    const files = await turn.readFiles();
    expect(files.files).toEqual([]);
    expect(files.complete("sk_notes")).toBe(false);
  });
});

const artifact = (
  over: Partial<PinnedSkillArtifact> = {}
): PinnedSkillArtifact => ({
  name: "my-skill",
  description: "does things",
  content: "# body",
  contentHash: "hash-1",
  ...over,
});

describe("pinnedArtifactsToRuntimeSkills", () => {
  it("maps artifacts onto the runtime-skill shape with aggregateHash = the pinned contentHash", () => {
    const skills = pinnedArtifactsToRuntimeSkills([
      artifact({ skillId: "sk1" }),
    ]);
    expect(skills).toEqual([
      {
        skillId: "sk1",
        name: "my-skill",
        description: "does things",
        content: "# body",
        aggregateHash: "hash-1",
      },
    ]);
  });

  it("synthesizes a content-derived skillId when the pin lost its source pointer", () => {
    const [s] = pinnedArtifactsToRuntimeSkills([artifact()]);
    expect(s!.skillId).toBe("pinned:hash-1");
  });

  it("skillsFingerprint over the mapped set derives from the pinned artifact fingerprints", () => {
    const a = skillsFingerprint(
      pinnedArtifactsToRuntimeSkills([artifact({ skillId: "sk1" })])
    );
    const b = skillsFingerprint(
      pinnedArtifactsToRuntimeSkills([
        artifact({ skillId: "sk1", contentHash: "hash-2" }),
      ])
    );
    expect(a).not.toBe(b); // a different pinned artifact ⇒ a different hash
    expect(skillsFingerprint(pinnedArtifactsToRuntimeSkills([]))).toBe(""); // empty pinned set ⇒ the stable empty sentinel
  });

  it("projects preserved frontmatter onto the known Agent-Skills envelope only", () => {
    const [s] = pinnedArtifactsToRuntimeSkills([
      artifact({
        frontmatter: {
          license: "MIT",
          "allowed-tools": ["Bash", "Read"],
          metadata: { origin: "plugin" },
          bogus: { nested: true },
        },
      }),
    ]);
    expect(s!.extraFrontmatter).toEqual({
      license: "MIT",
      allowedTools: ["Bash", "Read"],
      metadata: { origin: "plugin" },
    });
  });
});
