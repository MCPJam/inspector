/**
 * The claim loops a server process runs beside its HTTP traffic, unless its
 * role leaves them to a worker deployment (`lifecycle/process-role`). Each
 * polls Convex for one kind of claimable job and executes it in this process;
 * the backend owns the fleet-wide caps and the stale-lease sweeps that recover
 * a job whose process died.
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
import {
  assertWorkerCanRunClaims,
  resolveProcessRole,
  type ProcessRole,
} from "./lifecycle/process-role";
import { getSystemLogger } from "../utils/request-logger";

export interface BackgroundWorkers {
  /**
   * Stops every loop at once, then resolves when each one's in-flight job (if
   * any) has settled. Each `stop()` aborts its polling before it awaits, so no
   * loop goes on claiming while another one's job finishes.
   */
  stop: () => Promise<void>;
}

export function startBackgroundWorkers(
  role: ProcessRole = resolveProcessRole(),
): BackgroundWorkers {
  getSystemLogger("workers").event("server.process_role", { role });
  // A web replica leaves every loop, the flagless production one included, to
  // the worker deployment.
  if (role === "web") return { stop: async () => {} };
  if (role === "worker") assertWorkerCanRunClaims();

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
      await Promise.all([
        scheduledEvalsWorker?.stop(),
        githubChecksWorker?.stop(),
        benchWorker?.stop(),
        productionChecksWorker.stop(),
      ]);
    },
  };
}
