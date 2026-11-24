/**
 * The start form's rules, apart from the screen: what a draft needs before it
 * can start, the request it becomes, and the prompt for a person's own agent.
 */
import type { StartClimbParams } from "@/lib/apis/climbs-api";
import { parseWhole, plural } from "./climb-format";
import type { ClimbPicker } from "./climb-types";

export const DEFAULT_ROUND_LIMIT = "10";
export const DEFAULT_CREDIT_LIMIT = "4,000";
const MAX_ROUNDS = 100;

export type StartDraft = {
  serverId: string;
  environmentIds: string[];
  picker: ClimbPicker;
  modelId: string;
  roundLimit: string;
  creditLimit: string;
};

export type StartIssues = Partial<
  Record<"serverId" | "environmentIds" | "modelId" | "roundLimit" | "creditLimit", string>
>;

export function startIssues(draft: StartDraft, hasEnvironments: boolean): StartIssues {
  const issues: StartIssues = {};
  if (!draft.serverId) issues.serverId = "Choose the server to climb.";
  if (hasEnvironments && draft.environmentIds.length === 0) {
    issues.environmentIds = "Choose at least one place for the cases to run.";
  }
  if (draft.picker === "mcpjam" && !draft.modelId) {
    issues.modelId = "Choose the model MCPJam picks with.";
  }
  const rounds = parseWhole(draft.roundLimit);
  if (rounds === null || rounds < 1 || rounds > MAX_ROUNDS) {
    issues.roundLimit = `Enter a number of rounds from 1 to ${MAX_ROUNDS}.`;
  }
  const credits = parseWhole(draft.creditLimit);
  if (credits === null || credits < 1) {
    issues.creditLimit = "Enter a credit limit of 1 or more.";
  }
  return issues;
}

export function hasIssues(issues: StartIssues): boolean {
  return Object.keys(issues).length > 0;
}

/** A valid draft as the request. The caller checked `startIssues` first. */
export function startRequest(
  draft: StartDraft,
  context: { projectId: string; suiteId: string; allEnvironmentIds: string[] },
): StartClimbParams {
  const everyEnvironment =
    draft.environmentIds.length === context.allEnvironmentIds.length;
  return {
    projectId: context.projectId,
    suiteId: context.suiteId,
    serverId: draft.serverId,
    roundLimit: parseWhole(draft.roundLimit) ?? 0,
    creditLimit: parseWhole(draft.creditLimit) ?? 0,
    // Leaving the list out means the suite's own environments.
    ...(context.allEnvironmentIds.length > 0 && !everyEnvironment
      ? { environmentIds: draft.environmentIds }
      : {}),
    picker: draft.picker,
    ...(draft.picker === "mcpjam" ? { pickerModel: draft.modelId } : {}),
  };
}

/** What a person pastes into their coding agent to run the climb with MCPJam's tools and the skill. */
/** The servers a suite names: by saved-server id where it has one, else by name. */
export type SuiteServers = {
  servers?: readonly string[];
  serverBindings?: ReadonlyArray<{ serverName: string; projectServerId?: string }>;
};

/**
 * The server a new climb starts on: the first of the suite's own servers that
 * the project has saved. Without this the form took the project's first
 * server, which a suite on another server cannot climb. Falls back to that
 * first server only when the suite names none the project has.
 */
export function defaultClimbServerId(
  suite: SuiteServers,
  servers: ReadonlyArray<{ id: string; name: string }>,
): string {
  for (const binding of suite.serverBindings ?? []) {
    const id = binding.projectServerId;
    if (id && servers.some((server) => server.id === id)) return id;
  }
  for (const name of suite.servers ?? []) {
    const match = servers.find((server) => server.name === name);
    if (match) return match.id;
  }
  return servers[0]?.id ?? "";
}

export function agentPrompt(input: {
  serverName: string;
  suiteName: string;
  environmentLabels: string[];
  roundLimit: string;
  creditLimit: string;
}): string {
  const environments = input.environmentLabels.length
    ? ` Environments: ${input.environmentLabels.join(", ")}.`
    : "";
  const rounds = parseWhole(input.roundLimit);
  const credits = parseWhole(input.creditLimit);
  const limits =
    rounds !== null && credits !== null
      ? ` Stop after ${plural(rounds, "round")} or ${credits.toLocaleString("en-US")} credits.`
      : "";
  return `Use MCPJam to climb ${input.serverName} on the suite "${input.suiteName}". Load the MCPJam skill "climb-an-mcp-server" and follow it.${environments}${limits}`;
}
