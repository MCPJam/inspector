/**
 * What MCPJam's picker can do in a step: the real server's read-only tools
 * (added by the step) and a fixed list of climb and mock operations, built by
 * `buildMcpjamTool` like the in-app chat's. Nothing here asks a person. In
 * their place a rule decides each call: reads pass, a trace read is fenced to
 * steering cases, and a write passes only while the climb has a round and
 * credits left and has not stopped. The backend checks the same limits again,
 * so the rule only spares the model a refusal it could not act on.
 */
import type { ToolSet } from "ai";
import type { ConvexHttpClient } from "convex/browser";
import {
  getClimbOperation,
  getClimbRoundOperation,
  submitClimbRoundOperation,
  type PlatformApiClient,
  type PlatformClimb,
} from "@mcpjam/sdk/platform";
import { buildMcpjamTool } from "../../utils/built-in-tools/mcpjam.js";
import { climbFns } from "./backend.js";
import { createTraceFence } from "./trace-fence.js";

/** Climb operations the in-app chat does not offer, built here for this one climb. */
const CLIMB_OPERATIONS = [getClimbOperation, getClimbRoundOperation, submitClimbRoundOperation];

/** In the order the model reads them. */
export const PICKER_TOOL_IDS = [
  "get_climb",
  "get_climb_round",
  "get_eval_iteration_trace",
  "get_mock_server",
  "create_mock_server",
  "update_mock_server",
  "submit_climb_round",
] as const;

const WRITES = new Set<string>(["create_mock_server", "update_mock_server", "submit_climb_round"]);

type PickerRuleDeps = {
  convex: Pick<ConvexHttpClient, "query">;
  client: Pick<PlatformApiClient, "listEvalRunIterations">;
  projectId: string;
  climbId: string;
};

/** Answers undefined to let a call run, else the sentence the model reads as the result. */
export function createPickerRule(deps: PickerRuleDeps): (id: string, input: Record<string, unknown>) => Promise<string | undefined> {
  const fence = createTraceFence(deps);
  return async (id, input) => {
    if (id === "get_eval_iteration_trace") return fence(input);
    if (typeof input.climb === "string" && input.climb !== deps.climbId) {
      return "This step works on one climb. Use the climb you were given.";
    }
    if (!WRITES.has(id)) return undefined;
    const climb: PlatformClimb = await deps.convex.query(climbFns.get, { climbId: deps.climbId });
    if (climb.state === "stopped") return "This climb has stopped. End your turn.";
    if (climb.limits.roundsLeft <= 0) return `This climb has used its ${climb.limits.roundLimit} rounds. Nothing more can be measured: end your turn.`;
    if (climb.limits.creditsLeft <= 0) return `This climb has used its ${climb.limits.creditLimit} credits. Nothing more can be measured: end your turn.`;
    return undefined;
  };
}

export function buildPickerTools(args: PickerRuleDeps & { client: PlatformApiClient }): ToolSet {
  const allow = createPickerRule(args);
  const tools: ToolSet = {};
  for (const id of PICKER_TOOL_IDS) {
    const built = buildMcpjamTool(id, {
      client: args.client,
      projectId: args.projectId,
      unattended: { operations: CLIMB_OPERATIONS, allow },
    });
    if (built) tools[id] = built;
  }
  return tools;
}
