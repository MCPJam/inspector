/**
 * Fixtures and engine probes for the skill-delivery matrix
 * (`services/environments/__tests__/skill-delivery-matrix.test.ts`) and the
 * turn-skills tests.
 *
 * The fixtures go through the real preparation code; the probes read what an
 * engine is handed through the code each engine runs, never through
 * `resolveTurnSkills` itself.
 */
import type { PinnedSkillArtifact } from "../../../shared/skill-types.js";
import type {
  EffectiveCapabilitySet,
  RuntimeStandaloneSkill,
} from "../../services/environments/effective-capabilities.js";
import type { PluginRuntimeAttribution } from "../../services/environments/plugin-attribution.js";
import {
  runtimeSkills,
  type ResolvedEnvironmentRuntime,
} from "../../services/environments/runtime.js";
import { buildPinnedSkillSource } from "../../services/evals/pinned-skill-source.js";
import {
  pinnedSkillMeta,
  type RunPinnedPluginVersion,
  type RunPinnedSkill,
} from "../../services/evals/run-plugin-snapshot.js";
import type { TurnSkills } from "../../services/environments/turn-skills.js";
import { prepareChatV2 } from "../../utils/chat-v2-orchestration.js";
import {
  planBoxSkills,
  writeBoxSkills,
} from "../../utils/harness/box-skills-writer.js";
import {
  harnessServerSkills,
  withServedSkills,
} from "../../utils/harness/harness-server-skills.js";
import { getHarnessAdapter } from "../../utils/harness/registry.js";
import { takesServerSkillsAsTools } from "../../utils/harness/skills-descriptor.js";
import type { RuntimeSkill } from "../../utils/harness/runtime-skills.js";
import {
  harnessTurnSkills,
  selectHarnessSkillSource,
} from "../../utils/harness/skill-delivery.js";
import { BOX_HOME, fakeSkillBox, type FakeSkillBox } from "./fake-skill-box.js";

/** A supporting file as a run snapshot serves it, readable without a network. */
function dataUrl(text: string, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(text).toString("base64")}`;
}

export const EVAL_PLUGIN_VERSIONS: RunPinnedPluginVersion[] = [
  {
    pluginId: "plg_acme",
    pluginVersionId: "plv_acme_1",
    name: "acme",
    bundleHash: "bundle0001",
  },
];

/** An authored Library skill with one supporting file. */
export function authoredPin(
  overrides: Partial<RunPinnedSkill> = {},
): RunPinnedSkill {
  return {
    skillId: "sk_release_notes",
    projectSkillVersionId: "skv_release_notes_3",
    projectSkillVersionNumber: 3,
    versionPinned: false,
    name: "release-notes",
    description: "Write release notes from merged changes.",
    content: "# Release notes\n\nRun scripts/check.sh first.",
    contentHash: "hash-release-notes",
    aggregateHash: "agg-release-notes",
    sharing: "project",
    channels: ["environment"],
    files: [
      {
        path: "scripts/check.sh",
        contentHash: "hash-check",
        size: 23,
        url: dataUrl("#!/bin/sh\necho checked\n", "text/x-shellscript"),
      },
    ],
    ...overrides,
  };
}

/** A plugin's skill, addressed `<plugin>/<skill>`. */
export function pluginPin(
  overrides: Partial<RunPinnedSkill> = {},
): RunPinnedSkill {
  return {
    skillId: "sk_acme_summarize",
    name: "summarize",
    description: "Summarize a document the acme way.",
    content: "# Summarize",
    contentHash: "hash-summarize",
    modelRef: "acme/summarize",
    sharing: "project",
    channels: ["plugin"],
    ...overrides,
  };
}

/** A skill captured from a connected MCP server. */
export function serverPin(
  overrides: Partial<RunPinnedSkill> = {},
): RunPinnedSkill {
  return {
    serverSkillId: "ss_docs_search",
    serverSkillVersionId: "ssv_docs_search_2",
    serverId: "srv_docs",
    serverLabel: "Docs",
    skillUri: "skill://docs/search",
    serverSkillVersionNumber: 2,
    serverSkillCapturedAt: 1_700_000_000_000,
    name: "search",
    description: "Search the docs server.",
    content: "# Search",
    contentHash: "hash-search",
    modelRef: "docs/search",
    sharing: "project",
    channels: ["mcp-server"],
    ...overrides,
  };
}

/** A bare-name pin, as every eval run before plugins froze its skills. */
export function namePin(
  name: string,
  overrides: Partial<RunPinnedSkill> = {},
): RunPinnedSkill {
  return {
    skillId: `sk_${name}`,
    name,
    description: `The ${name} skill.`,
    content: `# ${name}`,
    contentHash: `hash-${name}`,
    sharing: "project",
    channels: ["environment"],
    ...overrides,
  };
}

/** The eval fixture: an authored skill with a file, a plugin skill and a
 *  captured server skill. Personal and machine skills never reach a run's
 *  pins, so the eval surface has none. */
export function evalRunPins(): RunPinnedSkill[] {
  return [authoredPin(), pluginPin(), serverPin()];
}

