import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { materializeSkillFiles } from "../materialize-skill-files";
import { runtimeSkills } from "../../../services/environments/runtime";
import { resolveEffectiveCapabilities } from "../../../services/environments/effective-capabilities";
import {
  capabilitySkillFiles,
  deliveredPluginSkillOrigins,
  pluginSkillDeliverySummary,
  pluginVersionsFingerprint,
  selectDeliverableServerIds,
} from "../plugin-delivery";
import { getHarnessAdapter } from "../registry";
import type {
  EffectiveCapabilitySet,
  RuntimePluginVersion,
} from "../../../services/environments/effective-capabilities";

const version = (
  over: Partial<RuntimePluginVersion> = {}
): RuntimePluginVersion => ({
  pluginId: "plg_1",
  pluginVersionId: "pv_1",
  name: "weather",
  bundleHash: "hash-a",
  ...over,
});

function capabilities(
  over: Partial<EffectiveCapabilitySet> = {}
): EffectiveCapabilitySet {
  return {
    explicitServerIds: [],
    pluginServerIds: [],
    effectiveServerIds: [],
    servers: [],
    pluginSkills: [],
    standaloneSkills: [],
    serverSkills: [],
    localSkills: [],
    pluginVersions: [],
    problems: [],
    ...over,
  };
}

describe("capabilitySkillFiles", () => {
  it("carries a PLUGIN skill's supporting files — the project-wide file query cannot", () => {
    // Regression for the INS-7 gap: `listSkillFilesForRuntime` filters through
    // `isStandaloneSkill`, so a plugin skill's files never came back from it and
    // the skill reached the Computer as a bare SKILL.md.
    const set = capabilities({
      pluginSkills: [
        {
          ref: "weather/forecast",
          skillId: "sk_plugin",
          name: "forecast",
          description: "d",
          content: "c",
          aggregateHash: "agg",
          files: [
            { path: "scripts/run.py", size: 12, url: "https://blob/1" },
            { path: "references/api.md", size: 3, url: "https://blob/2" },
          ],
          plugin: version(),
        },
      ],
      standaloneSkills: [
        {
          ref: "notes",
          skillId: "sk_standalone",
          name: "notes",
          description: "d",
          content: "c",
          aggregateHash: "agg2",
          files: [{ path: "assets/logo.png", size: 7, url: "https://blob/3" }],
          channels: ["environment"],
        },
      ],
    });

    expect(capabilitySkillFiles(set)).toEqual([
      {
        skillId: "sk_plugin",
        path: "scripts/run.py",
        size: 12,
        url: "https://blob/1",
      },
      {
        skillId: "sk_plugin",
        path: "references/api.md",
        size: 3,
        url: "https://blob/2",
      },
      {
        skillId: "sk_standalone",
        path: "assets/logo.png",
        size: 7,
        url: "https://blob/3",
      },
    ]);
  });

  it("keeps a file whose signed URL is missing so the writer skips it instead of PRUNING it", () => {
    const set = capabilities({
      standaloneSkills: [
        {
          ref: "notes",
          skillId: "sk_1",
          name: "notes",
          description: "d",
          content: "c",
          aggregateHash: "agg",
          files: [{ path: "a.txt", size: 1, url: null }],
          channels: ["host"],
        },
      ],
    });
    expect(capabilitySkillFiles(set)).toEqual([
      { skillId: "sk_1", path: "a.txt", size: 1, url: null },
    ]);
  });

  it("is empty for a set that resolves no files", () => {
    expect(capabilitySkillFiles(capabilities())).toEqual([]);
  });
});

