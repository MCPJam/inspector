/**
 * What a benchmark run owes after its children finish.
 *
 * Three properties, and each is a promise made to somebody who did not agree to
 * be a test subject:
 *
 *   - Cleanup runs whatever ended the run. Budget exhaustion, cancellation and
 *     a lost lease all reach it, because the artifacts are on a third party's
 *     server and the ids are in THIS worker's ledger.
 *   - It involves no model call. Cleanup that needed an LLM would be skipped by
 *     exactly the failure that most needs it.
 *   - The terminal sequence is fixed: execution-complete, finalize, analyzer,
 *     and the job's own completion LAST.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeClaimedJob,
  type BenchExecutionDeps,
  type BenchmarkRosterEntry,
  type ClaimedBenchmarkJob,
} from "../bench-worker";
import type { ArtifactCleanupReport } from "../evals/artifact-ledger";

const CLAIMED_BY = "inspector-bench-test";
const CASE_METADATA_HASH = "cases-1";

/**
 * The pinned manifest, in the shape the claim sends it: the definition's whole
 * `caseMetadata` section, keyed by case rather than by cell.
 */
const CASE_METADATA = {
  suiteHash: "suite-1",
  cases: [
    {
      caseId: "case-1",
      sideEffects: {
        mode: "test_write" as const,
        summary: "creates one page",
        allowedTools: ["create_page"],
        createRules: [
          {
            tool: "create_page",
            artifactNamePath: "name",
            requiredPrefix: "mcpjam-benchmark-",
            createdIdResultPaths: ["id"],
          },
        ],
        mutationTargetPaths: [],
        cleanupSteps: [{ tool: "delete_page", idArgPath: "page_id" }],
      },
    },
  ],
};

const WRITE_CELL: BenchmarkRosterEntry = {
  evidenceKey: "eval:w",
  kind: "eval_run",
  status: "expected",
  required: true,
  cellId: "w",
  environmentId: "env-w",
};

function writeCell(cellId: string): BenchmarkRosterEntry {
  return {
    ...WRITE_CELL,
    evidenceKey: `eval:${cellId}`,
    cellId,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve: () => resolve(undefined as T) };
}

function job(overrides?: Partial<ClaimedBenchmarkJob>): ClaimedBenchmarkJob {
  return {
    jobId: "job-1",
    benchmarkRunId: "brun-1",
    organizationId: "org-1",
    projectId: "proj-1",
    serverId: "srv-1",
    leaseGeneration: 4,
    pins: {
      definitionHash: "def-1",
      suiteId: "suite-1",
      caseMetadataHash: CASE_METADATA_HASH,
      caseMetadata: CASE_METADATA,
    },
    target: { targetKind: "server", targetKey: "srv-1" },
    consent: { authenticatedChecks: false, writeCases: true },
    roster: [WRITE_CELL],
    grant: "grant-token",
    runnerBearer: "runner-bearer",
    ...overrides,
  };
}

const CLEAN: ArtifactCleanupReport = {
  status: "clean",
  attempted: 1,
  removed: 1,
  residue: 0,
  residualIds: [],
};

function harness(options?: {
  runEvalCell?: BenchExecutionDeps["runEvalCell"];
  cleanup?: ArtifactCleanupReport;
  cleanupThrows?: boolean;
  heartbeat?: BenchExecutionDeps["heartbeat"];
  finalizeThrows?: unknown;
  analyzeThrows?: unknown;
  recordArtifacts?: BenchExecutionDeps["recordArtifacts"];
}) {
  const order: string[] = [];
  const reported: Array<ArtifactCleanupReport | undefined> = [];
  const deps: Partial<BenchExecutionDeps> = {
    runEvalCell: async (args) => {
      order.push(`cell:${args.cell.cellId}`);
      if (options?.runEvalCell) return options.runEvalCell(args);
      // The cell's own writes land in the ledger through the policy gate; here
      // the ledger is seeded directly so cleanup has something to remove.
      args.ledger.record({
        tool: "create_page",
        artifactName: "mcpjam-benchmark-brun-1-0-alpha",
        createdId: "page-1",
        cleanupSteps: [{ tool: "delete_page", idArgPath: "page_id" }],
      });
      return { runId: "run-w", executed: true };
    },
    cleanupArtifacts: async (args) => {
      order.push(`cleanup:${args.ledger.entries().length}`);
      if (options?.cleanupThrows) throw new Error("cleanup blew up");
      return options?.cleanup ?? CLEAN;
    },
    attachEvidence: async () => {},
    executionComplete: async (args) => {
      order.push("execution-complete");
      reported.push(args.cleanup);
    },
    finalize: async () => {
      order.push("finalize");
      if (options?.finalizeThrows) throw options.finalizeThrows;
    },
    analyze: async () => {
      order.push("analyze");
      if (options?.analyzeThrows) throw options.analyzeThrows;
    },
    complete: async () => {
      order.push("complete");
    },
    abort: async () => {
      order.push("abort");
    },
    recordArtifacts: options?.recordArtifacts ?? (async () => {}),
    heartbeat: options?.heartbeat ?? (async () => ({ leaseOk: true })),
    heartbeatIntervalMs: 20_000,
  };
  return { deps, order, reported };
}

