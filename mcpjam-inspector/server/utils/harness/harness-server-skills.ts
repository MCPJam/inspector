/**
 * A harness turn's MCP-server skills (SEP-2640), served by MCPJam's own skill
 * tools over the harness tools channel.
 *
 * A runtime whose skills descriptor says `harness-tools` never finds a
 * server's skill in its skills folder. `loadSkill`, `listSkillFiles` and
 * `readSkillFile` serve them instead, built by the code MCPJam's agent uses
 * (`effective-skill-tools.ts`), so the server is named on every skill and
 * every load is checked the same way: a run's captured skills, an
 * environment's, and on a live turn the connected servers' own.
 *
 * The runtime keeps its own context, and `HarnessAgent` hands a host tool no
 * conversation. So the turn keeps a transcript here: the conversation as
 * MCPJam received it, where an earlier load or a `/`-picked skill sits, plus
 * each call to these tools and its result, recorded before the result goes
 * back to the runtime. The tools read it for the entry a file read is held
 * to, and the command gate (`server-skill-command-gate.ts`) reads it for
 * whether a server's skill is in use.
 */
import type { ModelMessage } from "ai";
import type { MCPClientManager } from "@mcpjam/sdk";
import { mentionsServerSkill } from "../../../shared/server-skill-banner.js";
import {
  buildLiveEffectiveCapabilities,
  withLiveServerSkills,
  type EffectiveCapabilitySet,
  type RuntimeServerSkill,
} from "../../services/environments/effective-capabilities.js";
import { getEffectiveSkillToolsAndPrompt } from "../computers/effective-skill-tools.js";
import { liveServerSkillRefs } from "../../services/environments/turn-skills.js";
import { listLiveServerSkills } from "../computers/live-server-skills.js";
import type { BoxSkillOutcome, BoxSkillsResult } from "./box-skills-writer.js";
import { takesServerSkillsAsTools } from "./skills-descriptor.js";
import {
  withHostCommandGate,
  type TurnCommandGate,
} from "./server-skill-command-gate.js";

/** The conversation as MCPJam sees it during a harness turn. */
export interface ServerSkillTranscript {
  messages(): ModelMessage[];
  /** A server's skill is in context: loaded, or picked with `/`. */
  inUse(): boolean;
}

export interface HarnessServerSkills {
  /** Host tools for the runtime; none when the turn has no server skill. */
  tools: Record<string, unknown>;
  /** Appended to the runtime's instructions; empty with no tools. */
  promptSection: string;
  /** The captured skills the tools serve, for the turn's delivery report. */
  served: BoxSkillOutcome[];
  /** Counts for the connected servers' own skills on a live turn, which
   *  the turn's plan cannot name. */
  liveDelivery?: NonNullable<BoxSkillsResult["liveDelivery"]>;
  transcript: ServerSkillTranscript;
  /** The runtime's commands go to MCPJam's gate: the turn offers server
   *  skills, or its conversation already holds one. */
  gated: boolean;
}

/**
 * The server skills a harness turn serves, from the source its skills come
 * from (`selectHarnessSkillSource`): a run's captured copies, an
 * environment's captured skills, and on a live turn the connected servers'.
 * Undefined for a turn that serves none (`takesServerSkillsAsTools`).
 */
export async function harnessServerSkills(
  adapter: Parameters<typeof takesServerSkillsAsTools>[0],
  args: {
    /** A live turn (`HarnessTurnSkills.live`): its servers are connected, so
     *  their own skills are listed beside the captured ones. */
    live: boolean;
    /**
     * The captured server skills the turn's plan holds (`TurnSkills.set`): a
     * run's frozen copies, or an environment's captured skills. The plan built
     * them once, with their digests and file bytes.
     */
    capturedServerSkills: readonly RuntimeServerSkill[];
    manager: MCPClientManager;
    /** The turn's selected servers, listed on a live turn. */
    serverIds: readonly string[];
    /** The conversation the turn received. */
    messages: readonly ModelMessage[];
    signal?: AbortSignal;
  },
): Promise<HarnessServerSkills | undefined> {
  if (!takesServerSkillsAsTools(adapter)) return undefined;
  const captured = args.capturedServerSkills;
  // Labelled by server id, as MCPJam's agent is when it has no labels: the id
  // is host-assigned, so a server can't choose the namespace its refs take.
  const live = args.live
    ? await listLiveServerSkills(
        args.manager,
        args.serverIds.map((serverId) => ({
          serverId,
          serverLabel: serverId,
        })),
      )
    : undefined;
  const set: EffectiveCapabilitySet = {
    ...buildLiveEffectiveCapabilities({}),
    serverSkills: [...captured],
  };
  const transcript = turnTranscript(args.messages);
  const effective = live ? withLiveServerSkills(set, live) : set;
  const { tools, systemPromptSection } = getEffectiveSkillToolsAndPrompt(
    effective,
    args.signal ? { signal: args.signal } : {},
  );
  const offered = Object.keys(tools).length > 0;
  const liveRefs = liveServerSkillRefs(effective);
  return {
    tools: offered ? servedThroughTranscript(tools, transcript) : {},
    promptSection:
      offered && systemPromptSection
        ? `${systemPromptSection}\n\n${HARNESS_SERVER_SKILLS_SENTENCE}`
        : "",
    served: offered
      ? captured.map(({ skillId, name }) => ({ skillId, name }))
      : [],
    ...(live && offered
      ? {
          liveDelivery: {
            delivered: liveRefs.length,
            collisions:
              live.skills.length - (effective.liveServerSkills?.skills.length ?? 0),
            omittedFromCatalog: liveRefs.filter((ref) => ref.omittedFromCatalog)
              .length,
          },
        }
      : {}),
    transcript,
    gated: offered || transcript.inUse(),
  };
}

