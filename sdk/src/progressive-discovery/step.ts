import { originalMcpInputSchema } from "../original-mcp-input-schema.js";
import { asSchema, jsonSchema, NoSuchToolError, type ToolSet } from "ai";
import { checkToolArgs } from "../conformance-tool-args.js";
import {
  resolveActiveToolNames,
  type ProgressiveToolPlan,
  type ToolDiscoveryState,
} from "./discovery.js";

/** The callers resolve client and runtime exclusions before passing eligible names. */
export function planDiscoveryStep(
  eligible: readonly string[],
  plan?: ProgressiveToolPlan,
  state?: ToolDiscoveryState
) {
  const deferred = new Set<string>();
  if (plan?.enabled && state) {
    const active = new Set(resolveActiveToolNames(plan, state));
    for (const entry of plan.catalog) {
      if (!active.has(entry.modelName)) deferred.add(entry.modelName);
    }
  }
  const shown = eligible.filter((name) => !deferred.has(name));
  const hidden =
    plan?.runUnloadedToolCalls === false
      ? []
      : eligible.filter((name) => deferred.has(name));
  const loadRequired =
    plan?.runUnloadedToolCalls === false
      ? eligible.filter((name) => deferred.has(name))
      : [];
  return { shown, hidden, loadRequired, callable: [...shown, ...hidden] };
}

export type DiscoveryStep = ReturnType<typeof planDiscoveryStep>;

/** The input schema exactly as received from MCP, before provider normalization. */

type DiscoveryTool = ToolSet[string] & { [originalMcpInputSchema]?: unknown };

export async function earlyToolInputError(
  tool: DiscoveryTool,
  input: unknown
): Promise<string | undefined> {
  const schema =
    originalMcpInputSchema in tool
      ? tool[originalMcpInputSchema]
      : await asSchema(tool.inputSchema).jsonSchema;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return `Tool arguments must be a JSON object. Input schema: ${JSON.stringify(schema)}`;
  }
  const verdict = checkToolArgs(schema, input);
  if (verdict.verdict === "valid") return undefined;
  if (verdict.verdict === "unknown")
    return "The client could not validate this tool’s input schema. Load the tool and retry.";
  return `Invalid tool input: ${verdict.message}. Input schema: ${JSON.stringify(schema)}`;
}

/** The AI SDK validates before authorization and execution. Preserve a loaded tool's own parser. */
export function validateDeferredToolInputs(
  tools: ToolSet,
  getStep: () => DiscoveryStep | undefined
): ToolSet {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const declared = asSchema(tool.inputSchema);
      return [
        name,
        {
          ...tool,
          inputSchema: jsonSchema(() => declared.jsonSchema, {
            validate: async (value) => {
              const step = getStep();
              if (step && !step.callable.includes(name)) {
                return {
                  success: false,
                  error: new Error(
                    step.loadRequired.includes(name)
                      ? "Load the tool with load_mcp_tools before calling it."
                      : "The tool is unavailable in this step."
                  ),
                };
              }
              if (step?.hidden.includes(name)) {
                const reason = await earlyToolInputError(tool, value);
                if (reason) return { success: false, error: new Error(reason) };
              }
              return declared.validate
                ? declared.validate(value)
                : { success: true, value };
            },
          }),
        },
      ];
    })
  );
}

/** Keep parser-only tool names out of the error that is replayed to the model. */
export async function redactUnavailableToolError({ error }: { error: unknown }) {
  if (NoSuchToolError.isInstance(error)) {
    error.message = "The tool is unavailable in this step.";
  }
  return null;
}
