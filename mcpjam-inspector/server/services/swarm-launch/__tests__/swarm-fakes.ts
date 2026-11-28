/**
 * The swarm adapter's ports, faked on top of the engine's fakes: a scripted
 * plan, funding preview and `launchJourneyRun`, and the refusals that last
 * one throws as it maps the backend's.
 */
import { vi } from "vitest";
import { ErrorCode, WebRouteError } from "../../../routes/web/errors.js";
import {
  SwarmAgentError,
  type SwarmFundingPreview,
} from "../../swarm-agent.js";
import type {
  PlanSwarmLaunchResult,
  PlannedGoal,
} from "../../../../shared/swarm-launch.js";
import type {
  SwarmItemParams,
  SwarmLaunchDeps,
  SwarmLaunchPorts,
} from "../adapter.js";
import type { LaunchJourneyRunInput } from "../../sessionSimulation/launch-journey-run.js";
import {
  REQUEST_BEARER,
  RUN_BEARER,
  createFakePorts,
  createLauncher,
  type FakeBackendOptions,
  type LaunchOutcome,
} from "../../run-group-launch/__tests__/fakes.js";

export {
  NOW,
  REQUEST_BEARER,
  RUN_BEARER,
  recordOf,
} from "../../run-group-launch/__tests__/fakes.js";

export function plannedGoal(goalId: string, sessionCount = 2): PlannedGoal {
  return {
    goalId,
    originalGoalId: goalId,
    sourceRunId: null,
    name: `Goal ${goalId}`,
    updatedAt: 1,
    hostIds: ["host-1"],
    environmentIds: [],
    config: {},
    sessionsPerTarget: sessionCount,
    targetCount: 1,
    sessionCount,
    modelProblems: [],
  };
}

export function planOf(goalIds: string[]): PlanSwarmLaunchResult {
  const goals = goalIds.map((id) => plannedGoal(id));
  return {
    swarmId: "swarm-1",
    sourceSwarmRunId: "sr_source",
    goals,
    problems: [],
    sessionTotal: goals.reduce((sum, goal) => sum + goal.sessionCount, 0),
  };
}

/** A preview of two conversations per goal, `sponsored[i]` of them sponsored. */
export function previewOf(sponsored: number[]): SwarmFundingPreview {
  return {
    supported: true,
    remaining: 100,
    granted: 100,
    runs: sponsored.map((count) => ({
      sponsored: count,
      credits: 2 - count,
      total: 2,
      targets: [],
    })),
  };
}

export const UNSUPPORTED: SwarmFundingPreview = {
  supported: false,
  remaining: 0,
  granted: 0,
  runs: [],
};

/** The refusals `launchJourneyRun` throws, as it maps the backend's. */
export const refusals = {
  invalid: () =>
    new WebRouteError(
      400,
      ErrorCode.VALIDATION_ERROR,
      "This journey has no pinned hosts to run",
    ),
  missing: () =>
    new WebRouteError(404, ErrorCode.NOT_FOUND, "This goal was not found."),
  unprocessable: () =>
    new WebRouteError(
      422,
      ErrorCode.VALIDATION_ERROR,
      "This organization has no model set up for that role.",
      { code: "org_model_unconfigured" },
    ),
  billing: () =>
    new WebRouteError(
      402,
      ErrorCode.BILLING_LIMIT_REACHED,
      "This launch would exceed your organization's credit limit.",
    ),
  usageLimit: () =>
    new WebRouteError(
      429,
      ErrorCode.RATE_LIMITED,
      "Daily MCPJam model limit reached. Use BYOK or try again tomorrow.",
      { code: "user_rate_limit" },
    ),
  dailyRunLimit: () =>
    new WebRouteError(
      429,
      ErrorCode.RATE_LIMITED,
      "Your plan's daily swarm runs are used up.",
      { code: "billing_limit_reached" },
    ).withHeaders({ "Retry-After": "40000" }),
  fundingChanged: () =>
    new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      "Sponsored conversations changed while you were reviewing this launch.",
      {
        code: "swarm_funding_changed",
        expectedSponsored: 1,
        actualSponsored: 0,
        totalConversations: 2,
      },
    ),
  conflict: () =>
    new WebRouteError(
      409,
      ErrorCode.CONFLICT,
      "This run's budgets could not be read.",
    ),
  policy: () =>
    new WebRouteError(
      403,
      ErrorCode.FORBIDDEN,
      "This organization requires its own provider keys for AI features.",
      { code: "org_keys_required" },
    ),
  draining: () =>
    new WebRouteError(
      429,
      ErrorCode.RATE_LIMITED,
      "This server is restarting. Try again in a few seconds.",
      { reason: "SERVER_DRAINING" },
    ).withHeaders({ "Retry-After": "5" }),
  expired: () =>
    new WebRouteError(
      401,
      ErrorCode.UNAUTHORIZED,
      "Invalid or expired session token",
    ),
  throttled: (seconds?: number) => {
    const error = new WebRouteError(
      429,
      ErrorCode.RATE_LIMITED,
      "Too many launches. Slow down and retry.",
      { code: "rate_limited" },
    );
    return seconds === undefined
      ? error
      : error.withHeaders({ "Retry-After": String(seconds) });
  },
  serverError: () =>
    new SwarmAgentError(503, "upstream", "swarm-agent create failed (503)"),
  network: () => new TypeError("fetch failed"),
};

export interface SwarmFakeOptions {
  plan?: PlanSwarmLaunchResult | Error;
  preview?: SwarmFundingPreview | Error;
  /** Per goal, the outcome of each launch attempt in turn; then a run. */
  outcomes?: Record<string, LaunchOutcome[]>;
  backend?: FakeBackendOptions<SwarmItemParams>;
}

export function createSwarmFakes(options: SwarmFakeOptions = {}) {
  const engine = createFakePorts<SwarmItemParams>(options.backend);
  const launcher = createLauncher(options.outcomes);
  const ports: SwarmLaunchPorts = {
    ...engine.ports,
    plan: vi.fn(async (bearer, args) => {
      engine.calls.push({ fn: "plan", bearer, args });
      if (options.plan instanceof Error) throw options.plan;
      return options.plan ?? planOf(["g1", "g2", "g3"]);
    }),
    previewFunding: vi.fn(async (bearer, args) => {
      engine.calls.push({ fn: "preview", bearer, args });
      const preview = options.preview ?? UNSUPPORTED;
      if (preview instanceof Error) throw preview;
      return preview;
    }),
    resolveLocalHarness: vi.fn(async () => ({ eligibleHarnessIds: [] })),
    launchGoal: vi.fn((deps, input) =>
      launcher.launch(input.journeyRefId, deps.bearerToken, { deps, input }),
    ),
  };
  const deps: SwarmLaunchDeps = {
    bearerToken: REQUEST_BEARER,
    getRunBearer: vi.fn(async () => RUN_BEARER),
    xaaIssuer: "https://issuer.test/api/web/xaa",
    callerContext: {},
  };
  return {
    ...engine,
    ports,
    deps,
    launcher,
    /** What each `launchJourneyRun` call was asked to launch, in order. */
    inputs: () =>
      launcher.launches.map(
        (launch) => (launch.detail as { input: LaunchJourneyRunInput }).input,
      ),
  };
}