/** A turn's box report, with the captured server skills its tools served. */
export function withServedSkills(
  written: BoxSkillsResult,
  serverSkills: HarnessServerSkills | undefined,
): BoxSkillsResult {
  if (!serverSkills?.served.length && !serverSkills?.liveDelivery) return written;
  return {
    ...written,
    ...(serverSkills.served.length ? { servedByTools: serverSkills.served } : {}),
    ...(serverSkills.liveDelivery ? { liveDelivery: serverSkills.liveDelivery } : {}),
  };
}

/**
 * Where these skills are, for a runtime that also lists skills of its own:
 * they are not in its skills folder, and its own skill tool can't load them.
 */
const HARNESS_SERVER_SKILLS_SENTENCE =
  "These skills come from MCP servers. They are not in your skills folder: " +
  "load them with MCPJam's `loadSkill` tool, never with your own skill tool.";

/**
 * Merge the turn's server-skill tools into its host tools, with MCPJam's
 * command tools behind the turn's gate when it has one. A name another host
 * tool already holds is a bug, not a choice, so the turn refuses to start
 * rather than hand the runtime one of the two.
 */
export function withServerSkillTools<T extends Record<string, unknown>>(
  hostTools: T,
  serverSkills: HarnessServerSkills | undefined,
  gate?: TurnCommandGate,
): T {
  const tools = serverSkills?.tools ?? {};
  for (const name of Object.keys(tools)) {
    if (Object.prototype.hasOwnProperty.call(hostTools, name)) {
      throw new Error(
        `Host tool '${name}' collides with MCPJam's skill tool of the same name.`,
      );
    }
  }
  const merged = { ...hostTools, ...tools };
  return gate ? withHostCommandGate(merged, gate) : merged;
}

function turnTranscript(
  received: readonly ModelMessage[],
): ServerSkillTranscript & {
  record(
    toolName: string,
    toolCallId: string,
    input: unknown,
    output: unknown,
  ): void;
} {
  const recorded: ModelMessage[] = [];
  const receivedInUse = mentionsServerSkill(received);
  let recordedInUse = false;
  return {
    messages: () => [...received, ...recorded],
    inUse: () => receivedInUse || recordedInUse,
    record(toolName, toolCallId, input, output) {
      const result: ModelMessage = {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName,
            // The skill tools answer in text, refusals included.
            output: {
              type: "text",
              value:
                typeof output === "string"
                  ? output
                  : (JSON.stringify(output) ?? ""),
            },
          },
        ],
      };
      recorded.push(
        {
          role: "assistant",
          content: [{ type: "tool-call", toolCallId, toolName, input }],
        },
        result,
      );
      recordedInUse ||= mentionsServerSkill([result]);
    },
  };
}

/**
 * The skill tools as the runtime gets them: they never ask, since loading or
 * reading a skill needs no approval, and each runs against the transcript and
 * is recorded in it before its result goes back.
 */
function servedThroughTranscript(
  tools: Record<string, unknown>,
  transcript: ReturnType<typeof turnTranscript>,
): Record<string, unknown> {
  let calls = 0;
  return Object.fromEntries(
    Object.entries(tools).flatMap(([name, tool]) => {
      if (!tool || typeof tool !== "object") return [];
      const execute = (tool as { execute?: unknown }).execute;
      if (typeof execute !== "function") return [];
      const served: Record<string, unknown> = {
        ...tool,
        execute: async (input: unknown, options: unknown) => {
          const toolCallId = (options as { toolCallId?: unknown } | undefined)
            ?.toolCallId;
          const output: unknown = await execute(input, {
            ...(options as object | undefined),
            messages: transcript.messages(),
          });
          transcript.record(
            name,
            typeof toolCallId === "string"
              ? toolCallId
              : `skill-call-${++calls}`,
            input,
            output,
          );
          return output;
        },
      };
      delete served.needsApproval;
      return [[name, served]];
    }),
  );
}
