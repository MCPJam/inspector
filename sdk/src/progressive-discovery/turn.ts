import { planDiscoveryStep, type DiscoveryStep } from "./step.js";
/** Progressive discovery for SDK runs. Each step registers eligible calls and advertises its loaded tools. */
import { type ModelMessage, type ToolSet } from "ai";
import {
  META_TOOL_NAMES,
  buildToolCatalog,
  commitNewlyLoaded,
  createDiscoveryState,
  decideProgressivePlan,
  hydrateDiscoveryStateFromHistory,
  type ProgressiveDiscoveryEnabled,
} from "./discovery.js";
import { createProgressiveMetaTools } from "./meta-tools.js";

/** What one step of the AI SDK loop may see, for `prepareStep`. */
export interface ProgressiveStepSettings {
  activeTools: string[];
  toolChoice?: { type: "tool"; toolName: string };
}

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
  currentStep(): DiscoveryStep | undefined;
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
  runUnloadedToolCalls?: boolean;
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
    options: { enabled: args.mode, runUnloadedToolCalls: args.runUnloadedToolCalls },
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
  const metaTools = createProgressiveMetaTools({
    getCatalog: () => catalog,
    state,
    policy: plan.policy,
  });
  const notify = args.onCallStarted;
  const names = [...Object.keys(args.tools), ...Object.keys(metaTools)];
  let step = planDiscoveryStep(names, plan, state);
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
    prepareStep() {
      commitNewlyLoaded(state);
      step = planDiscoveryStep(names, plan, state);
      return { activeTools: [...step.callable, ...step.loadRequired] };
    },
    currentStep: () => step,
  };
}