/** A run's frozen skills, prepared by the code run preparation uses. */
export function preparedRunSkills(pins: RunPinnedSkill[] = evalRunPins()) {
  return buildPinnedSkillSource({
    pins,
    pluginVersions: EVAL_PLUGIN_VERSIONS,
    pluginServers: [],
    effectiveServerIds: ["srv_docs"],
    serverNames: ["Docs"],
  });
}

const SKILL_TOOLS = ["loadSkill", "listSkillFiles", "readSkillFile"];

interface AgentProbeOptions {
  modelContextTokens?: number;
  harness?: string;
}

/** The turn `prepareChatV2` builds for a plan, with no servers connected. */
function prepareAgentTurn(
  skills: TurnSkills,
  { modelContextTokens, harness }: AgentProbeOptions,
) {
  return prepareChatV2({
    mcpClientManager: {
      getToolsForAiSdk: async () => ({}),
      listTools: async () => ({ tools: [] }),
      getSkillsSupport: () => ({
        declared: false,
        advertised: false,
        directoryRead: false,
        active: false,
      }),
    } as never,
    selectedServers: [],
    modelDefinition: {
      id: "gpt-4.1",
      provider: "openai",
      ...(modelContextTokens !== undefined
        ? { contextLength: modelContextTokens }
        : {}),
    } as never,
    systemPrompt: "Base prompt.",
    ...(harness ? { harness: harness as never } : {}),
    skills,
  });
}

/**
 * What MCPJam's agent is handed for a plan, read off the turn `prepareChatV2`
 * builds: the skill refs its prompt lists and the skill tools it gets. With
 * `harness`, MCPJam's side of a harness turn.
 */
export async function agentReceives(
  skills: TurnSkills,
  options: AgentProbeOptions = {},
): Promise<{ listed: string[]; tools: string[] }> {
  const prepared = await prepareAgentTurn(skills, options);
  const section =
    prepared.enhancedSystemPrompt.split("## Skills")[1]?.split("\n## ")[0] ??
    "";
  return {
    listed: [...section.matchAll(/^- \*\*(.+?)\*\*/gm)].map(
      (match) => match[1]!,
    ),
    tools: Object.keys(prepared.allTools).filter((name) =>
      SKILL_TOOLS.includes(name),
    ),
  };
}

/**
 * What MCPJam's agent gets back when its model asks `loadSkill` for `ref` on
 * the turn `prepareChatV2` builds for a plan: the skill's text, or the tool's
 * error.
 */
export async function agentLoads(
  skills: TurnSkills,
  ref: string,
  options: AgentProbeOptions = {},
): Promise<string> {
  const { allTools } = await prepareAgentTurn(skills, options);
  const output = await allTools.loadSkill?.execute?.(
    { name: ref },
    { toolCallId: "probe", messages: [], context: {} },
  );
  if (typeof output !== "string") {
    throw new Error(`The agent's loadSkill returned no text for ${ref}.`);
  }
  return output;
}

/**
 * One harness turn's box write, as `runHarnessTurn` makes it: the turn's
 * skills read from their source, planned by the runtime's rules (none on a
 * runtime that takes none), written to `box` by the box writer, and reported
 * with the server skills the turn's tools served.
 */
export async function writeTurnToBox(
  harnessId: string,
  source: Parameters<typeof harnessTurnSkills>[0],
  box: FakeSkillBox,
) {
  const adapter = getHarnessAdapter(harnessId);
  const turn = await harnessTurnSkills({
    ...source,
    serverSkillsAsTools: takesServerSkillsAsTools(adapter),
  });
  const plan = planBoxSkills(
    adapter.skills,
    adapter.supportsSkills ? (turn.skills ?? []) : [],
  );
  const written = await writeBoxSkills({
    session: box.session,
    descriptor: adapter.skills,
    home: BOX_HOME,
    plan,
    readFiles: turn.readFiles,
  });
  return withServedSkills(written, await turnServerSkills(harnessId, source));
}

/** A connection to no server: a turn whose servers serve no skills. */
const NO_SERVERS = {
  getSkillsSupport: () => ({
    declared: false,
    advertised: false,
    directoryRead: false,
    active: false,
  }),
} as never;

/**
 * A hosted harness turn's server skills, built as `runHarnessTurn` builds them
 * from its skill source, with no server connected; none on a runtime that
 * takes them no other way. `environment` is the set an environment turn
 * carries.
 */
function turnServerSkills(
  harnessId: string,
  source: Parameters<typeof harnessTurnSkills>[0],
  environment?: EffectiveCapabilitySet,
) {
  return harnessServerSkills(getHarnessAdapter(harnessId), {
    localUnattended: false,
    mode: selectHarnessSkillSource(source).mode,
    ...(source.pinnedHarnessSkills
      ? { pinnedHarnessSkills: source.pinnedHarnessSkills }
      : {}),
    ...(environment ? { effectiveCapabilities: environment } : {}),
    manager: NO_SERVERS,
    serverIds: [],
    messages: [],
  });
}

