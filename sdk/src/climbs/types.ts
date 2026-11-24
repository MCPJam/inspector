/**
 * What the climb functions take and give. They are pure: the route reads the
 * climb, the real server and the baseline's failed runs, and these turn that
 * into what a person or an agent reads. The keep rule, the noise and the stop
 * rule are the backend's: nothing here recomputes them, and validation and
 * confirmation cases appear only as totals (amendment A8).
 */
import type { MockChange } from "../mocks/change-list.js";
import type { PlatformClimbMeasure, PlatformClimbVerdict } from "../platform/climb-types.js";

/** The clients a climb's environments run: MCPJam's own loop, or a harness client by its id. */
export type ClimbClient = "mcpjam" | "claude-code" | "codex" | "cursor" | "copilot-cli" | "opencode";

/** One iteration of a steering case in the baseline. Never one of a validation or confirmation case. */
export type ClimbEvidence = {
  runId: string;
  iterationId: string;
  environmentId: string;
  caseKey: string;
  caseTitle?: string;
  /** The tool the case is about, when it names one. */
  tool?: string;
  outcome: "passed" | "failed" | "lost";
  tokens?: number;
  costUsd?: number;
  toolCalls?: number;
  /** The first failed stage and the reason the verified derivation gave for it. */
  failedStage?: { stage: string; reason?: string };
  failureCategory?: string;
  /** The case expects a tool the real server does not list. */
  expectedToolNotListed?: boolean;
  /** The iteration's page, in the `eval_iteration` form of the platform's permalinks. */
  link: string;
};

/** A failed run and why, with the page it opens. */
export type FailedRun = {
  caseKey: string;
  caseTitle?: string;
  environmentId: string;
  runId: string;
  iterationId: string;
  stage?: string;
  reason: string;
  link: string;
};

export type SuiteCheckFinding = {
  code:
    | "measure_not_recorded"
    | "no_room_to_improve"
    | "flipped_cases"
    | "no_validation_for_tools"
    | "no_validation_cases"
    | "iterations_lost"
    | "smallest_change";
  /** `blocks`: a climb for this measure cannot learn anything. `warns`: it can, with care. */
  severity: "blocks" | "warns" | "info";
  message: string;
  environmentId?: string;
};

export type SuiteCheckEnvironment = {
  environmentId: string;
  /** Noise between the two baseline runs, in basis points, on steering cases. */
  noiseBps: { pass_rate: number; tokens?: number; cost?: number; tool_calls?: number };
  /** The smallest change the suite can show here, in basis points. */
  smallestChangeBps: { pass_rate: number; tokens?: number; cost?: number; tool_calls?: number };
  recorded: { tokens: boolean; cost: boolean; tool_calls: boolean };
  noRoomToImprove: boolean;
  flippedSteeringCaseKeys: string[];
  /** A count: validation cases are never named. */
  flippedValidationCount: number;
  lostIterations: number;
  countedIterations: number;
};

export type SuiteCheck = {
  /** False until the baseline has settled. */
  ready: boolean;
  measure: PlatformClimbMeasure;
  /** True when no finding blocks a climb for the climb's measure. */
  canShowChange: boolean;
  environments: SuiteCheckEnvironment[];
  steeringToolsWithoutValidation: string[];
  findings: SuiteCheckFinding[];
};

export type ClimbForId =
  | "tool_descriptions"
  | "tool_inputs"
  | "pass_rate"
  | "tokens"
  | "cost"
  | "tool_calls"
  | "tool_results"
  | "instructions"
  | "skills"
  | "apps"
  | "prompts_and_resources"
  | "fewer_tools"
  | "missing_capability";

export type ClimbForOption = {
  id: ClimbForId;
  label: string;
  /** What the climb measures if this is chosen. Every option about a part of the server measures pass rate. */
  measure: PlatformClimbMeasure;
  /** False when the climb cannot be for this: `reason` says why. */
  available: boolean;
  reason?: string;
  /** The number behind the option, counted on steering cases. */
  number: { value: number | null; unit: "failed_iterations" | "tokens" | "usd" | "tool_calls"; text: string };
  /** Up to three failed runs from steering cases that point at it. */
  failedRuns: FailedRun[];
};

/** A mock field a change can touch, and who reads it. */
export type ChangeReader = { client: ClimbClient; reads: "reads" | "ignores" | "unconfirmed" };

export type ChangeEntry = {
  rank: number;
  where: { kind: "server" | "tool" | "param"; tool?: string; param?: string; field: string; mockPath: string };
  current: unknown;
  readBy: ChangeReader[];
  /** False when every client of the climb ignores it (a confirmed fact): a round that changes only this is refused. */
  readByAnyClient: boolean;
  failedIterations: number;
  failedRuns: FailedRun[];
  tried: Array<{ round: number; verdict: PlatformClimbVerdict }>;
};

/** What the real server lists, as far as the ranking needs. */
export type RealServerView = {
  serverInfo?: { name?: string; title?: string; version?: string };
  instructions?: string;
  tools: Array<{
    name: string;
    title?: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
    annotations?: unknown;
  }>;
};

export type TriedChange = { round: number; verdict: PlatformClimbVerdict; changes: MockChange[] };

export type KeptRound = {
  number: number;
  validation?: "better" | "unchanged";
  overruled: boolean;
  /** The round's change list: what it changed against the best before it. */
  changes: MockChange[];
};