describe("pluginVersionsFingerprint", () => {
  it("is empty for no plugins — a plugin-less turn adds no fingerprint dimension", () => {
    expect(pluginVersionsFingerprint([])).toBe("");
  });

  it("is order-independent (pin order must not fork a session)", () => {
    const a = version({ pluginVersionId: "pv_a", bundleHash: "h1" });
    const b = version({ pluginVersionId: "pv_b", bundleHash: "h2" });
    expect(pluginVersionsFingerprint([a, b])).toBe(
      pluginVersionsFingerprint([b, a])
    );
  });

  it("changes when the pinned VERSION changes (environment upgraded)", () => {
    expect(
      pluginVersionsFingerprint([version({ pluginVersionId: "pv_1" })])
    ).not.toBe(
      pluginVersionsFingerprint([version({ pluginVersionId: "pv_2" })])
    );
  });

  it("changes when the bundle CONTENT changes under the same id", () => {
    expect(
      pluginVersionsFingerprint([version({ bundleHash: "hash-a" })])
    ).not.toBe(pluginVersionsFingerprint([version({ bundleHash: "hash-b" })]));
  });

  it("treats an unknown (null) bundle hash as distinct from any known hash", () => {
    // Deploy skew must not read as "same content as before".
    expect(pluginVersionsFingerprint([version({ bundleHash: null })])).not.toBe(
      pluginVersionsFingerprint([version({ bundleHash: "hash-a" })])
    );
  });

  it("does not collide when a hash is dropped vs. renamed", () => {
    const one = pluginVersionsFingerprint([
      version({ pluginVersionId: "pv_1", bundleHash: "h" }),
      version({ pluginVersionId: "pv_2", bundleHash: "h" }),
    ]);
    const two = pluginVersionsFingerprint([
      version({ pluginVersionId: "pv_1", bundleHash: "h" }),
    ]);
    expect(one).not.toBe(two);
  });
});

describe("selectDeliverableServerIds", () => {
  it("skips a host-selected server with no live config (unchanged behavior)", () => {
    const onSkipped = vi.fn();
    const ids = selectDeliverableServerIds({
      selectedServerIds: ["srv_live", "srv_dead"],
      hasLiveConfig: (id) => id === "srv_live",
      onSkipped,
    });
    expect(ids).toEqual(["srv_live"]);
    expect(onSkipped).toHaveBeenCalledWith("srv_dead");
  });

  it("FAILS CLOSED on an undeliverable PLUGIN server, naming the plugin", () => {
    // Hosts are plugin-blind, so a silently dropped plugin server is invisible
    // to the user — it must be a loud failure, not a warning.
    expect(() =>
      selectDeliverableServerIds({
        selectedServerIds: ["srv_plugin"],
        hasLiveConfig: () => false,
        pluginOrigins: { srv_plugin: version({ name: "weather" }) },
      })
    ).toThrow(/Plugin "weather"/);
  });

  it("delivers a plugin server that IS live, through the ordinary path", () => {
    const ids = selectDeliverableServerIds({
      selectedServerIds: ["srv_plugin", "srv_host"],
      hasLiveConfig: () => true,
      pluginOrigins: { srv_plugin: version() },
    });
    expect(ids).toEqual(["srv_plugin", "srv_host"]);
  });
});

