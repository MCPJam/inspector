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
import {
  boxSkillsFolder,
  planBoxSkills,
  writeBoxSkills,
} from "../../utils/harness/box-skills-writer.js";
import { materializePinnedSkillFiles } from "../../utils/harness/pinned-harness-skills.js";
import { getHarnessAdapter } from "../../utils/harness/registry.js";
import { harnessTurnSkills } from "../../utils/harness/skill-delivery.js";
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

/**
 * What MCPJam's agent is handed for a plan, read off the turn `prepareChatV2`
 * builds: the skill refs its prompt lists and the skill tools it gets. With
 * `harness`, MCPJam's side of a harness turn.
 */
export async function agentReceives(
  skills: TurnSkills,
  {
    modelContextTokens,
    harness,
  }: { modelContextTokens?: number; harness?: string } = {},
): Promise<{ listed: string[]; tools: string[] }> {
  const prepared = await prepareChatV2({
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
 * One harness turn's box write, as `runHarnessTurn` makes it: the turn's
 * skills read from their source, planned by the runtime's rules (none on a
 * runtime that takes none), written to `box` by the box writer, then a run's
 * own files by the pinned file writer.
 */
export async function writeTurnToBox(
  harnessId: string,
  source: Parameters<typeof harnessTurnSkills>[0],
  box: FakeSkillBox,
) {
  const adapter = getHarnessAdapter(harnessId);
  const turn = await harnessTurnSkills(source);
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
  if (turn.mode === "pinned" && plan.deliver.length > 0) {
    await materializePinnedSkillFiles({
      session: box.session,
      artifacts: source.pinnedHarnessSkills ?? [],
      skillsBase: boxSkillsFolder(adapter.skills, BOX_HOME),
    });
  }
  return written;
}

/**
 * The skill folders a harness finds on its box after a run's turn: every
 * folder in any skills folder the runtime reads. The box first ran Claude Code
 * and Codex turns with a skill of their own, so a folder another runtime left
 * behind shows up here unless the writer cleared it.
 */
export async function boxReceives(
  harnessId: string,
  pinnedHarnessSkills: PinnedSkillArtifact[],
): Promise<string[]> {
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
  await writeTurnToBox(harnessId, { pinnedHarnessSkills }, box);
  const { readFolders } = getHarnessAdapter(harnessId).skills;
  return readFolders.flatMap((folder) =>
    box.skillFolders(`${BOX_HOME}/${folder}`),
  );
}
