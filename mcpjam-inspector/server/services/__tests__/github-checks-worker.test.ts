import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import {
  awaitJudgeVerdict,
  describeCheckFailure,
  effectiveRunResult,
  executeClaimedCheck,
  runReachedAVerdict,
  verifyRunSnapshot,
  claimNextForTests,
  CloneTokenUnavailableError,
  LeaseLostError,
  mintCloneTokenForTests,
  startGithubChecksWorker,
  type CheckExecutionDeps,
  type PlanlessCheckReport,
  type ClaimedGithubCheck,
} from "../github-checks-worker";
import { CheckStepError, type CheckSandbox } from "../github-checks/sandbox";
import {
  CheckStoppedByPlan,
  PlanProtocolError,
  PlanUnreachableError,
  type AttemptInput,
  type CheckPlanSession,
} from "../github-checks/check-plan";

// Three invariants drive every test here, because all three are visible on
// somebody's pull request when they break:
//
//   1. A claimed trigger ALWAYS gets exactly one COMPLETION, on every path, and
//      the sandbox is always torn down. An unreported claim shows up as a check
//      that hangs for five minutes and then goes neutral.
//   2. THE WORKER NO LONGER NAMES THE VERDICT. `/complete` carries no `outcome`;
//      the backend derives it from the attempt log and the BOUND run. The one
//      exception is a check that never got a plan at all, which is neutral by
//      construction.
//   3. THE EVAL ATTEMPT IS POSTED AT LAUNCH, carrying the runId — that attempt
//      is what binds the run to the check, and a check whose run is not bound
//      can only ever be `infra_error`.

const CLAIM: ClaimedGithubCheck = {
  triggerId: "trig-1",
  repoFullName: "mcpjam/mcp-check-fixture",
  prNumber: 12,
  headSha: "a".repeat(40),
  organizationId: "org-1",
  projectId: "proj-1",
  createdByExternalId: "user_workos_1",
  suiteId: "suite-1",
  repoPrivate: false,
};

/** The same check, on a repository that needs a credential to clone. */
const PRIVATE_CLAIM: ClaimedGithubCheck = { ...CLAIM, repoPrivate: true };

/** A stand-in installation token. Never real, always asserted absent. */
const CLONE_TOKEN = "ghs_privateRepoToken1234567890";

const RECIPE = {
  build: "npm ci && npm run build",
  start: "npm start",
  port: 3001,
  mcpPath: "/mcp",
  rung: "override" as const,
  ownershipProof: "verified" as const,
  evidence: ["operator override for mcpjam/mcp-check-fixture"],
};

type Completion = {
  runId?: string;
  conformanceRunId?: string;
  summary?: unknown;
  detailsMarkdown?: string;
  terminalAttempt?: AttemptInput;
};

type Harness = {
  deps: Partial<CheckExecutionDeps>;
  /** Every `resolveAndStart` args object, so the threaded token is assertable. */
  resolveArgs: Array<{ cloneToken?: string }>;
  /** Planless reports — reachable ONLY when `/plan/begin` produced no plan. */
  reports: PlanlessCheckReport[];
  /** Every `/attempt` the worker itself posted (the resolver's are its own). */
  attempts: AttemptInput[];
  /** Every `/complete`. Exactly one per claim, on every path but a lost lease. */
  completions: Completion[];
  events: string[];
  heartbeats: string[];
  /**
   * The box `resolveAndStart` hands back. Exposed so a test can wrap its
   * command channel — the post-failure liveness diagnostic is the one thing the
   * WORKER still runs against the sandbox itself.
   */
  sandbox: CheckSandbox;
};

/**
 * `liveness` scripts what the post-failure in-box liveness check finds: the stdout
 * the node one-liner prints, or "throws" for a box that no longer answers at all.
 * Default is empty stdout — no sentinel, so "could not tell", so neutral.
 */
function harness(
  overrides?: Partial<CheckExecutionDeps>,
  liveness?: string,
  planOptions?: {
    beginThrows?: unknown;
    attemptThrows?: (input: AttemptInput) => unknown;
    evalAction?: "complete" | "run_conformance";
  }
): Harness {
  const reports: PlanlessCheckReport[] = [];
  const attempts: AttemptInput[] = [];
  const completions: Completion[] = [];
  const events: string[] = [];
  const heartbeats: string[] = [];
  const resolveArgs: Array<{ cloneToken?: string }> = [];
  const {
    runEvalSuite: runEvalSuiteOverride,
    runConformance: runConformanceOverride,
    ...restOverrides
  } = overrides ?? {};

  const session: CheckPlanSession = {
    planId: "plan-1",
    candidates: async () => ({
      candidates: [],
      stopPolicy: { maxCandidates: 3, wallClockMs: 1_200_000 },
    }),
    attempt: async (input) => {
      attempts.push(input);
      events.push(`attempt:${input.phase}:${input.ok ? "ok" : "fail"}`);
      const thrown = planOptions?.attemptThrows?.(input);
      if (thrown) throw thrown;
      if (input.phase === "eval" && input.ok) {
        if (planOptions?.evalAction === "run_conformance") {
          return { action: "run_conformance", reason: "eval_bound" };
        }
        return { action: "complete", reason: "verdict_established" };
      }
      return { action: "continue_phase" };
    },
    complete: async (input) => {
      completions.push(input);
      events.push("complete");
    },
  };

  const sandbox = {
    sandboxId: "sb_1",
    getHost: (port: number) => `${port}-sb_1.e2b.app`,
    commands: {
      run: async (command: string) => {
        // The post-failure liveness check is the only command this fake sees.
        if (command.includes("MCPJAM_CHECK_HTTP_ANSWERED")) {
          events.push("livenessCheck");
          if (liveness === "throws") throw new Error("sandbox not found");
          return { stdout: liveness ?? "" };
        }
        return {};
      },
    },
    kill: async () => {},
  } as unknown as CheckSandbox;

  const deps: Partial<CheckExecutionDeps> = {
    beginPlan: async () => {
      events.push("beginPlan");
      if (planOptions?.beginThrows) throw planOptions.beginThrows;
      return session;
    },
    // The ladder, the boxes, the plan loop and the runtime verification are one
    // collaborator (`resolve-and-start.ts`, tested in its own suite). What the
    // WORKER owes is exactly one completion per claim, the eval attempt posted
    // at launch, and teardown of whatever box it was handed.
    mintCloneToken: async () => {
      events.push("mintCloneToken");
      return CLONE_TOKEN;
    },
    resolveAndStart: async (_args, overrides) => {
      resolveArgs.push(_args);
      events.push("resolveAndStart");
      overrides?.onSandbox?.(sandbox);
      return {
        sandbox,
        recipe: RECIPE,
        candidateId: "c1",
        started: {
          url: "https://3001-sb_1.e2b.app/mcp",
          readStderrTail: async () => "",
          spawn: { pid: 1234, pgrp: 1234 },
        },
        provenance: {
          recipeRung: RECIPE.rung,
          recipeEvidence: RECIPE.evidence,
        },
      };
    },
    killSandbox: async () => {
      events.push("killSandbox");
    },
    getBearer: async () => {
      events.push("getBearer");
      return "delegated-jwt";
    },
    createEphemeralServer: async (args) => {
      events.push(`createServer:${args.name}:${args.url}`);
      return "server-1";
    },
    deleteEphemeralServer: async (args) => {
      events.push(`deleteServer:${args.serverId}`);
    },
    recordServer: async (triggerId, serverId) => {
      events.push(`recordServer:${triggerId}:${serverId}`);
    },
    runEvalSuite: async (args) => {
      events.push("runEvalSuite");
      if (runEvalSuiteOverride) return runEvalSuiteOverride(args);
      await args.onRunStarted?.("run-1");
      return {
        runId: "run-1",
        result: "passed",
        summary: { total: 3, passed: 3, failed: 0, passRate: 1 },
      };
    },
    runConformance: async (args) => {
      events.push("runConformance");
      if (runConformanceOverride) return runConformanceOverride(args);
      await args.onRunStarted?.("conf-run-1");
      return { runId: "conf-run-1" };
    },
    report: async (report) => {
      reports.push(report);
      events.push(`report:${report.outcome}`);
    },
    heartbeat: async (triggerId) => {
      heartbeats.push(triggerId);
    },
    heartbeatIntervalMs: 1_000,
    ...restOverrides,
  };

  return {
    deps,
    resolveArgs,
    reports,
    attempts,
    completions,
    events,
    heartbeats,
    sandbox,
  };
}