// ── End-to-end: resolved environment spec → Computer sandbox ────────────────
// Exercises the real chain INS-7 wires: the backend's resolved runtime spec →
// `resolveEffectiveCapabilities` (INS-3) → `capabilitySkillFiles` →
// `materializeSkillFiles` (the existing Computer writer), against a fake
// sandbox session. The regression it guards: a PLUGIN skill's supporting files
// reaching the box at all.
describe("plugin delivery into a Computer sandbox (end-to-end)", () => {
  const SKILLS_BASE = "/home/user/.claude/skills";

  function fakeSession(onBoxFiles: string[] = []) {
    const writes: { path: string; bytes: number }[] = [];
    const removed: string[] = [];
    return {
      session: {
        writeBinaryFile: vi.fn(
          async ({ path, content }: { path: string; content: Uint8Array }) => {
            writes.push({ path, bytes: content.byteLength });
          }
        ),
        run: vi.fn(async ({ command }: { command: string }) => {
          if (command.startsWith("find")) {
            return { exitCode: 0, stdout: onBoxFiles.join("\n"), stderr: "" };
          }
          const m = command.match(/rm -f -- '(.*)'$/);
          if (m) removed.push(m[1]!);
          return { exitCode: 0, stdout: "", stderr: "" };
        }),
      },
      writes,
      removed,
    };
  }

  const spec = {
    environmentRef: { environmentId: "env_1", name: "Prod", revision: 3 },
    host: { hostId: "host_1", runtimeConfig: {} },
    servers: {
      effectiveServerIds: ["srv_plugin"],
      pluginServerIds: ["srv_plugin"],
      connectable: [
        { serverId: "srv_plugin", name: "Weather", source: "plugin" as const },
      ],
    },
    skills: [
      {
        skillId: "sk_plugin",
        name: "forecast",
        description: "d",
        content: "c",
        aggregateHash: "agg",
        channels: ["plugin" as const],
        files: [{ path: "scripts/run.py", size: 5, url: "https://blob/1" }],
      },
      {
        skillId: "sk_env",
        name: "notes",
        description: "d",
        content: "c",
        aggregateHash: "agg2",
        channels: ["environment" as const],
        files: [{ path: "references/a.md", size: 5, url: "https://blob/2" }],
      },
    ],
    pluginVersions: [
      {
        pluginId: "plg_1",
        pluginVersionId: "pv_1",
        name: "weather",
        bundleHash: "hash-a",
      },
    ],
  };

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5]).buffer,
      }))
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("writes BOTH a plugin skill's and an environment skill's supporting files onto the box", async () => {
    const set = resolveEffectiveCapabilities(spec, null);
    const skills = runtimeSkills(spec);
    const { session, writes } = fakeSession();

    const result = await materializeSkillFiles({
      session,
      files: capabilitySkillFiles(set),
      skillNamesById: new Map(skills.map((s) => [s.skillId, s.name])),
    });

    expect(result).toEqual({ written: 2, skipped: 0 });
    expect(writes.map((w) => w.path)).toEqual([
      `${SKILLS_BASE}/forecast/scripts/run.py`,
      `${SKILLS_BASE}/notes/references/a.md`,
    ]);
  });

  it("materializes into the CODEX root when the turn's adapter is codex (INS-8)", async () => {
    // Same resolved capabilities, different runtime: the writer must follow the
    // adapter's own root, or a Codex turn's plugin skill would get its SKILL.md
    // from codex (`~/.agents/skills`) and its supporting files somewhere codex
    // never reads.
    const set = resolveEffectiveCapabilities(spec, null);
    const skills = runtimeSkills(spec);
    const { session, writes } = fakeSession();

    await materializeSkillFiles({
      session,
      files: capabilitySkillFiles(set),
      skillNamesById: new Map(skills.map((s) => [s.skillId, s.name])),
      skillsBase: getHarnessAdapter("codex").skillsBaseDir,
    });

    expect(writes.map((w) => w.path)).toEqual([
      "/home/user/.agents/skills/forecast/scripts/run.py",
      "/home/user/.agents/skills/notes/references/a.md",
    ]);
  });

  it("prunes a plugin skill file the new version dropped", async () => {
    const set = resolveEffectiveCapabilities(spec, null);
    const skills = runtimeSkills(spec);
    const { session, removed } = fakeSession([
      `${SKILLS_BASE}/forecast/scripts/run.py`,
      `${SKILLS_BASE}/forecast/scripts/gone.py`,
    ]);

    await materializeSkillFiles({
      session,
      files: capabilitySkillFiles(set),
      skillNamesById: new Map(skills.map((s) => [s.skillId, s.name])),
    });

    expect(removed).toEqual([`${SKILLS_BASE}/forecast/scripts/gone.py`]);
  });

  it("carries the pinned versions into a fingerprint that forks on an upgrade", () => {
    const before = resolveEffectiveCapabilities(spec, null);
    const after = resolveEffectiveCapabilities(
      {
        ...spec,
        pluginVersions: [
          { ...spec.pluginVersions[0]!, pluginVersionId: "pv_2" },
        ],
      },
      null
    );
    expect(pluginVersionsFingerprint(before.pluginVersions)).not.toBe(
      pluginVersionsFingerprint(after.pluginVersions)
    );
  });
});

