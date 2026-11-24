/**
 * The wire shapes of the climb operations. The backend settles every number
 * (the keep rule, the noise, the verdicts, the stop rule); these types only
 * name what it returns. Rates and ratios are whole basis points: 100 is 1%.
 */
import type { ChangeEntry, ClimbForOption, SuiteCheck } from "../climbs/types.js";
import type { ClimbSummary, ConfirmationSummary } from "../climbs/summary.js";
import type { ListingCheck } from "../climbs/listing-check.js";
import type { VerificationReport } from "../climbs/verification.js";

export type PlatformClimbMeasure = "pass_rate" | "tokens" | "cost" | "tool_calls";
export type PlatformClimbState = "baselining" | "ready" | "running" | "stopped";
export type PlatformClimbStopReason =
  | "all_steering_pass"
  | "target_reached"
  | "round_limit"
  | "stopped_by_caller";
export type PlatformClimbVerdict = "kept" | "reverted" | "not_decided";
export type PlatformClimbSubmittedVia = "cli" | "mcp" | "api" | "app" | "mcpjam";
export type PlatformClimbPicker = "person" | "agent" | "mcpjam";
/** Where MCPJam's steps run: a worker that holds the service credential, or the starter's own Inspector. */
export type PlatformClimbStepRunner = "hosted" | "local";
export type PlatformClimbPausedCode =
  | "attempts_exhausted"
  | "nothing_submitted"
  | "inspector_stopped"
  | "starter_unresolvable"
  | "feature_unavailable";

/** One group of cases on one environment, as the baseline measured it. */
export type PlatformClimbGroupBaseline = {
  counted: number;
  passed: number;
  lost: number;
  /** The pass rate of each of the two baseline runs. */
  passRateBps: [number, number];
  passRateNoiseBps: number;
  tokensNoiseBps?: number;
  costNoiseBps?: number;
  tool_callsNoiseBps?: number;
  /** The smallest change this group can show, per measure. */
  smallestChangeBps?: { pass_rate: number; tokens?: number; cost?: number; tool_calls?: number };
};

export type PlatformClimbEnvironmentBaseline = {
  environmentId: string;
  /** Which measures every counted iteration of this environment recorded. */
  recorded: { tokens: boolean; cost: boolean; tool_calls: boolean };
  noRoomToImprove: boolean;
  flippedSteeringCaseKeys: string[];
  /** Validation shows a count and never a case key. */
  flippedValidationCount: number;
  lostIterations: number;
  countedIterations: number;
  steering?: PlatformClimbGroupBaseline;
  validation?: PlatformClimbGroupBaseline;
};

/** A person's decision over the rule's verdict on a round: what they set, who, why and when (`at` is epoch ms). */
export type PlatformClimbOverrule = { to: PlatformClimbVerdict; by: string; reason: string; at: number };

export type PlatformClimbRoundSummary = {
  number: number;
  status: "running" | "settled" | "failed";
  serverId: string;
  serverVersion?: string;
  submittedBy: string;
  submittedVia: PlatformClimbSubmittedVia;
  openedAt: number;
  settledAt?: number;
  verdict?: PlatformClimbVerdict;
  /** What stands: the overrule if there is one, else the verdict. */
  standing?: PlatformClimbVerdict;
  reasons: string[];
  /** Present only when a person overruled the round. */
  overruled?: PlatformClimbOverrule;
  /** Set on a round MCPJam picked, with the chat session that holds its transcript. */
  pickedBy?: "mcpjam";
  pickerChatSessionId?: string;
};

export type PlatformClimbConfirmationRecord = {
  status: "running" | "settled" | "failed";
  unitKey: string;
  startedAt: number;
  startedBy: string;
  estimatedCredits: number;
  settledAt?: number;
  failureReason?: string;
  environments?: unknown[];
};

export type PlatformClimbVerification = {
  index: number;
  unitKey: string;
  mode: "paired" | "server_only";
  target: string;
  serverMockId: string;
  restoreMockId?: string;
  startedAt: number;
  startedBy: string;
  serverVersion?: string;
  commitSha?: string;
  branch?: string;
  repositoryUrl?: string;
  dirty?: boolean;
  listingCheck?: unknown;
  status: "running" | "settled" | "failed";
  verdict?: PlatformClimbVerdict;
  result?: Record<string, unknown>;
  failureReason?: string;
  settledAt?: number;
};

