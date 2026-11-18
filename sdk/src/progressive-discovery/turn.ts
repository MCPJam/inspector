/**
 * One prompt's progressive tool discovery, for a runner that drives the AI SDK
 * loop itself (`HostRunner`). It wires the same functions the hosted turns use
 * (chat-v2 orchestration, the direct and Convex engines), minus their
 * Inspector-only extras: the plan, the two meta-tools, and the per-step tool
 * narrowing with the forced first search.
 *
 * The narrowing is also the gate: the AI SDK refuses a call to a tool outside
 * the step's `activeTools` (a `NoSuchToolError`) and never runs it. `noteStep`
 * collects those calls so the runner can leave them out of the prompt's tool
 * calls, the way it leaves out calls a tool policy refused.
 */

import { NoSuchToolError, type ModelMessage, type ToolSet } from "ai";
import {
  META_TOOL_NAMES,
  META_TOOL_SEARCH,
  buildToolCatalog,
  commitNewlyLoaded,
  createDiscoveryState,
  decideProgressivePlan,
  hydrateDiscoveryStateFromHistory,
  resolveActiveToolNames,
  shouldForceInitialToolSearch,
  type ProgressiveDiscoveryEnabled,
} from "./discovery.js";
import { createProgressiveMetaTools } from "./meta-tools.js";

/** What one step of the AI SDK loop may see, for `prepareStep`. */
export interface ProgressiveStepSettings {
  activeTools: string[];
  toolChoice?: { type: "tool"; toolName: string };
}

/** The fields of a finished step's tool call that `noteStep` reads. */
type StepToolCall = { toolCallId: string; invalid?: boolean; error?: unknown };

/** A meta-tool call as it starts. */
type StartedCall = {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
};

export interface ProgressiveTurn {
  /** `search_mcp_tools` and `load_mcp_tools`, to add to the prompt's tools. */
  metaTools: ToolSet;
  prepareStep(stepNumber: number): ProgressiveStepSettings;
  /** Records a finished step's calls to tools that were not loaded. */
  noteStep(toolCalls: ReadonlyArray<StepToolCall>): void;
  /** Calls the AI SDK refused because their tool was not loaded; none ran. */
  refusedCallIds: ReadonlySet<string>;
}

/**
 * A host's Progressive tools setting. A host that leaves it unset gets
 * `whenUnset`: Auto for saved clients and templates, as hosted runs read
 * them. Without a host there is no setting, and every tool is sent.
 */
export function readDiscoveryMode(
  host: { progressiveToolDiscovery?: boolean } | undefined,
  whenUnset: "auto" | undefined
): ProgressiveDiscoveryEnabled {
  if (!host) return false;
  return host.progressiveToolDiscovery ?? whenUnset ?? false;
}

/**
 * Returns `undefined` when discovery does not apply: the mode is off, or it is
 * `"auto"` and the tools stay under every threshold. Throws when a real tool
 * already uses a meta-tool's name, as the hosted turns do.
 */
export function startProgressiveTurn(args: {
  tools: ToolSet;
  mode: ProgressiveDiscoveryEnabled;
  /** Earlier turns, so a tool they loaded stays loaded. */
  priorMessages?: ReadonlyArray<ModelMessage>;
  /**
   * Gets each search or load call as it starts. A step that fails never
   * finishes, so this keeps its meta-tool calls in the partial result, as the
   * runner keeps the MCP calls it started.
   */
  onCallStarted?: (call: StartedCall) => void;
}): ProgressiveTurn | undefined {
  if (args.mode === false) return undefined;
  const catalog = buildToolCatalog(args.tools);
  // No model context length here, so `"auto"` uses the tool-count and token
  // thresholds only; hosted turns that know the model's size also apply the
  // share-of-context one.
  const plan = decideProgressivePlan({
    catalog,
    options: { enabled: args.mode },
  });
  if (!plan.enabled) return undefined;

  for (const name of META_TOOL_NAMES) {
    if (Object.hasOwn(args.tools, name)) {
      throw new Error(
        `MCP tool '${name}' collides with the progressive-discovery meta-tool of the same name. Rename the MCP tool or set the host's progressiveToolDiscovery to false.`
      );
    }
  }

  const state = createDiscoveryState();
  if (args.priorMessages?.length) {
    hydrateDiscoveryStateFromHistory(state, args.priorMessages, catalog);
  }
  const refusedCallIds = new Set<string>();
  const metaTools = createProgressiveMetaTools({
    getCatalog: () => catalog,
    state,
    policy: plan.policy,
  });
  const notify = args.onCallStarted;
  for (const [name, tool] of Object.entries(metaTools)) {
    const execute = tool.execute;
    if (!notify || !execute) continue;
    metaTools[name] = {
      ...tool,
      execute: (input, options) => {
        notify({
          toolCallId: options.toolCallId,
          toolName: name,
          arguments: input as Record<string, unknown>,
        });
        return execute(input, options);
      },
    };
  }
  return {
    metaTools,
    prepareStep(stepNumber) {
      // Promote what `load_mcp_tools` loaded on the previous step.
      commitNewlyLoaded(state);
      const activeTools = resolveActiveToolNames(plan, state);
      return shouldForceInitialToolSearch(plan, state, stepNumber)
        ? {
            activeTools,
            toolChoice: { type: "tool", toolName: META_TOOL_SEARCH },
          }
        : { activeTools };
    },
    noteStep(toolCalls) {
      for (const call of toolCalls) {
        if (call.invalid && NoSuchToolError.isInstance(call.error)) {
          refusedCallIds.add(call.toolCallId);
        }
      }
    },
    refusedCallIds,
  };
}