/** The refs a harness turn's prompt lists for its MCPJam skill tools. */
export async function harnessToolsServe(
  harnessId: string,
  source: Parameters<typeof harnessTurnSkills>[0],
  environment?: EffectiveCapabilitySet,
): Promise<string[]> {
  const served = await turnServerSkills(harnessId, source, environment);
  return [...(served?.promptSection ?? "").matchAll(/^- \*\*(.+?)\*\*/gm)].map(
    (match) => match[1]!,
  );
}

/**
 * A harness turn's box: what the writer reports and every skill folder the
 * runtime then finds in the folders it reads. The box first ran Claude Code
 * and Codex turns with a skill of their own, so a folder another runtime left
 * behind shows up here unless the writer cleared it.
 */
export async function boxReceives(
  harnessId: string,
  source: Parameters<typeof harnessTurnSkills>[0],
) {
  const box = fakeSkillBox();
  const leftBehind: PinnedSkillArtifact = {
    skillId: "sk_left_behind",
    name: "left-behind",
    description: "A skill an earlier turn delivered.",
    content: "# Left behind",
    contentHash: "hash-left-behind",
  };
  for (const runtime of ["claude-code", "codex"]) {
    await writeTurnToBox(runtime, { pinnedHarnessSkills: [leftBehind] }, box);
  }
  const written = await writeTurnToBox(harnessId, source, box);
  const { readFolders } = getHarnessAdapter(harnessId).skills;
  return {
    written,
    folders: readFolders.flatMap((folder) =>
      box.skillFolders(`${BOX_HOME}/${folder}`),
    ),
  };
}

/**
 * The eval fixture's environment as `resolveEnvironmentForRuntime` returns it,
 * before a run freezes it into {@link evalRunPins}, with the plugin origins
 * `fetchPluginRuntimeAttribution` reads for it.
 */
export function evalEnvironment(): {
  spec: ResolvedEnvironmentRuntime;
  attribution: PluginRuntimeAttribution;
} {
  const server = serverPin();
  const skills = [authoredPin(), pluginPin()].map((pin) => ({
    skillId: pin.skillId ?? pin.name,
    name: pin.name,
    description: pin.description,
    content: pin.content,
    aggregateHash: pin.aggregateHash ?? pin.contentHash,
    channels: pin.channels ?? [],
    provenance: pinnedSkillMeta(pin),
    files: (pin.files ?? []).map(({ path, size, url }) => ({
      path,
      size,
      url,
    })),
  }));
  const acme = EVAL_PLUGIN_VERSIONS[0]!;
  return {
    spec: {
      environmentRef: { environmentId: "env_eval", name: "Eval", revision: 1 },
      host: { hostId: "host_eval", runtimeConfig: {} },
      servers: {
        effectiveServerIds: ["srv_docs"],
        connectable: [
          { serverId: "srv_docs", name: "Docs", source: "host_or_group" },
        ],
      },
      skills,
      serverSkills: [
        {
          serverSkillId: "ss_docs_search",
          versionId: "ssv_docs_search_2",
          serverId: "srv_docs",
          serverSlug: "docs",
          serverLabel: "Docs",
          ref: "docs/search",
          skillUri: "skill://docs/search",
          name: server.name,
          description: server.description,
          content: server.content,
          contentSha256: server.contentHash,
          versionHash: server.contentHash,
          versionNumber: 2,
          capturedAt: 1_700_000_000_000,
          provenance: pinnedSkillMeta(server),
          files: [],
        },
      ],
      pluginVersions: EVAL_PLUGIN_VERSIONS,
    },
    attribution: {
      serverOrigins: new Map(),
      skillOrigins: new Map([
        [
          "sk_acme_summarize",
          {
            modelRef: "acme/summarize",
            plugin: { ...acme, bundleHash: acme.bundleHash ?? null },
          },
        ],
      ]),
      unattributedVersionIds: [],
    },
  };
}

/** A skill only its author sees, as a harness turn reads the caller's
 *  project pool (`listSkillsForRuntime`). */
export function personalRuntimeSkill(): RuntimeSkill {
  return {
    skillId: "sk_my_notes",
    name: "my-notes",
    description: "My own notes.",
    content: "# My notes",
    aggregateHash: "agg-my-notes",
  };
}

/** The same skill in the caller's live pool, as a turn's plan takes it. */
export function personalSkill(): RuntimeStandaloneSkill {
  const skill = personalRuntimeSkill();
  return { ...skill, ref: skill.name, files: [], channels: [] };
}

/**
 * A live environment turn's skill source, as a harness turn reads it: the
 * environment's skills, or in live-plus mode a client's `pool` beside them.
 */
export function liveTurnSource(
  spec: Pick<ResolvedEnvironmentRuntime, "skills">,
  pool?: RuntimeSkill[],
): Parameters<typeof harnessTurnSkills>[0] {
  return {
    runtimeSkillsOverride: runtimeSkills(spec),
    ...(pool
      ? {
          includeProjectSkills: true,
          project: {
            skills: async () => ({ ok: true as const, skills: pool }),
            files: async () => ({ ok: true as const, files: [] }),
          },
        }
      : {}),
  };
}