/** `climbs:getClimb`, as the backend describes a climb. */
export type PlatformClimbBase = {
  climbId: string;
  suiteId: string;
  projectId: string;
  serverId: string;
  serverName: string;
  environmentIds: string[];
  picker: PlatformClimbPicker;
  /** MCPJam as picker: the model it picks with, and where its steps run. */
  pickerModel?: string;
  stepRunner?: PlatformClimbStepRunner;
  /** The step MCPJam has waiting or running. Absent: none. */
  step?: { status: "due" | "claimed"; dueAt: number; attempts: number; emptyTurns: number; leaseExpiresAt?: number };
  /** Set while the climb waits for a person: say why, then `continue_climb`. A paused climb is still ready or running. */
  paused?: { at: number; code: PlatformClimbPausedCode; reason: string };
  /** What MCPJam's own turns cost; the credits are already in `limits.creditsCommitted`. */
  pickerSpend?: { credits: number; usd: number; tokens: number; turns: number };
  state: PlatformClimbState;
  stopReason?: PlatformClimbStopReason;
  measure: PlatformClimbMeasure;
  measureLocked: boolean;
  minImprovementBps: number;
  targetBps?: number;
  limits: {
    roundLimit: number;
    roundsStarted: number;
    roundsLeft: number;
    creditLimit: number;
    creditsCommitted: number;
    creditsLeft: number;
  };
  groups: {
    steering: number;
    validation: number;
    confirmation: number;
    steeringCases: Array<{ key: string; tool: string }>;
    /** Suite cases the groups do not name yet; each joins steering from the next round unless moved to confirmation. */
    newCases?: Array<{ key: string; tool: string }>;
    steeringToolsWithoutValidation: string[];
  };
  activeUnitKey?: string;
  /** The last baseline attempt failed: the climb stays `baselining` with no unit running. `reason` names the environment. `continue_climb` runs it again. */
  baselineFailure?: { unitKey: string; reason: string; failedAt?: number };
  baseline?: { settledAt: number; environments: PlatformClimbEnvironmentBaseline[] };
  best?: { serverId: string; serverVersion?: string; roundNumber: number };
  rounds: PlatformClimbRoundSummary[];
  confirmationCasesUsedBy: string[];
  confirmation?: PlatformClimbConfirmationRecord;
  verifications: PlatformClimbVerification[];
  createdAt: number;
  updatedAt: number;
};

/** What `get_climb` adds to it: the suite check, what to climb for and what can change, each from the SDK's climb functions. */
export type PlatformClimb = PlatformClimbBase & {
  suiteCheck?: SuiteCheck;
  climbFor?: ClimbForOption[];
  whatCanChange?: ChangeEntry[];
  /** Once a confirmation has settled: its per-environment difference and 95% interval, computed on read. */
  confirmationResult?: ConfirmationSummary;
  /** Each verification as a reader wants it: whether the gain holds, both gains, the baseline then and now, the commit. */
  verificationReports?: VerificationReport[];
  /** What this read could not do, in words a caller can act on. */
  notes?: string[];
};

export type PlatformClimbListItem = {
  climbId: string;
  suiteId: string;
  serverName: string;
  state: PlatformClimbState;
  measure: PlatformClimbMeasure;
  roundsStarted: number;
  roundLimit: number;
  createdAt: number;
};

/** What one unit (a baseline, a round, a confirmation, a verification) cost to start. */
export type PlatformClimbEstimate = {
  /** One run group's estimate. The backend multiplies by the group count. */
  creditsPerGroup: number;
  groups: number;
  /** `credits` is null when MCPJam could not price every run; this is a floor then. */
  lowerBound: boolean;
  /** The existing estimate is not an upper bound. */
  note: string;
};

/** The runs of one registered run group, after its launch. */
export type PlatformClimbLaunchedGroup = {
  role: string;
  runGroupId: string;
  serverId: string;
  serverVersion?: string;
  runs: Array<{ environmentId: string; runId: string }>;
};

export type PlatformClimbLaunch = {
  unitKey: string;
  estimate: PlatformClimbEstimate;
  groups: PlatformClimbLaunchedGroup[];
};

/** `start_climb`: the climb, and the baseline it launched. */
export type PlatformClimbStarted = PlatformClimb & { launch: PlatformClimbLaunch };

/** One side of a comparison in one environment: the measure or pass rate against the best so far. */
export type PlatformClimbMove = "better" | "worse" | "none";
export type PlatformClimbGroupResult = {
  passRate?: { candidateBps: number; bestBps: number; deltaBps: number; noiseBps: number; move: PlatformClimbMove };
  measure?: { ratioBps: number; noiseBps: number; comparedCases: number; move: PlatformClimbMove };
};

/** `climbRounds:getClimbRound`: one round in full. Validation is totals per environment, never a case. */
export type PlatformClimbRound = PlatformClimbRoundSummary & {
  estimatedCredits: number;
  remeasuredBest: boolean;
  remeasureReason?: string;
  againstBest: unknown;
  validation?: "better" | "unchanged";
  failedSteeringCaseKeys: string[];
  validationRegressed?: boolean;
  environments: Array<{
    environmentId: string;
    candidateLost: number;
    bestLost: number;
    measureRecorded: boolean;
    steering?: PlatformClimbGroupResult;
    validation?: PlatformClimbGroupResult;
  }>;
  environmentsWithoutMeasure: string[];
  failureReason?: string;
};

