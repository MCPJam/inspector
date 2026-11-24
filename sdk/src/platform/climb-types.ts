/**
 * The wire shapes of the climb operations. The backend settles every number
 * (the keep rule, the noise, the verdicts, the stop rule); these types only
 * name what it returns. Rates and ratios are whole basis points: 100 is 1%.
 */
export type PlatformClimbMeasure = "pass_rate" | "tokens" | "cost" | "tool_calls";
export type PlatformClimbState = "baselining" | "ready" | "running" | "stopped";
export type PlatformClimbStopReason =
  | "all_steering_pass"
  | "target_reached"
  | "round_limit"
  | "stopped_by_caller";
export type PlatformClimbVerdict = "kept" | "reverted" | "not_decided";
export type PlatformClimbSubmittedVia = "cli" | "mcp" | "api" | "app";

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
export type PlatformClimb = {
  climbId: string;
  suiteId: string;
  projectId: string;
  serverId: string;
  serverName: string;
  environmentIds: string[];
  picker: "person" | "agent";
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
    steeringToolsWithoutValidation: string[];
  };
  activeUnitKey?: string;
  baseline?: { settledAt: number; environments: PlatformClimbEnvironmentBaseline[] };
  best?: { serverId: string; serverVersion?: string; roundNumber: number };
  rounds: PlatformClimbRoundSummary[];
  confirmationCasesUsedBy: string[];
  confirmation?: PlatformClimbConfirmationRecord;
  verifications: PlatformClimbVerification[];
  createdAt: number;
  updatedAt: number;
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
