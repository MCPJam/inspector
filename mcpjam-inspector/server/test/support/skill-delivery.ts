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
import { buildPinnedSkillSource } from "../../services/evals/pinned-skill-source.js";
import type {
  RunPinnedPluginVersion,
  RunPinnedSkill,
} from "../../services/evals/run-plugin-snapshot.js";
import type { TurnSkills } from "../../services/environments/turn-skills.js";
import { prepareChatV2 } from "../../utils/chat-v2-orchestration.js";
import { getHarnessAdapter } from "../../utils/harness/registry.js";
import { selectHarnessSkillSource } from "../../utils/harness/skill-delivery.js";

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
 * The skill folders a harness writes to its box from a run's frozen copies:
 * the names in its adapter's `skills` param, from the list the harness turn
 * builds in its pinned mode.
 */
export function boxReceives(
  harnessId: string,
  pinnedHarnessSkills: PinnedSkillArtifact[],
): string[] {
  const adapter = getHarnessAdapter(harnessId);
  if (!adapter.supportsSkills) return [];
  const source = selectHarnessSkillSource({ pinnedHarnessSkills });
  if (source.mode !== "pinned") throw new Error(`Got the ${source.mode} mode.`);
  return adapter
    .prepareSkills(source.skills)
    .payload.map((skill) => skill.name);
}
