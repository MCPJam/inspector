/**
 * The two children that cost no model credits: the auth probe and the
 * conformance suite.
 *
 * Both are ordered ahead of the eval matrix on purpose — a wind-down should
 * never be what throws away the cheapest, most reusable evidence — and both
 * have to file what they found even when what they found is "we could not
 * reach it".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  conformanceChildExternalRunId,
  executeClaimedJob,
  type BenchExecutionDeps,
  type BenchmarkRosterEntry,
  type ClaimedBenchmarkJob,
} from "../bench-worker";
import type { BenchmarkProbeEvidence } from "../bench-probe-child";

const CLAIMED_BY = "inspector-bench-test";
const DEFINITION_HASH = "def-hash-1";
const ENDPOINT = "https://connector.example.com/mcp";

const PROBE_ROW: BenchmarkRosterEntry = {
  evidenceKey: "auth_probe",
  kind: "auth_probe",
  status: "expected",
  required: true,
  probeSpec: { serverUrl: ENDPOINT },
};

const CONFORMANCE_ROW: BenchmarkRosterEntry = {
  evidenceKey: "conformance",
  kind: "conformance_run",
  status: "expected",
  required: true,
  conformanceSpec: {
    serverUrl: ENDPOINT,
    suites: ["protocol", "oauth"],
    protocolVersion: "2025-11-25",
    oauth: {
      protocolVersion: "2025-11-25",
      registrationStrategy: "dcr",
      auth: { mode: "headless" },
      headlessCheckIds: ["oauth_unauthenticated_challenge"],
    },
  },
};

const EVAL_ROW: BenchmarkRosterEntry = {
  evidenceKey: "eval:a",
  kind: "eval_run",
  status: "expected",
  required: true,
  evalCell: { cellId: "a", suiteId: "suite-1", writeCases: false },
};

function job(roster: BenchmarkRosterEntry[]): ClaimedBenchmarkJob {
  return {
    jobId: "job-1",
    benchmarkRunId: "brun-1",
    organizationId: "org-1",
    projectId: "proj-1",
    serverId: "srv-1",
    serverName: "Target",
    leaseGeneration: 7,
    definitionHash: DEFINITION_HASH,
    pins: { definitionHash: DEFINITION_HASH },
    roster,
    grant: "grant-token",
    runnerBearer: "runner-bearer",
  };
}

const COMPLETED_PROBE: BenchmarkProbeEvidence = {
  observedEndpoint: ENDPOINT,
  discovery: { resourceMetadataFound: true },
  checks: [{ id: "auth_probe_unauthenticated_challenge", outcome: "passed" }],
  status: "completed",
};

type Recorded = {
  order: string[];
  probes: BenchmarkProbeEvidence[];
  conformance: Array<{ evidenceKey: string; conformanceRunId: string }>;
  conformanceSpecs: unknown[];
  externalRunIds: string[];
};

function harness(options?: {
  runAuthProbe?: BenchExecutionDeps["runAuthProbe"];
  runConformanceChild?: BenchExecutionDeps["runConformanceChild"];
}): { deps: Partial<BenchExecutionDeps>; recorded: Recorded } {
  const recorded: Recorded = {
    order: [],
    probes: [],
    conformance: [],
    conformanceSpecs: [],
    externalRunIds: [],
  };
  const deps: Partial<BenchExecutionDeps> = {
    runAuthProbe: async (args) => {
      recorded.order.push("probe");
      return (
        options?.runAuthProbe?.(args) ?? Promise.resolve(COMPLETED_PROBE)
      );
    },
    runConformanceChild: async (args) => {
      recorded.order.push("conformance");
      recorded.conformanceSpecs.push(args.spec);
      recorded.externalRunIds.push(
        conformanceChildExternalRunId(
          args.job.benchmarkRunId,
          args.entry.evidenceKey,
        ),
      );
      return (
        options?.runConformanceChild?.(args) ??
        Promise.resolve({ runId: "conf-run-1" })
      );
    },
    runEvalCell: async (args) => {
      recorded.order.push(`eval:${args.cell.cellId}`);
      return { runId: `run-${args.cell.cellId}`, executed: true };
    },
    attachProbe: async (args) => {
      recorded.probes.push(args.evidence);
    },
    attachConformance: async (args) => {
      recorded.conformance.push({
        evidenceKey: args.evidenceKey,
        conformanceRunId: args.conformanceRunId,
      });
    },
    attachEvidence: async () => {},
    cleanupArtifacts: async () => ({
      status: "clean" as const,
      attempted: 0,
      removed: 0,
      residue: 0,
      residualIds: [],
    }),
    executionComplete: async () => {},
    finalize: async () => {},
    analyze: async () => {},
    complete: async () => {},
    abort: async () => {},
    heartbeat: async () => ({ leaseOk: true }),
    heartbeatIntervalMs: 20_000,
  };
  return { deps, recorded };
}

describe("bench worker pillar children", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs the probe and the conformance suite before any eval cell", async () => {
    const { deps, recorded } = harness();
    await executeClaimedJob(
      job([EVAL_ROW, CONFORMANCE_ROW, PROBE_ROW]),
      CLAIMED_BY,
      deps,
    );

    expect(recorded.order).toEqual(["probe", "conformance", "eval:a"]);
    expect(recorded.conformance).toEqual([
      { evidenceKey: "conformance", conformanceRunId: "conf-run-1" },
    ]);
  });

  it("files a refused probe rather than suppressing it", async () => {
    // Writing nothing would leave the row `expected`, which reads as a probe
    // still to come rather than one that was refused.
    const refused: BenchmarkProbeEvidence = {
      observedEndpoint: ENDPOINT,
      discovery: { resourceMetadataFound: false },
      checks: [],
      status: "refused",
      failureReason: "Refusing to dial a private address",
    };
    const { deps, recorded } = harness({
      runAuthProbe: async () => refused,
    });
    await executeClaimedJob(job([PROBE_ROW]), CLAIMED_BY, deps);

    expect(recorded.probes).toEqual([refused]);
  });

  it("files a failed probe when the probe child throws outright", async () => {
    const { deps, recorded } = harness({
      runAuthProbe: async () => {
        throw new Error("probe module defect");
      },
    });
    await executeClaimedJob(job([PROBE_ROW]), CLAIMED_BY, deps);

    expect(recorded.probes).toHaveLength(1);
    expect(recorded.probes[0]).toMatchObject({
      status: "failed",
      checks: [],
      failureReason: "probe module defect",
    });
  });

  it("hands the conformance child its pinned headless OAuth scope", async () => {
    const { deps, recorded } = harness();
    await executeClaimedJob(job([CONFORMANCE_ROW]), CLAIMED_BY, deps);

    expect(recorded.conformanceSpecs[0]).toMatchObject({
      suites: ["protocol", "oauth"],
      oauth: {
        auth: { mode: "headless" },
        headlessCheckIds: ["oauth_unauthenticated_challenge"],
      },
    });
  });

  it("namespaces the conformance child's idempotency key so it cannot adopt another surface's run", async () => {
    const { deps, recorded } = harness();
    await executeClaimedJob(job([CONFORMANCE_ROW]), CLAIMED_BY, deps);

    expect(recorded.externalRunIds).toEqual(["benchmark:brun-1:conformance"]);
  });

  it("does not relaunch a pillar whose evidence already reached a terminal status", async () => {
    // A settled row owes nothing; relaunching would dial the target a second
    // time for evidence the run already holds.
    const { deps, recorded } = harness();
    await executeClaimedJob(
      job([PROBE_ROW, { ...CONFORMANCE_ROW, status: "unavailable" }]),
      CLAIMED_BY,
      deps,
    );

    expect(recorded.order).toEqual(["probe"]);
  });

  it("leaves a pillar row alone when the claim carried no launch spec", async () => {
    // Not fatal to the job: losing one pillar is not a reason to refuse the
    // exam the payer bought. The row stays `expected` for the backend's
    // roster sweep to degrade into a coverage gap.
    const { deps, recorded } = harness();
    await executeClaimedJob(
      job([
        PROBE_ROW,
        {
          evidenceKey: "conformance",
          kind: "conformance_run",
          status: "expected",
          required: true,
        },
      ]),
      CLAIMED_BY,
      deps,
    );

    expect(recorded.order).toEqual(["probe"]);
    expect(recorded.conformance).toEqual([]);
  });

  it("refuses to report the phase when evidence that RAN could not be attached", async () => {
    // A scorecard is inserted once and never patched, so a conformance run that
    // dialled the target and never got pointed at would be dropped for good.
    // The job goes back instead; the re-attempt adopts the same run.
    const completed: string[] = [];
    const aborted: string[] = [];
    const { deps } = harness();
    const running = executeClaimedJob(job([CONFORMANCE_ROW]), CLAIMED_BY, {
      ...deps,
      attachConformance: async () => {
        throw new Error("convex refused the write");
      },
      executionComplete: async () => {
        completed.push("reported");
      },
      abort: async (args) => {
        aborted.push(args.reason);
      },
    });
    // Past both backoffs on the attach ladder.
    await vi.advanceTimersByTimeAsync(30_000);
    await running;

    expect(completed).toEqual([]);
    expect(aborted[0]).toMatch(/could not be attached/);
  });

  it("does not attach conformance evidence when no child run was created", async () => {
    const { deps, recorded } = harness({
      runConformanceChild: async () => {
        throw new Error("suite could not start");
      },
    });
    await executeClaimedJob(job([CONFORMANCE_ROW]), CLAIMED_BY, deps);

    expect(recorded.order).toEqual(["conformance"]);
    expect(recorded.conformance).toEqual([]);
  });
});
