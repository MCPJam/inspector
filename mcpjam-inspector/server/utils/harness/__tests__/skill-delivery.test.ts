import { describe, expect, it } from "vitest";
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

  it("names no source when neither is present", () => {
    // The harness never reads a project's skills on its own: a turn that
    // names no source leaves its box as it is.
    expect(selectHarnessSkillSource({})).toEqual({ mode: "none" });
  });
});

describe("harnessTurnSkills", () => {
  it("takes a run's frozen copies, files included", async () => {
    const turn = await harnessTurnSkills({
      pinnedHarnessSkills: [
        { ...PINNED[0]!, files: [{ path: "scripts/run.sh", content: "echo" }] },
      ],
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
  });

  it("takes an environment's files from its capability set, the only source of a plugin skill's", async () => {
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
    });
    expect(turn.mode).toBe("environment");
    expect(turn.skills).toEqual(RESOLVED);
    const files = await turn.readFiles();
    expect(files.files).toEqual([
      { skillId: "sk_env", path: "ref.md", size: 3, url: "https://f/ref" },
    ]);
    expect(files.complete("sk_env")).toBe(true);
  });

  it("knows none of an environment's files without its capability set", async () => {
    const turn = await harnessTurnSkills({ runtimeSkillsOverride: RESOLVED });
    expect(turn.skills).toEqual(RESOLVED);
    const files = await turn.readFiles();
    expect(files.files).toEqual([]);
    // Unknown, so the writer keeps each skill's other files as they are.
    expect(files.complete("sk_env")).toBe(false);
  });

  it("leaves the box as it is when the turn names no source", async () => {
    const turn = await harnessTurnSkills({});
    expect(turn).toMatchObject({
      mode: "none",
      skills: null,
      skillsHash: undefined,
    });
    expect((await turn.readFiles()).files).toEqual([]);
  });

  it("calls a client's or a study's turn live, with or without skills of its own", async () => {
    const live = async (args: Parameters<typeof harnessTurnSkills>[0]) =>
      (await harnessTurnSkills(args)).live;
    expect(await live({ runtimeSkillsOverride: [], liveTurn: true })).toBe(
      true,
    );
    // A study whose Library could not be read still has its servers.
    expect(await live({ liveTurn: true })).toBe(true);
    // A named environment captured its server skills, and a run froze its own.
    expect(await live({ runtimeSkillsOverride: [] })).toBe(false);
    expect(await live({ pinnedHarnessSkills: [], liveTurn: true })).toBe(false);
    expect(await live({})).toBe(false);
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