describe("bench worker cleanup and the terminal sequence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("cleans up after the cells, then finalizes, analyzes, and completes LAST", async () => {
    const { deps, order } = harness();
    await executeClaimedJob(job(), CLAIMED_BY, deps);

    expect(order).toEqual([
      "cell:w",
      "cleanup:1",
      "execution-complete",
      "finalize",
      "analyze",
      "complete",
    ]);
  });

  it("reports the cleanup outcome with the phase that produced it", async () => {
    const residual: ArtifactCleanupReport = {
      status: "residual",
      attempted: 2,
      removed: 1,
      residue: 1,
      residualIds: ["page-9"],
    };
    const { deps, reported } = harness({ cleanup: residual });
    await executeClaimedJob(job(), CLAIMED_BY, deps);

    expect(reported).toEqual([residual]);
  });

  it("still cleans up when the budget is exhausted mid-run", async () => {
    // The failure that stops the run is exactly the one that must not stop the
    // tidy-up — and cleanup makes no model call, so it cannot be stopped by it.
    const inFlight = deferred<void>();
    const { deps, order } = harness({
      runEvalCell: async (args) => {
        args.ledger.record({
          tool: "create_page",
          artifactName: "mcpjam-benchmark-brun-1-0-alpha",
          createdId: `page-${args.cell.cellId}`,
          cleanupSteps: [{ tool: "delete_page", idArgPath: "page_id" }],
        });
        if (args.cell.cellId === "w") await inFlight.promise;
        return { runId: `run-${args.cell.cellId}`, executed: true };
      },
      heartbeat: async () => ({ leaseOk: true, budgetStatus: "exhausted" }),
    });

    const running = executeClaimedJob(
      job({ roster: [WRITE_CELL, writeCell("x")] }),
      CLAIMED_BY,
      { ...deps, heartbeatIntervalMs: 1 },
    );
    await vi.advanceTimersByTimeAsync(5);
    inFlight.resolve();
    await running;

    // The second cell never launched, and the first one's artifact was still
    // removed.
    expect(order).toEqual([
      "cell:w",
      "cleanup:1",
      "execution-complete",
      "finalize",
      "analyze",
      "complete",
    ]);
  });

  it("still cleans up after the lease is lost, because only this worker knows the ids", async () => {
    const inFlight = deferred<void>();
    const { deps, order } = harness({
      runEvalCell: async (args) => {
        args.ledger.record({
          tool: "create_page",
          artifactName: "mcpjam-benchmark-brun-1-0-alpha",
          createdId: "page-1",
          cleanupSteps: [{ tool: "delete_page", idArgPath: "page_id" }],
        });
        await inFlight.promise;
        return { runId: "run-w", executed: true };
      },
      heartbeat: async () => ({ leaseOk: false }),
    });
    const running = executeClaimedJob(job(), CLAIMED_BY, {
      ...deps,
      heartbeatIntervalMs: 1,
    });
    await vi.advanceTimersByTimeAsync(5);
    inFlight.resolve();
    await running;

    expect(order).toContain("cleanup:1");
    // Nothing is REPORTED after a lost lease: those are backend writes, and
    // the job belongs to somebody else now.
    expect(order).not.toContain("execution-complete");
    expect(order).not.toContain("complete");
  });

  it("does not let a cleanup defect replace the run's own outcome", async () => {
    const { deps, order, reported } = harness({ cleanupThrows: true });
    await executeClaimedJob(job(), CLAIMED_BY, deps);

    expect(order).toContain("complete");
    expect(reported[0]).toMatchObject({ status: "skipped", residue: 1 });
  });

  it("completes the job even when the analyzer cannot be triggered", async () => {
    // The analyzer produces an INFERRED artifact; a scorecard never depends on
    // it, so it must not be able to hold the job open.
    const { deps, order } = harness({
      analyzeThrows: new Error("analyzer unavailable"),
    });
    await executeClaimedJob(job(), CLAIMED_BY, deps);

    expect(order.slice(-2)).toEqual(["analyze", "complete"]);
  });

  it("aborts rather than completing when finalize fails", async () => {
    const { deps, order } = harness({
      finalizeThrows: new Error("scorecard assembly failed"),
    });
    await executeClaimedJob(job(), CLAIMED_BY, deps);

    expect(order).toContain("abort");
    expect(order).not.toContain("complete");
  });

  it("refuses a write cell whose manifest does not match the pinned hash", async () => {
    const { deps, order } = harness();
    await executeClaimedJob(
      job({ pins: { definitionHash: "def-1", caseMetadataHash: "other" } }),
      CLAIMED_BY,
      deps,
    );

    // Running under write rules the payer never consented to is worse than not
    // running: the claim is refused before any cell launches.
    expect(order).toEqual(["abort"]);
  });

  it("refuses a write cell that carries no manifest at all", async () => {
    // The payer consented to write cases, but the pinned definition declares
    // no side-effect manifest — so there is no enforceable bound on what the
    // cell may create on a third party's server. `publishDefinition` refuses
    // to publish that; a claim that produced it anyway is a contract breach.
    const { deps, order } = harness();
    await executeClaimedJob(
      job({
        pins: {
          definitionHash: "def-1",
          suiteId: "suite-1",
          caseMetadataHash: CASE_METADATA_HASH,
        },
      }),
      CLAIMED_BY,
      deps,
    );

    expect(order).toEqual(["abort"]);
  });
});