describe("pluginSkillDeliverySummary", () => {
  it("reports ref, file count and version — provenance for the delivery log", () => {
    const set = capabilities({
      pluginSkills: [
        {
          ref: "weather/forecast",
          skillId: "sk_1",
          name: "forecast",
          description: "d",
          content: "c",
          aggregateHash: "agg",
          files: [{ path: "a.txt", size: 1, url: "https://blob/1" }],
          plugin: version({ pluginVersionId: "pv_9" }),
        },
      ],
    });
    expect(pluginSkillDeliverySummary(set)).toEqual([
      {
        ref: "weather/forecast",
        name: "forecast",
        fileCount: 1,
        pluginVersionId: "pv_9",
      },
    ]);
  });

  it("reports a null version when attribution was unavailable", () => {
    const set = capabilities({
      pluginSkills: [
        {
          ref: "forecast",
          skillId: "sk_1",
          name: "forecast",
          description: "d",
          content: "c",
          aggregateHash: "agg",
          files: [],
        },
      ],
    });
    expect(pluginSkillDeliverySummary(set)[0]?.pluginVersionId).toBeNull();
  });
});

describe("deliveredPluginSkillOrigins (INS-8 origin mapping)", () => {
  const pluginSkill = (over: Record<string, unknown> = {}) => ({
    ref: "weather/forecast",
    skillId: "sk_1",
    name: "forecast",
    description: "d",
    content: "c",
    aggregateHash: "agg",
    files: [],
    plugin: version({ pluginVersionId: "pv_9", bundleHash: "hash-z" }),
    ...over,
  });

  it("maps the on-box dir of a delivered skill to its immutable plugin revision", () => {
    const set = capabilities({ pluginSkills: [pluginSkill()] });
    expect(
      deliveredPluginSkillOrigins({
        set,
        skillsBaseDir: getHarnessAdapter("codex").skillsBaseDir,
        deliveredNameBySkillId: new Map([["sk_1", "forecast"]]),
      })
    ).toEqual([
      {
        skillId: "sk_1",
        ref: "weather/forecast",
        dir: "/home/user/.agents/skills/forecast",
        pluginId: "plg_1",
        pluginVersionId: "pv_9",
        bundleHash: "hash-z",
      },
    ]);
  });

  it("keys the dir off the RUNTIME's root, so the same skill maps per harness", () => {
    const set = capabilities({ pluginSkills: [pluginSkill()] });
    const delivered = new Map([["sk_1", "forecast"]]);
    expect(
      deliveredPluginSkillOrigins({
        set,
        skillsBaseDir: getHarnessAdapter("claude-code").skillsBaseDir,
        deliveredNameBySkillId: delivered,
      })[0]?.dir
    ).toBe("/home/user/.claude/skills/forecast");
  });

  it("omits a skill the adapter did NOT deliver — provenance records what RAN", () => {
    const set = capabilities({
      pluginSkills: [pluginSkill(), pluginSkill({ skillId: "sk_2" })],
    });
    const origins = deliveredPluginSkillOrigins({
      set,
      skillsBaseDir: getHarnessAdapter("codex").skillsBaseDir,
      deliveredNameBySkillId: new Map([["sk_1", "forecast"]]),
    });
    expect(origins.map((o) => o.skillId)).toEqual(["sk_1"]);
  });

  it("omits standalone skills and unattributed plugin skills", () => {
    const set = capabilities({
      pluginSkills: [pluginSkill({ plugin: undefined })],
      standaloneSkills: [
        {
          ref: "notes",
          skillId: "sk_std",
          name: "notes",
          description: "d",
          content: "c",
          aggregateHash: "agg",
          files: [],
          channels: ["environment"],
        },
      ],
    });
    expect(
      deliveredPluginSkillOrigins({
        set,
        skillsBaseDir: getHarnessAdapter("codex").skillsBaseDir,
        deliveredNameBySkillId: new Map([
          ["sk_1", "forecast"],
          ["sk_std", "notes"],
        ]),
      })
    ).toEqual([]);
  });
});
