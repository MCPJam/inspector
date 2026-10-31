/**
 * The claim loops a server process runs beside its HTTP traffic. Each polls
 * Convex for one kind of claimable job and executes it in this process; the
 * backend owns the fleet-wide caps and the stale-lease sweeps that recover a
 * job whose process died.
 */

import {
  isScheduledEvalsWorkerEnabled,
  startScheduledEvalsWorker,
  type ScheduledEvalsWorkerHandle,
} from "./scheduled-evals-worker";
import {
  isGithubChecksWorkerEnabled,
  startGithubChecksWorker,
  type GithubChecksWorkerHandle,
} from "./github-checks-worker";
import {
  startProductionChecksWorker,
  type ProductionChecksWorkerHandle,
} from "./production-checks-worker";
import {
  isBenchWorkerEnabled,
  startBenchWorker,
  type BenchWorkerHandle,
} from "./bench-worker";

export interface BackgroundWorkers {
  /** Stops every loop, each after its in-flight job (if any) settles. */
  stop: () => Promise<void>;
}

export function startBackgroundWorkers(): BackgroundWorkers {
  // Scheduled eval runs (synthetic monitors): claim-and-execute polling loop.
  // Env-gated; the backend cron has its own SCHEDULED_EVALS_ENABLED gate.
  let scheduledEvalsWorker: ScheduledEvalsWorkerHandle | undefined;
  if (isScheduledEvalsWorkerEnabled()) {
    scheduledEvalsWorker = startScheduledEvalsWorker();
  }

  // GitHub PR check runs: claim a PR trigger, build its MCP server in a
  // sandbox, run the dedicated eval suite, report an outcome. Env-gated; the
  // backend has its own GITHUB_CHECKS_ENABLED gate and 404s the routes when it
  // is off.
  let githubChecksWorker: GithubChecksWorkerHandle | undefined;
  if (isGithubChecksWorkerEnabled()) {
    githubChecksWorker = startGithubChecksWorker();
  }

  // Hosted Connector Bench runs: claim a benchmark job, run one eval child per
  // matrix cell against the run's pinned server, attach the evidence.
  // Env-gated; the backend has its own BENCHMARK_RUNS_ENABLED gate and 404s the
  // routes when it is off, which parks this loop on a slow poll.
  let benchWorker: BenchWorkerHandle | undefined;
  if (isBenchWorkerEnabled()) {
    benchWorker = startBenchWorker();
  }

  // Production scoring: claim-and-grade polling loop for real User Testing
  // sessions. Started unconditionally and deliberately flagless — it
  // self-gates on the service-token env (a non-peer deployment gets an inert
  // handle), and the feature's single switch is the backend's
  // PRODUCTION_CHECKS_ENABLED, which 404s the claim route and parks this loop
  // on a slow poll when off.
  const productionChecksWorker: ProductionChecksWorkerHandle =
    startProductionChecksWorker();

  return {
    stop: async () => {
      await scheduledEvalsWorker?.stop();
      await githubChecksWorker?.stop();
      await benchWorker?.stop();
      await productionChecksWorker.stop();
    },
  };
}