describe("executeClaimedCheck — happy path", () => {
  it("begins the plan FIRST, runs the suite, completes with no outcome, cleans up", async () => {
    const h = harness();
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);

    expect(h.events).toEqual([
      // Before any sandbox work — that is what makes a provision or clone
      // failure attributable instead of planless.
      "beginPlan",
      "resolveAndStart",
      "getBearer",
      "createServer:gh-check-trig-1:https://3001-sb_1.e2b.app/mcp",
      "recordServer:trig-1:server-1",
      "runEvalSuite",
      "attempt:eval:ok",
      "complete",
      "deleteServer:server-1",
      "killSandbox",
    ]);
    expect(h.completions).toEqual([
      {
        runId: "run-1",
        summary: { total: 3, passed: 3, failed: 0, passRate: 1 },
      },
    ]);
    // NO OUTCOME. The backend derives it from the attempts and the bound run;
    // sending one would take the legacy path and put the verdict back here.
    expect(h.completions[0]).not.toHaveProperty("outcome");
    // And the planless path — the only one that still names an outcome — was
    // never taken.
    expect(h.reports).toHaveLength(0);
  });

  it("runs conformance after a product-failing eval when the backend says run_conformance", async () => {
    const h = harness(
      {
        runEvalSuite: async (args) => {
          await args.onRunStarted?.("run-2");
          return {
            runId: "run-2",
            result: "failed",
            summary: { total: 4, passed: 1, failed: 3, passRate: 0.25 },
          };
        },
      },
      undefined,
      { evalAction: "run_conformance" }
    );
    await executeClaimedCheck(
      { ...CLAIM, conformanceEnabled: true },
      "worker-1",
      h.deps
    );

    expect(h.events).toEqual(
      expect.arrayContaining([
        "runEvalSuite",
        "attempt:eval:ok",
        "runConformance",
        "attempt:conformance:ok",
        "complete",
      ])
    );
    expect(h.events.indexOf("runEvalSuite")).toBeLessThan(
      h.events.indexOf("runConformance")
    );
    expect(h.completions[0]).toMatchObject({
      runId: "run-2",
      conformanceRunId: "conf-run-1",
    });
    expect(JSON.stringify(h.attempts)).not.toContain("evals_failed");
  });

  it("posts the eval attempt AT LAUNCH, carrying the runId that binds the run", async () => {
    // The binding is what turns "belongs to the shared github-checks suite" into
    // "belongs to THIS check". Posted after the run instead, every completion in
    // between could only ever be `infra_error`.
    const order: string[] = [];
    const h = harness({
      runEvalSuite: async (args) => {
        order.push("launch");
        await args.onRunStarted?.("run-7");
        order.push("execute");
        return { runId: "run-7", result: "passed" };
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);

    expect(order).toEqual(["launch", "execute"]);
    expect(h.attempts).toEqual([
      {
        candidateId: "c1",
        phase: "eval",
        ok: true,
        runId: "run-7",
        durationMs: 0,
      },
    ]);
    expect(h.completions[0].runId).toBe("run-7");
  });

  it("never reports `evals_failed` itself when the run fails", async () => {
    // The kind was removed from the backend union entirely: "evals failed" is a
    // statement about the pull request, and it comes only from the backend
    // reading the bound run's result.
    const h = harness({
      runEvalSuite: async (args) => {
        await args.onRunStarted?.("run-2");
        return {
          runId: "run-2",
          result: "failed",
          summary: { total: 4, passed: 1, failed: 3, passRate: 0.25 },
        };
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);

    expect(h.completions[0]).toMatchObject({ runId: "run-2" });
    expect(JSON.stringify(h.attempts)).not.toContain("evals_failed");
    expect(JSON.stringify(h.completions)).not.toContain("evals_failed");
  });

  it("records the ephemeral server BEFORE running the suite, so a mid-run death is recoverable", async () => {
    const h = harness();
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.events.indexOf("recordServer:trig-1:server-1")).toBeLessThan(
      h.events.indexOf("runEvalSuite")
    );
  });

  it("targets the run at THIS check's server and refreshes the suite snapshot", async () => {
    // `serverIds` alone is not enough: it never reaches the run-start mutation,
    // so the run's configSnapshot.environment comes from the suite's persisted
    // environment — which names the PREVIOUS check's deleted server unless the
    // snapshot is refreshed. Without this the runner fails on a dead reference
    // instead of testing the PR.
    const prepared: Array<Record<string, unknown>> = [];
    const h = harness({
      runEvalSuite: async (args) => {
        prepared.push({ ...args });
        return { runId: "run-1", result: "passed" };
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);

    // The suite-snapshot refresh itself lives in `defaultRunEvalSuite`, which
    // needs a live Convex + connected manager and is covered by the end-to-end
    // pass; what is checkable here is that the run is handed THIS check's
    // freshly-created server rather than anything the suite has stored.
    expect(prepared[0]).toMatchObject({
      serverId: "server-1",
      serverName: "gh-check-trig-1",
    });
  });
});

describe("executeClaimedCheck — the plan owns the verdict", () => {
  it("completes with the author-facing copy when the resolver stopped, and no outcome", async () => {
    const h = harness({
      resolveAndStart: async () => {
        throw new CheckStoppedByPlan(
          "no_candidates",
          "Add `mcpjam.yaml` at the repository root:",
          true
        );
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);

    expect(h.completions).toHaveLength(1);
    expect(h.completions[0]).not.toHaveProperty("outcome");
    // The resolver's copy is OUR prose and reaches the check output as markdown,
    // not wrapped in a `text` fence that would render it as source.
    expect(h.completions[0].detailsMarkdown).toContain("mcpjam.yaml");
    expect(h.completions[0].detailsMarkdown).not.toContain("```text");
    expect(h.events).not.toContain("runEvalSuite");
    expect(h.events).toContain("killSandbox");
  });

  it("passes a clamped build log through without double-fencing it", async () => {
    const h = harness({
      resolveAndStart: async () => {
        throw new CheckStepError(
          "build_failed",
          "build command exited 1",
          "```text\nnpm ERR! missing script: build\n```"
        );
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);

    expect(h.completions[0].detailsMarkdown).toContain("missing script: build");
    expect(h.completions[0].detailsMarkdown).not.toContain("```text\n```text");
    expect(h.events).not.toContain("runEvalSuite");
    expect(h.events).toContain("killSandbox");
  });

  it("completes with the DEGRADED marker when the backend went away mid-flight", async () => {
    // Countable rather than inferred: `backend_unreachable` attributes to
    // `infra_error` — neutral, never a green, never PR-blamed.
    const h = harness({
      resolveAndStart: async () => {
        throw new PlanUnreachableError("attempt", "ECONNRESET", {
          phase: "probe",
          candidateId: "c2",
        });
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);

    expect(h.completions[0].terminalAttempt).toMatchObject({
      phase: "probe",
      candidateId: "c2",
      ok: false,
      failureKind: "backend_unreachable",
    });
    expect(h.completions[0]).not.toHaveProperty("outcome");
  });

  it("completes WITHOUT a marker when the backend refused us (409)", async () => {
    // A 409 means we violated the state machine, not that the backend is gone —
    // so there is nothing degraded to record, and nothing is retried.
    const h = harness({
      resolveAndStart: async () => {
        throw new PlanProtocolError("attempt", "candidate_out_of_order", 409);
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);

    expect(h.completions).toHaveLength(1);
    expect(h.completions[0]).not.toHaveProperty("terminalAttempt");
    expect(h.events).not.toContain("runEvalSuite");
  });

  it("reports infra_error — planless — when /plan/begin never gave us a plan, and runs NOTHING", async () => {
    // No plan means no attempt log to derive from, so this is the one path that
    // still names an outcome. Critically, no box is provisioned: executing a
    // check we could not plan would mean running our own candidate policy
    // invisibly, which is exactly what degraded mode forbids.
    const h = harness(undefined, undefined, {
      beginThrows: new PlanUnreachableError("plan/begin", "ECONNREFUSED"),
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);

    expect(h.reports).toEqual([
      {
        triggerId: "trig-1",
        outcome: "infra_error",
        failureReason: expect.stringContaining("ECONNREFUSED"),
      },
    ]);
    expect(h.events).toEqual(["beginPlan", "report:infra_error"]);
    expect(h.completions).toHaveLength(0);
  });

  it("surfaces the reason when /plan/begin is REFUSED, and still runs nothing", async () => {
    const h = harness(undefined, undefined, {
      beginThrows: new PlanProtocolError("plan/begin", "trigger_failed", 409),
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);

    expect(h.reports[0].failureReason).toContain("trigger_failed");
    expect(h.events).not.toContain("resolveAndStart");
  });

  it("reports a failed eval LAUNCH as an eval attempt, never as `evals_failed`", async () => {
    const h = harness({
      runEvalSuite: async () => {
        throw new Error("prepareEvalRun blew up");
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);

    expect(h.attempts).toEqual([
      expect.objectContaining({
        candidateId: "c1",
        phase: "eval",
        ok: false,
        failureKind: "sandbox_error",
      }),
    ]);
    expect(h.completions).toHaveLength(1);
  });

  it("posts NO second attempt once the run is already bound", async () => {
    // After the `eval` attempt the plan is terminal: another attempt is a 409,
    // and the verdict comes from the bound run — an unfinished one derives
    // `infra_error`, never a pass.
    const h = harness({
      runEvalSuite: async (args) => {
        await args.onRunStarted?.("run-3");
        throw new Error("the runner died mid-suite");
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);

    expect(h.attempts.map((a) => `${a.phase}:${a.ok}`)).toEqual(["eval:true"]);
    expect(h.completions).toHaveLength(1);
  });

  const evalDies = {
    runEvalSuite: async (args: {
      onRunStarted?: (id: string) => Promise<void>;
    }) => {
      await args.onRunStarted?.("run-1");
      throw new Error("fetch failed: ECONNREFUSED");
    },
  };

  it("says so in the check output when the PR's server stopped accepting connections", async () => {
    // The server passed the health probe and then died. Asked from inside the
    // box, the connection is refused — so this is the PR's server, not a network
    // path of ours, and the author is told exactly that. It is DISPLAY text now:
    // the verdict comes from the bound run, and the worker has no channel to
    // assert `server_unhealthy` after the eval attempt landed.
    const h = harness(evalDies, "MCPJAM_CHECK_PORT_CLOSED\n");
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.completions[0].detailsMarkdown).toContain("ECONNREFUSED");
    expect(h.completions[0].detailsMarkdown).toContain("stopped answering");
    expect(h.completions[0]).not.toHaveProperty("outcome");
    expect(h.events).toContain("livenessCheck");
  });

  it("says nothing about the PR when its server still answers", async () => {
    // Same transport-shaped error, but the process is alive. The failure came
    // from somewhere else — ours — so the output must not point at the PR.
    const h = harness(evalDies, "MCPJAM_CHECK_HTTP_ANSWERED 200\n");
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.completions[0].detailsMarkdown ?? "").not.toContain(
      "stopped answering"
    );
  });

  it("names the PR's server when its listener stays bound but answers nothing", async () => {
    // A bound socket proves very little: an event loop that is wedged, deadlocked
    // or thrashing still accepts connections while answering nothing. A
    // TCP-connect-only diagnostic would have called it healthy.
    const h = harness(evalDies, "MCPJAM_CHECK_HTTP_SILENT\n");
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.completions[0].detailsMarkdown).toContain("sent nothing back");
  });

  it("names the PR's server when it answers the liveness request with a 5xx", async () => {
    // Running but not serving: a 500 is the server failing on its own terms, and
    // the eval transport would fail on it too.
    const h = harness(evalDies, "MCPJAM_CHECK_HTTP_ANSWERED 500\n");
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.completions[0].detailsMarkdown).toContain("stopped answering");
  });

  it("stays silent when the liveness request draws a 4xx", async () => {
    // The liveness request is a simplified, legacy-shaped `initialize` without the
    // modern `_meta` envelope headers the real client sends, so a modern-only server
    // can reject it correctly while still being drivable by the eval run. A 4xx is
    // therefore evidence about OUR request, not about the PR's server.
    const h = harness(evalDies, "MCPJAM_CHECK_HTTP_ANSWERED 400\n");
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.completions[0].detailsMarkdown ?? "").not.toContain(
      "stopped answering"
    );
  });

  it("stays silent when the sandbox command channel has gone away", async () => {
    // The box no longer answers, so we cannot tell whose fault the eval failure
    // was — and an E2B outage is ours. Ambiguity must never point at the PR.
    const h = harness(evalDies, "throws");
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.completions[0].detailsMarkdown ?? "").not.toContain(
      "stopped answering"
    );
  });

  it("stays silent when the liveness check answers with neither sentinel", async () => {
    // A connect that timed out, or a node that printed nothing. Silence is not
    // evidence against the PR.
    const h = harness(evalDies, "");
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.completions[0].detailsMarkdown ?? "").not.toContain(
      "stopped answering"
    );
  });

  it("abandons the check when the lease is lost during a SUCCESSFUL eval", async () => {
    // The eval is the widest window in the flow, and it can lose the lease and still
    // resolve normally — in which case the failure path's re-check is never reached.
    // Reporting a verdict over a check the backend already concluded is exactly what
    // the lease guard exists to prevent.
    let inEval = false;
    const h = harness({
      runEvalSuite: async () => {
        inEval = true;
        // Let the 1ms heartbeat fire and register the loss mid-eval.
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { runId: "run-1", result: "passed" };
      },
      heartbeat: async () => {
        if (inEval) throw new LeaseLostError("taken over");
      },
      heartbeatIntervalMs: 1,
    });

    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    // Abandoned rather than completed, and the box is still torn down.
    expect(h.completions).toHaveLength(0);
    expect(h.reports).toHaveLength(0);
    expect(h.events).toContain("killSandbox");
  });

  it("abandons the check when the lease is lost during the liveness diagnostic", async () => {
    // The diagnostic talks to the box, so it takes real time — and the lease can be
    // taken away inside that window, AFTER the last step boundary checked it.
    // Reporting `server_unhealthy` for a claim somebody else has already concluded
    // is what the lease guard exists to prevent, so the re-check has to happen
    // after the diagnostic and not only before the eval.
    let inDiagnostic = false;
    const h = harness(
      {
        runEvalSuite: async () => {
          throw new Error("fetch failed: ECONNREFUSED");
        },
        heartbeat: async () => {
          // Only once the diagnostic is under way, so the earlier boundaries pass.
          if (inDiagnostic) throw new LeaseLostError("taken over");
        },
        heartbeatIntervalMs: 1,
      },
      "MCPJAM_CHECK_PORT_CLOSED\n"
    );
    const inner = h.sandbox.commands.run;
    h.sandbox.commands.run = async (command: string, opts?: unknown) => {
      if (command.includes("MCPJAM_CHECK_HTTP_ANSWERED")) {
        inDiagnostic = true;
        // Let the 1ms heartbeat fire and register the loss mid-diagnostic.
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return inner.call(h.sandbox.commands, command, opts as never);
    };

    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    // Abandoned, not completed — and the box is still torn down.
    expect(h.completions).toHaveLength(0);
    expect(h.events).toContain("killSandbox");
  });

  it("checks liveness over the command RPC, never the public URL", async () => {
    // The load-bearing property: a fetch to `getHost(port)` traverses E2B ingress,
    // DNS and TLS, and reports every one of those outages exactly like a dead
    // server. Attribution must not rest on that path, so the probe runs in-box
    // against loopback.
    const commands: string[] = [];
    const h = harness(evalDies, "MCPJAM_CHECK_PORT_CLOSED\n");
    const inner = h.sandbox.commands.run;
    h.sandbox.commands.run = async (command: string, opts?: unknown) => {
      commands.push(command);
      return inner.call(h.sandbox.commands, command, opts as never);
    };
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    const liveness = commands.find((c) =>
      c.includes("MCPJAM_CHECK_HTTP_ANSWERED")
    );
    expect(liveness).toBeDefined();
    expect(liveness).toContain("127.0.0.1");
    expect(liveness).toContain(String(RECIPE.port));
    expect(liveness).not.toContain("e2b.app");
  });

  it("completes — never with an eval verdict — when the org is out of credits", async () => {
    const h = harness({
      runEvalSuite: async () => {
        throw new Error("billing_limit_reached: eval iterations");
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    // An MCPJam-side limit is ours; it reaches the check as an infrastructure
    // attempt and the backend concludes it neutral.
    expect(h.attempts.at(-1)).toMatchObject({
      phase: "eval",
      ok: false,
      failureKind: "sandbox_error",
    });
    expect(h.completions).toHaveLength(1);
  });

  it("completes when the delegated token cannot be minted", async () => {
    const h = harness({
      getBearer: async () => {
        throw new Error("Delegated token exchange failed (403)");
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.completions).toHaveLength(1);
    // No server row was created, so nothing to delete…
    expect(h.events.some((e) => e.startsWith("deleteServer"))).toBe(false);
    // …but the sandbox was already provisioned, and a leaked box costs money.
    expect(h.events).toContain("killSandbox");
  });

  it("still completes and cleans up when the clone drifts from the claimed sha", async () => {
    const h = harness({
      resolveAndStart: async () => {
        throw new CheckStepError("infra_error", "checkout drifted");
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.completions).toHaveLength(1);
    expect(h.events).toContain("killSandbox");
  });
});

describe("executeClaimedCheck — cleanup and heartbeat", () => {
  it("deletes the ephemeral server row and kills the box even when the run throws", async () => {
    const h = harness({
      runEvalSuite: async () => {
        throw new Error("runner exploded");
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.events).toContain("deleteServer:server-1");
    expect(h.events).toContain("killSandbox");
  });

  it("kills the box even if deleting the server row fails", async () => {
    const h = harness({
      deleteEphemeralServer: async () => {
        throw new Error("convex down");
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    // A cleanup failure that costs money (a live sandbox) must not be skipped
    // because a cheaper one (a soft-deletable row) failed first.
    expect(h.events).toContain("killSandbox");
    expect(h.completions[0].runId).toBe("run-1");
  });

  it("does not fail the check when recording the ephemeral server fails", async () => {
    const h = harness({
      recordServer: async () => {
        throw new Error("route 500");
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    // Recovery loses its cleanup pointer, but the PR still gets its verdict.
    expect(h.completions[0].runId).toBe("run-1");
  });

  it("never throws, even when completing itself fails", async () => {
    const h = harness({
      runEvalSuite: async () => {
        throw new Error("boom");
      },
    });
    const session = await h.deps.beginPlan!({} as ClaimedGithubCheck);
    // A completion that cannot be delivered is logged, not thrown: the poll loop
    // would read a throw as a transport failure and back off, while the
    // backend's heartbeat sweep concludes the check anyway.
    (session as { complete: unknown }).complete = async () => {
      throw new Error("convex unreachable");
    };
    h.deps.beginPlan = async () => session;
    await expect(
      executeClaimedCheck(CLAIM, "worker-1", h.deps)
    ).resolves.toBeUndefined();
  });

  it("heartbeats while the check runs and stops the moment it settles", async () => {
    vi.useFakeTimers();
    try {
      let releaseRun: () => void = () => {};
      const runGate = new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      const h = harness({
        runEvalSuite: async () => {
          await runGate;
          return { runId: "run-1", result: "passed" };
        },
        heartbeatIntervalMs: 1_000,
      });

      const pending = executeClaimedCheck(CLAIM, "worker-1", h.deps);
      await vi.advanceTimersByTimeAsync(3_500);
      expect(h.heartbeats.length).toBeGreaterThanOrEqual(3);

      releaseRun();
      await pending;

      const afterSettle = h.heartbeats.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(h.heartbeats.length).toBe(afterSettle);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a rejected heartbeat instead of counting it as a success", async () => {
    // The route answering 401/409/500 must not look like a refreshed lease: the
    // backend's sweep would take the check away while this worker still runs it.
    const rejections: unknown[] = [];
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
    // Cleaned up explicitly: this describe block has no env/global teardown, and
    // a leaked `fetch` stub makes an unrelated later test fail confusingly.
    onTestFinished(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          })
      )
    );
    const { sendHeartbeatForTests } = await import("../github-checks-worker");
    await sendHeartbeatForTests("trig-1", "worker-1").catch((error) =>
      rejections.push(error)
    );
    expect(rejections).toHaveLength(1);
    expect(String(rejections[0])).toMatch(/heartbeat rejected \(401\)/);
  });

  it("keeps going when a heartbeat request fails", async () => {
    vi.useFakeTimers();
    try {
      let releaseRun: () => void = () => {};
      const runGate = new Promise<void>((resolve) => {
        releaseRun = resolve;
      });
      const h = harness({
        heartbeat: async () => {
          throw new Error("convex 502");
        },
        runEvalSuite: async () => {
          await runGate;
          return { runId: "run-1", result: "passed" };
        },
      });
      const pending = executeClaimedCheck(CLAIM, "worker-1", h.deps);
      await vi.advanceTimersByTimeAsync(3_000);
      releaseRun();
      await expect(pending).resolves.toBeUndefined();
      expect(h.completions[0].runId).toBe("run-1");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("describeCheckFailure", () => {
  it("names no outcome at all — that is the backend's now", () => {
    const described = describeCheckFailure(
      new CheckStepError("build_failed", "exit 1", "```text\nlog\n```")
    );
    expect(described).not.toHaveProperty("outcome");
    expect(described.failureReason).toBe("exit 1");
    expect(described.detailsMarkdown).toContain("log");
  });

  it("passes a plan stop's author-facing copy through unfenced", () => {
    // Our prose, not clamped PR output: re-clamping would wrap a markdown block
    // — headings, a yaml example — in a `text` fence and render it as source.
    const described = describeCheckFailure(
      new CheckStoppedByPlan("recipe_invalid", "# Your mcpjam.yaml", true)
    );
    expect(described).toMatchObject({
      failureReason: "recipe_invalid",
      detailsPreformatted: true,
    });
  });

  it("names only the canonical billing marker, never a loose substring", () => {
    expect(
      describeCheckFailure(new Error("billing_limit_reached: iterations"))
    ).toMatchObject({ failureReason: "billing_limit_reached" });
    // An MCP server error that merely mentions billing must not be relabelled.
    expect(
      describeCheckFailure(new Error("tool failed: check your billing page"))
    ).toMatchObject({
      failureReason: "tool failed: check your billing page",
    });
  });

  it("bounds the failure reason", () => {
    expect(
      describeCheckFailure(new Error("x".repeat(1_000))).failureReason.length
    ).toBe(200);
  });
});

/**
 * B10e — a run HELD for its gating judge.
 *
 * The property this whole section buys: a gating run is NEVER neutral while
 * its judge is still within its deadline, and NEVER red without a verdict.
 * The first half is `awaitJudgeVerdict` waiting; the second half is
 * `runReachedAVerdict` refusing `grading`, which is what makes a wait that
 * runs out land `infra_error` rather than a red X on a PR nobody graded.
 */
describe("a run held for its gating judge", () => {
  it("is not a verdict, and has no effective result", () => {
    // Unchanged, and that is the assertion. Only `completed` carries a
    // verdict; a held run's `result` is the backend's `pending`, and calling
    // it decided would put a red X on a PR whose judge has not answered.
    expect(runReachedAVerdict("grading")).toBe(false);
    expect(effectiveRunResult({ status: "grading" })).toBeUndefined();
  });

  describe("awaitJudgeVerdict", () => {
    function client(rows: Array<Record<string, unknown> | Error>) {
      let call = 0;
      const query = vi.fn(async () => {
        const row = rows[Math.min(call, rows.length - 1)];
        call += 1;
        if (row instanceof Error) throw row;
        return row;
      });
      return { query };
    }

    function clock() {
      let time = 0;
      const sleeps: number[] = [];
      return {
        now: () => time,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          time += ms;
        },
        sleeps,
      };
    }

    it("polls until the run leaves grading, then returns it", async () => {
      const c = client([
        { status: "grading" },
        { status: "grading" },
        { status: "completed", result: "passed" },
      ]);
      const time = clock();
      const run = await awaitJudgeVerdict(c, "run-1", {
        waitMs: 60_000,
        pollMs: 1_000,
        now: time.now,
        sleep: time.sleep,
      });
      expect(run).toMatchObject({ status: "completed", result: "passed" });
      expect(c.query).toHaveBeenCalledTimes(3);
      expect(time.sleeps).toEqual([1_000, 1_000]);
    });

    it("returns the held row when the wait runs out — it decides nothing", async () => {
      const c = client([{ status: "grading" }]);
      const time = clock();
      const run = await awaitJudgeVerdict(c, "run-1", {
        waitMs: 2_000,
        pollMs: 1_000,
        now: time.now,
        sleep: time.sleep,
      });
      // Still `grading`, which `runReachedAVerdict` refuses — so the caller
      // throws and the check lands neutral rather than red.
      expect(run).toMatchObject({ status: "grading" });
      expect(runReachedAVerdict(run?.status)).toBe(false);
    });

    it("stops the moment the claim stops being ours", async () => {
      const c = client([{ status: "grading" }]);
      const time = clock();
      const run = await awaitJudgeVerdict(c, "run-1", {
        waitMs: 60_000,
        pollMs: 1_000,
        now: time.now,
        sleep: time.sleep,
        isLeaseHeld: () => false,
      });
      expect(run).toMatchObject({ status: "grading" });
      // One read, no waiting: there is no point spending half an hour on a
      // check somebody else has already concluded.
      expect(c.query).toHaveBeenCalledTimes(1);
      expect(time.sleeps).toEqual([]);
    });

    it("does not poll a run that was never held", async () => {
      const c = client([{ status: "completed", result: "passed" }]);
      const time = clock();
      await awaitJudgeVerdict(c, "run-1", {
        waitMs: 60_000,
        pollMs: 1_000,
        now: time.now,
        sleep: time.sleep,
      });
      expect(c.query).toHaveBeenCalledTimes(1);
      expect(time.sleeps).toEqual([]);
    });

    it("retries a read that throws rather than concluding from it", async () => {
      // A transient Convex blip during a 31-minute wait is not evidence about
      // the run.
      const c = client([
        { status: "grading" },
        new Error("convex unavailable"),
        { status: "completed", result: "failed" },
      ]);
      const time = clock();
      const run = await awaitJudgeVerdict(c, "run-1", {
        waitMs: 60_000,
        pollMs: 1_000,
        now: time.now,
        sleep: time.sleep,
      });
      expect(run).toMatchObject({ status: "completed", result: "failed" });
    });
  });
});

describe("effectiveRunResult", () => {
  // Every fixture here carries `passRate` in the shape the runner ACTUALLY
  // persists — a 0-1 fraction (`passed / total`) — because the threshold it is
  // compared against is a 0-100 percentage. A fixture written as a percentage
  // would let the unit bug back in unnoticed.
  it("derives the verdict for a completed run whose record omits `result`", () => {
    // The recorder finalizes with `status: "completed"` and a summary but does
    // not always populate `result`. Reading `result` alone puts a red X on a PR
    // that passed every single test.
    const perfect = {
      status: "completed",
      summary: { total: 4, passed: 4, failed: 0, passRate: 1 },
    };
    expect(effectiveRunResult(perfect)).toBe("passed");
  });

  it("compares a PERCENTAGE against the threshold, not the stored fraction", () => {
    // The regression this pins: `summary.passRate` is `passed / total`, so a
    // perfect run stores 1. Comparing that to `minimumPassRate` (0-100) fails
    // every run, including one that passed everything — the exact false failure
    // the derivation exists to prevent.
    expect(
      effectiveRunResult({
        status: "completed",
        summary: { total: 2, passed: 2, failed: 0, passRate: 1 },
        passCriteria: { minimumPassRate: 100 },
      })
    ).toBe("passed");
    // And a stored rate that disagrees with the counts does not get a vote.
    expect(
      effectiveRunResult({
        status: "completed",
        summary: { total: 4, passed: 1, failed: 3, passRate: 99 },
        passCriteria: { minimumPassRate: 90 },
      })
    ).toBe("failed");
  });

  it("honors the suite's own pass criteria", () => {
    const summary = { total: 10, passed: 8, failed: 2, passRate: 0.8 };
    expect(
      effectiveRunResult({
        status: "completed",
        summary,
        passCriteria: { minimumPassRate: 80 },
      })
    ).toBe("passed");
    expect(
      effectiveRunResult({
        status: "completed",
        summary,
        passCriteria: { minimumPassRate: 90 },
      })
    ).toBe("failed");
    // No criteria ⇒ 100% required, matching the client's derivation.
    expect(effectiveRunResult({ status: "completed", summary })).toBe("failed");
  });

  it("prefers an explicit result over anything derived", () => {
    expect(
      effectiveRunResult({
        status: "completed",
        result: "failed",
        summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
      })
    ).toBe("failed");
  });

  it("reports an INCONCLUSIVE verdict verbatim instead of recomputing it", () => {
    // Verdict policy 2's third result. The counts here would derive "passed"
    // (2/2 at the default 100% bar), which is precisely the claim the platform
    // declined to make: too little of the run was gradeable. The worker reports
    // facts and the control plane maps `inconclusive` to a NEUTRAL check, so
    // re-deriving it here is how an undecided run turns into a green check.
    expect(
      effectiveRunResult({
        status: "completed",
        result: "inconclusive",
        summary: { total: 2, passed: 2, failed: 0, passRate: 1 },
      })
    ).toBe("inconclusive");
    // And it stays a verdict-bearing run: `inconclusive` is a result, not an
    // abandoned run, so the worker does not raise "did not complete".
    expect(runReachedAVerdict("completed")).toBe(true);
  });

  it("never invents a pass when there is nothing to derive from", () => {
    expect(effectiveRunResult({ status: "completed" })).toBeUndefined();
    expect(effectiveRunResult(null)).toBeUndefined();
    expect(effectiveRunResult({ status: "running" })).toBeUndefined();
    expect(effectiveRunResult({ status: "timed_out" })).toBe("timed_out");
    expect(effectiveRunResult({ status: "cancelled" })).toBe("cancelled");
    expect(effectiveRunResult({ status: "failed" })).toBe("failed");
  });
});

describe("startGithubChecksWorker loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    // A SEPARATE variable from the one above, read much later (when the ephemeral
    // server is created) and therefore also part of the startup gate.
    vi.stubEnv("CONVEX_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
    // The sandbox configuration is part of the startup gate: without it the
    // worker refuses to poll (see the test at the end of this block).
    vi.stubEnv("E2B_API_KEY", "e2b_test");
    vi.stubEnv("GITHUB_CHECKS_E2B_TEMPLATE_ID", "tmpl_test");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  async function flush(times = 6) {
    for (let i = 0; i < times; i += 1) {
      await vi.advanceTimersByTimeAsync(20_000);
    }
  }

  it("executes one claim at a time and keeps polling", async () => {
    const claim = vi.fn().mockResolvedValueOnce(CLAIM).mockResolvedValue(null);
    const execute = vi.fn().mockResolvedValue(undefined);

    const handle = startGithubChecksWorker({ claim, execute });
    await flush();
    await handle.stop();

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toEqual(CLAIM);
    // The claimedBy identity is threaded through so heartbeats match the claim.
    expect(execute.mock.calls[0][1]).toEqual(claim.mock.calls[0][0]);
    expect(claim.mock.calls.length).toBeGreaterThan(1);
  });

  it("stops promptly when the abort lands while a claim is in flight", async () => {
    // The loop only tests `aborted` at the top, so a claim that settles AFTER
    // `stop()` falls through to the backoff sleep with an already-aborted signal.
    // An `abort` event that has already fired never fires again, so a listener
    // registered at that point waits out the full 60s backoff and the caller's
    // shutdown timer force-exits an otherwise idle worker.
    vi.useRealTimers();
    let releaseClaim: (value: null) => void = () => {};
    const claim = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseClaim = resolve;
        })
    );
    const handle = startGithubChecksWorker({ claim, execute: vi.fn() });
    // Wait until the loop is parked inside claim().
    while (claim.mock.calls.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const stopped = handle.stop();
    // Settle the claim after the abort, which is the race under test.
    releaseClaim(null);

    const outcome = await Promise.race([
      stopped.then(() => "stopped" as const),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 500)),
    ]);
    expect(outcome).toBe("stopped");
  });

  it("backs off without executing when the backend reports the feature disabled", async () => {
    const claim = vi.fn().mockResolvedValue("disabled" as const);
    const execute = vi.fn();
    const handle = startGithubChecksWorker({ claim, execute });
    await flush(3);
    await handle.stop();
    expect(execute).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalled();
  });

  it("refuses to poll when CONVEX_URL is missing", async () => {
    // `CONVEX_URL` is only read when the ephemeral server is created — after the
    // box is provisioned and the PR is built. Claiming without it would spend ten
    // minutes on a trigger and then conclude `infra_error`, permanently, since a
    // verdict is final. Not polling leaves the check claimable until the deploy is
    // fixed, which is the same reasoning as the sandbox gate.
    vi.stubEnv("CONVEX_URL", "");
    const claim = vi.fn().mockResolvedValue(null);

    const worker = startGithubChecksWorker({ claim, claimedBy: "worker-1" });
    onTestFinished(async () => {
      await worker.stop();
    });
    await flush();
    expect(claim).not.toHaveBeenCalled();
  });

  it("refuses to poll when the sandbox is not configured", async () => {
    // Claiming without E2B is worse than not starting: every queued trigger would
    // be claimed, fail to provision, and be concluded `infra_error` — and a
    // verdict is final. Not polling leaves them claimable until the deploy is fixed.
    vi.stubEnv("E2B_API_KEY", "");
    vi.stubEnv("GITHUB_CHECKS_E2B_TEMPLATE_ID", "");
    const claim = vi.fn().mockResolvedValue(null);

    const worker = startGithubChecksWorker({ claim, claimedBy: "worker-1" });
    onTestFinished(async () => {
      await worker.stop();
    });
    await flush();

    expect(claim).not.toHaveBeenCalled();
  });

  it("survives claim errors instead of crashing the loop", async () => {
    const claim = vi
      .fn()
      .mockRejectedValueOnce(new Error("backend down"))
      .mockResolvedValue(null);
    const handle = startGithubChecksWorker({ claim, execute: vi.fn() });
    await flush(8);
    await handle.stop();
    expect(claim.mock.calls.length).toBeGreaterThan(1);
  });

  it("stop() ends the loop", async () => {
    const claim = vi.fn().mockResolvedValue(null);
    const handle = startGithubChecksWorker({ claim, execute: vi.fn() });
    await flush(2);
    const stopped = handle.stop();
    await vi.advanceTimersByTimeAsync(1);
    await stopped;
    const callsAtStop = claim.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(claim.mock.calls.length).toBe(callsAtStop);
  });

  it("does not start without the service credentials", async () => {
    vi.unstubAllEnvs();
    const claim = vi.fn();
    const handle = startGithubChecksWorker({ claim, execute: vi.fn() });
    await flush(2);
    await handle.stop();
    expect(claim).not.toHaveBeenCalled();
  });
});

describe("verifyRunSnapshot", () => {
  // The dedicated suite is shared and `refreshSnapshot` rewrites its environment
  // before the run freezes it, so two concurrent checks can interleave and one can
  // end up evaluating the other's server. This cannot prevent that; it decides when
  // the theft is PROVEN, and when we simply could not look — a verdict about
  // somebody else's PR being worse than no verdict.
  const clientWith = (snapshot: unknown) =>
    ({
      query: async () => ({ configSnapshot: { environment: snapshot } }),
    } as unknown as Parameters<typeof verifyRunSnapshot>[0]);

  it("passes a snapshot naming our own check", async () => {
    const snapshot = {
      servers: ["srv_1"],
      serverBindings: [{ name: "gh-check-trig-1", id: "srv_1" }],
    };
    expect(
      await verifyRunSnapshot(clientWith(snapshot), "run-1", "trig-1")
    ).toBe("ours");
  });

  it("catches a snapshot naming a different check", async () => {
    const snapshot = {
      servers: ["srv_2"],
      serverBindings: [{ name: "gh-check-trig-9", id: "srv_2" }],
    };
    expect(
      await verifyRunSnapshot(clientWith(snapshot), "run-1", "trig-1")
    ).toBe("stolen");
  });

  it("passes when ours appears alongside another", async () => {
    // A display list can carry stale entries; ours being present is what matters.
    const snapshot = {
      serverBindings: [
        { name: "gh-check-trig-9", id: "srv_2" },
        { name: "gh-check-trig-1", id: "srv_1" },
      ],
    };
    expect(
      await verifyRunSnapshot(clientWith(snapshot), "run-1", "trig-1")
    ).toBe("ours");
  });

  it("proceeds on a snapshot naming no check server", async () => {
    // The snapshot's shape is the backend's contract, not this module's, so an
    // unrecognised one must not fail every check.
    expect(
      await verifyRunSnapshot(
        clientWith({ servers: ["srv_manual"] }),
        "run-1",
        "trig-1"
      )
    ).toBe("ours");
    expect(
      await verifyRunSnapshot(clientWith(undefined), "run-1", "trig-1")
    ).toBe("ours");
  });

  it("refuses to proceed when the snapshot cannot be read at all", async () => {
    // Being unable to LOOK is different from looking and finding nothing: it removes
    // the only guard against publishing a verdict about another PR's server. The
    // caller turns this into a neutral check.
    const broken = {
      query: async () => {
        throw new Error("convex down");
      },
    } as unknown as Parameters<typeof verifyRunSnapshot>[0];
    expect(await verifyRunSnapshot(broken, "run-1", "trig-1")).toBe(
      "unverifiable"
    );
  });
});

describe("runReachedAVerdict", () => {
  it("trusts only a completed run", async () => {
    expect(runReachedAVerdict("completed")).toBe(true);
    // Each of these means the machinery stopped, not that the PR failed — and
    // `timed_out`/`cancelled` reach the verdict path WITHOUT a throw, because a
    // lifecycle stop is finalized and returned normally. Letting one through
    // would hand the backend a run whose assertions were never judged.
    for (const status of [
      "timed_out",
      "cancelled",
      "failed",
      "running",
      undefined,
    ]) {
      expect(runReachedAVerdict(status)).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PRIVATE REPOSITORIES
// ═══════════════════════════════════════════════════════════════════════════
//
// The ordering is the load-bearing part and the reason these live here rather
// than in the resolver's suite: the credential is minted AFTER the plan exists
// and BEFORE a box is provisioned, so a mint failure is an ordinary attempt on
// an existing plan instead of a second planless completion, and costs no E2B
// box. Everything else below is about the credential not escaping.

describe("executeClaimedCheck — the private-repository clone credential", () => {
  /** Computed independently of the module under test. */
  const basic = Buffer.from(`x-access-token:${CLONE_TOKEN}`, "utf8").toString(
    "base64"
  );
  const credentialForms = [CLONE_TOKEN, basic, `AUTHORIZATION: basic ${basic}`];

  it("mints AFTER the plan and BEFORE the first sandbox, then threads it to the clone", async () => {
    const h = harness();
    await executeClaimedCheck(PRIVATE_CLAIM, "worker-1", h.deps);

    // `beginPlan` → `mintCloneToken` → `resolveAndStart`, in that order and no
    // other. `resolveAndStart` owns provisioning, so its position IS the
    // "before any box" guarantee.
    expect(h.events.slice(0, 3)).toEqual([
      "beginPlan",
      "mintCloneToken",
      "resolveAndStart",
    ]);
    expect(h.resolveArgs[0].cloneToken).toBe(CLONE_TOKEN);
    // The ordinary check still happened, end to end.
    expect(h.completions).toHaveLength(1);
    expect(h.reports).toHaveLength(0);
  });

  it("never asks for a credential for a public repository", async () => {
    // Not an optimization: minting a `contents: read` token nothing needs is
    // blast radius bought for nothing.
    const h = harness();
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);

    expect(h.events).not.toContain("mintCloneToken");
    expect(h.resolveArgs[0]).not.toHaveProperty("cloneToken");
  });

  it("completes with a ladder `clone_failed` when the mint fails, and provisions nothing", async () => {
    // A 502 from the mint route. There is a plan, so this is reported THROUGH
    // it — the planless completion is only for a check that never got one.
    const h = harness({
      mintCloneToken: async () => {
        throw new CloneTokenUnavailableError(
          "the backend could not mint a clone token (502)"
        );
      },
    });
    await executeClaimedCheck(PRIVATE_CLAIM, "worker-1", h.deps);

    expect(h.events).not.toContain("resolveAndStart");
    expect(h.completions).toHaveLength(1);
    expect(h.completions[0].terminalAttempt).toMatchObject({
      // LADDER-scoped: no candidate exists, because nothing was detected yet.
      phase: "clone",
      ok: false,
      failureKind: "clone_failed",
    });
    expect(h.completions[0].terminalAttempt).not.toHaveProperty("candidateId");
    // No outcome named here either — a ladder `clone_failed` is `infra_error`
    // backend-side, and it is never the pull request's fault.
    expect(h.completions[0]).not.toHaveProperty("outcome");
    expect(h.reports).toHaveLength(0);
  });

  it("never completes the fresh plan with an empty attempt log", async () => {
    // The consequence the typed transport failure exists to prevent. An untyped
    // throw from the mint reaches the generic catch, which has no degraded
    // marker for it either — so `/complete` would carry no `terminalAttempt`
    // and the backend would derive an outcome from nothing at all.
    const h = harness({
      mintCloneToken: async () => {
        throw new Error("service route /clone-token timed out after 15000ms");
      },
    });
    await executeClaimedCheck(PRIVATE_CLAIM, "worker-1", h.deps);

    expect(h.events).not.toContain("resolveAndStart");
    expect(h.completions).toHaveLength(1);
    expect(h.completions[0].terminalAttempt).toMatchObject({
      phase: "clone",
      ok: false,
      failureKind: "clone_failed",
    });
  });

  it("treats a null token for a private repository exactly like a failed mint", async () => {
    // `cloneToken: null` is the PUBLIC answer. Arriving for a private claim it
    // means the same thing a 502 does — we cannot clone — so an anonymous
    // attempt that would 404 and read as "the repository vanished" is refused.
    const h = harness({ mintCloneToken: async () => null });
    await executeClaimedCheck(PRIVATE_CLAIM, "worker-1", h.deps);

    expect(h.events).not.toContain("resolveAndStart");
    expect(h.completions).toHaveLength(1);
    expect(h.completions[0].terminalAttempt).toMatchObject({
      phase: "clone",
      ok: false,
      failureKind: "clone_failed",
    });
  });

  it("abandons the check on a 409 from the mint, with no competing completion", async () => {
    // 409 means somebody else holds the claim, which means the backend has
    // already concluded this check. A completion posted over the top would be
    // rejected at best and a competing verdict at worst.
    const h = harness({
      mintCloneToken: async () => {
        throw new LeaseLostError("trigger_completed");
      },
    });
    await executeClaimedCheck(PRIVATE_CLAIM, "worker-1", h.deps);

    expect(h.completions).toHaveLength(0);
    expect(h.reports).toHaveLength(0);
    expect(h.events).not.toContain("resolveAndStart");
    // The box that was never provisioned is still "killed" (a null handle), so
    // the cleanup path is uniform.
    expect(h.events).toContain("killSandbox");
  });

  /** Capture every `logger.error` call, argument objects included. */
  async function captureErrorLogs(): Promise<unknown[]> {
    const logger = await import("../../utils/logger");
    const logged: unknown[] = [];
    const spy = vi
      .spyOn(logger.logger, "error")
      .mockImplementation((message, error, context) => {
        logged.push([
          message,
          error instanceof Error ? `${error.message}\n${error.stack}` : error,
          context,
        ]);
      });
    onTestFinished(() => spy.mockRestore());
    return logged;
  }

  it("leaks no credential form through the failure, the log, the attempt or the completion", async () => {
    // THE LEAK TEST. `sandbox.commands.run` throwing an error that quotes the
    // WHOLE command is exactly what an E2B transport failure looks like, and the
    // command it quotes is the one carrying the auth header. `sandbox.ts`
    // redacts it at the boundary it owns; this asserts the worker's own
    // observables — the log (Sentry's only capture path), the terminal attempt
    // and the completion — are clean even if that first boundary ever fails.
    const logged = await captureErrorLogs();
    const echoedCommand = `bash -lc 'git -c 'http.extraheader=AUTHORIZATION: basic ${basic}' clone --depth 50' (raw ${CLONE_TOKEN})`;
    const h = harness({
      resolveAndStart: async () => {
        throw new CheckStepError(
          "infra_error",
          `sandbox command failed: ${echoedCommand}`,
          `\`\`\`text\n${echoedCommand}\n\`\`\``
        );
      },
    });
    await executeClaimedCheck(PRIVATE_CLAIM, "worker-1", h.deps);

    const observable = JSON.stringify({
      logged,
      completions: h.completions,
      attempts: h.attempts,
      reports: h.reports,
    });
    for (const form of credentialForms) {
      expect(observable).not.toContain(form);
    }
    // The check still got its one completion, and the failure is still legible.
    expect(h.completions).toHaveLength(1);
    expect(h.completions[0].detailsMarkdown).toContain("[redacted]");
    expect(JSON.stringify(logged)).toContain("sandbox command failed");
  });

  it("leaks no credential form when the MINT itself fails", async () => {
    // The worker holds no token on this path — the mint is what failed — so the
    // constant `AUTHORIZATION:` sweep is the whole defence, and it has to be
    // enough on its own.
    const logged = await captureErrorLogs();
    const h = harness({
      mintCloneToken: async () => {
        throw new CloneTokenUnavailableError(
          `mint failed while sending AUTHORIZATION: basic ${basic}`
        );
      },
    });
    await executeClaimedCheck(PRIVATE_CLAIM, "worker-1", h.deps);

    const observable = JSON.stringify({ logged, completions: h.completions });
    expect(observable).not.toContain(basic);
    expect(observable).not.toContain(`AUTHORIZATION: basic ${basic}`);
    // Redacted, not swallowed: the operator still gets a legible failure.
    expect(h.completions[0].terminalAttempt?.detailsClamped).toContain(
      "mint failed"
    );
    expect(h.completions[0].terminalAttempt?.detailsClamped).toContain(
      "[redacted]"
    );
    expect(h.completions[0].detailsMarkdown).toContain(
      "not a problem with the pull request"
    );
  });
});

describe("the clone-token wire contract", () => {
  // Hand-mirrored from the backend across two repos, so the status mapping is
  // pinned at the wire rather than only at the dep seam.
  function stubFetch(status: number, body: unknown) {
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    onTestFinished(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });
    return fetchMock;
  }

  it("posts { triggerId, claimedBy } and returns the token", async () => {
    const fetchMock = stubFetch(200, {
      ok: true,
      cloneToken: CLONE_TOKEN,
      expiresAt: 1_700_000_000,
    });
    await expect(mintCloneTokenForTests("trig-1", "worker-1")).resolves.toBe(
      CLONE_TOKEN
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit
    ];
    expect(url).toContain("/internal/v1/github-checks/clone-token");
    expect(JSON.parse(String(init.body))).toEqual({
      triggerId: "trig-1",
      claimedBy: "worker-1",
    });
  });

  it("answers null when the backend says no token was needed", async () => {
    stubFetch(200, { ok: true, cloneToken: null });
    await expect(
      mintCloneTokenForTests("trig-1", "worker-1")
    ).resolves.toBeNull();
  });

  it("maps 409 to lease loss, not to a mint failure", async () => {
    stubFetch(409, { ok: false, error: "trigger_completed" });
    await expect(
      mintCloneTokenForTests("trig-1", "worker-1")
    ).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("maps a transport failure to a mint failure, not an untyped throw", async () => {
    // The route rejecting BEFORE it answers — a network failure, or the
    // service-route's own deadline. Untyped, this would skip the mint-failure
    // branch entirely and complete the plan with no attempt on it at all.
    vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED 10.0.0.1:443");
      })
    );
    onTestFinished(() => {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    });

    const error = await mintCloneTokenForTests("trig-1", "worker-1").catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(CloneTokenUnavailableError);
    expect(String(error)).toContain("ECONNREFUSED");
  });

  it("maps 502 to a mint failure, without echoing the backend's body", async () => {
    stubFetch(502, { ok: false, error: "Could not mint a clone token" });
    const error = await mintCloneTokenForTests("trig-1", "worker-1").catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(CloneTokenUnavailableError);
    expect(String(error)).toContain("502");
  });

  it("mirrors repoPrivate off the claim body", async () => {
    // The field is hand-mirrored across two repos, and dropping it here would
    // silently degrade every private repository to an anonymous clone.
    stubFetch(200, {
      ok: true,
      claimed: { ...PRIVATE_CLAIM, triggerId: "trig-9" },
    });
    const claimed = await claimNextForTests("worker-1");
    expect(claimed).toMatchObject({ triggerId: "trig-9", repoPrivate: true });
  });
});