/** `set_climb_round_decision`: the round as it now stands, and the best so far after the overrule. */
export type PlatformClimbDecision = {
  climbId: string;
  suiteId: string;
  round: PlatformClimbRound;
  best: PlatformClimb["best"];
};

/** What waiting for a round did: whether it settled, and for how long it waited. */
export type PlatformClimbRoundRead = PlatformClimbRound & {
  climbId: string;
  suiteId: string;
  waitedMs: number;
  settled: boolean;
};

/** `submit_climb_round`: the round that opened, what it will cost, and the runs it launched. */
export type PlatformClimbRoundSubmitted = {
  climbId: string;
  suiteId: string;
  roundNumber: number;
  unitKey: string;
  /** True when the same idempotency key had already registered this round: nothing was charged or launched again. */
  replayed: boolean;
  estimate: PlatformClimbEstimate;
  /** The best so far is measured again in this round, and why. */
  remeasureBest: boolean;
  remeasureReasons: string[];
  groups: PlatformClimbLaunchedGroup[];
};

/** `stop_climb`: where the climb ended and the rounds that stand as kept. */
export type PlatformClimbStopped = {
  climbId: string;
  suiteId: string;
  state: "stopped";
  stopReason: PlatformClimbStopReason;
  best: PlatformClimb["best"];
  kept: Array<{
    number: number;
    serverId: string;
    serverVersion?: string;
    validation?: "better" | "unchanged";
    overruled: boolean;
  }>;
  /** For the coding agent that works on the server's code: the kept changes in order, those that also helped on validation first. */
  prompt: string;
  /** Steering and validation results labeled as the cases that picked the result, the confirmation, and what the climb established and did not. */
  summary: ClimbSummary;
};

/** `confirm_climb`: the two run groups on the confirmation cases, or, with `dryRun`, only what they would cost. */
export type PlatformClimbConfirmed = {
  climbId: string;
  suiteId: string;
  dryRun: boolean;
  estimate: PlatformClimbEstimate;
  confirmationCaseCount: number;
  environmentIds: string[];
  /** Earlier climbs on the suite that used any of the same confirmation cases: a second look at them is selection again. */
  confirmationCasesUsedBy: string[];
  /** Absent on a dry run. */
  unitKey?: string;
  groups?: PlatformClimbLaunchedGroup[];
  /** Present once the confirmation settled within the wait. */
  result?: ConfirmationSummary;
  summary?: ClimbSummary;
  /** False when the call returned with the confirmation still running: read `get_climb` for it. */
  settled: boolean;
};

/** `verify_climb`: the listing check, and when it ran, the pair of run groups and the verdict. */
export type PlatformClimbVerified = {
  climbId: string;
  suiteId: string;
  dryRun: boolean;
  /** False for a dry run, and when the listing check stopped it. */
  ran: boolean;
  /** Each kept change against the server's listing now: applied, missing or different. */
  listingCheck: ListingCheck;
  /** Why no run started, when the check found a change missing or different and `runAnyway` was not given. */
  blockedBecause?: string;
  estimate: PlatformClimbEstimate;
  /** `paired`: the server beside the mock that puts the old values back. `server_only`: a kept change cannot be put back. */
  mode: "paired" | "server_only";
  /** What could not be put back, and why: the reason only the server runs. */
  unrestorable: Array<{ path: string; why: string }>;
  unitKey?: string;
  verificationIndex?: number;
  groups?: PlatformClimbLaunchedGroup[];
  /** Present once the verification settled within the wait. */
  report?: VerificationReport;
  settled: boolean;
};

/** `continue_climb`: the pause is cleared; the next step is due now, or when the round in flight settles. */
export type PlatformClimbContinued =
  | { climbId: string; suiteId: string; resumed: true; stepDue: boolean; baselineStarted?: false }
  | { climbId: string; suiteId: string; resumed: false; baselineStarted: true; launch: PlatformClimbLaunch };

/** `draft_climb_change`: a model's rewrite of one tool's description, as a draft and as the merge patch that applies it. */
export type PlatformClimbDraft = {
  climbId: string;
  suiteId: string;
  toolName: string;
  description: string;
  title?: string;
  modelUsed: string;
  /** Which description it rewrote: the mock's own edit in the best version, or the real server's stored listing. */
  basedOn: "mock" | "real_server";
  failedCaseKeys: string[];
  /** How many failed iterations the model read. */
  trialsRead: number;
  /** An RFC 7396 merge patch of the mock definition, as a JSON string. */
  patchJson: string;
};
