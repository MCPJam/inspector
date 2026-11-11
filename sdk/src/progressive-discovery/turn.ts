/**
 * One prompt's progressive tool discovery, for a runner that drives the AI SDK
 * loop itself (`HostRunner`). It wires the same functions the hosted turns use
 * (chat-v2 orchestration, the direct and Convex engines), minus their
 * Inspector-only extras: the plan, the two meta-tools, the per-step tool
 * narrowing with the forced first search, and the execution gate.
 */

import type { ModelMessage, ToolSet } from "ai";
import {
  META_TOOL_NAMES,
  META_TOOL_SEARCH,
  buildToolCatalog,
  commitNewlyLoaded,
  createDiscoveryState,
  decideProgressivePlan,
  gateToolsToActiveSubset,
  hydrateDiscoveryStateFromHistory,
  resolveActiveToolNames,
  shouldForceInitialToolSearch,
  type ProgressiveDiscoveryEnabled,
  type ProgressiveToolPlan,
} from "./discovery.js";
import { createProgressiveMetaTools } from "./meta-tools.js";

/** What one step of the AI SDK loop may see, for `prepareStep`. */
export interface ProgressiveStepSettings {
  activeTools: string[];
  toolChoice?: { type: "tool"; toolName: string };
}

export interface ProgressiveTurn {
  plan: ProgressiveToolPlan;
  /** The meta-tools alone, for recording what the model was offered. */
  metaTools: ToolSet;
  /** The executable tools, gated to the loaded subset, plus the meta-tools. */
  tools: ToolSet;
  prepareStep(stepNumber: number): ProgressiveStepSettings;
}

/**
 * Returns `undefined` when discovery does not apply: the mode is off, or it is
 * `"auto"` and the tools stay under every threshold. Throws when a real tool
 * already uses a meta-tool's name, as the hosted turns do.
 */
export function startProgressiveTurn(args: {
  /** The prompt's tools as prepared; the catalog is built from these. */
  tools: ToolSet;
  /** What the loop executes: the same keys, possibly wrapped. */
  executableTools: ToolSet;
  mode: ProgressiveDiscoveryEnabled;
  /** Earlier turns, so a tool they loaded stays loaded. */
  priorMessages?: ReadonlyArray<ModelMessage>;
}): ProgressiveTurn | undefined {
  if (args.mode === false) return undefined;
  const catalog = buildToolCatalog(args.tools);
  // No model context length here, so `"auto"` uses the tool-count and token
  // thresholds only; the hosted turns also apply the share-of-context one.
  const plan = decideProgressivePlan({
    catalog,
    options: { enabled: args.mode },
  });
  if (!plan.enabled) return undefined;

  for (const name of META_TOOL_NAMES) {
    if (Object.prototype.hasOwnProperty.call(args.tools, name)) {
      throw new Error(
        `MCP tool '${name}' collides with the progressive-discovery meta-tool of the same name. Rename the MCP tool or set the host's progressiveToolDiscovery to false.`
      );
    }
  }

  const state = createDiscoveryState();
  if (args.priorMessages?.length) {
    hydrateDiscoveryStateFromHistory(state, args.priorMessages, catalog);
  }
  const metaTools = createProgressiveMetaTools({
    getCatalog: () => catalog,
    state,
    policy: plan.policy,
  });
  return {
    plan,
    metaTools,
    tools: {
      ...gateToolsToActiveSubset(args.executableTools, plan, () => state),
      ...metaTools,
    },
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
  };
}
