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
  classifyCheckFailure,
  effectiveRunResult,
  executeClaimedCheck,
  outcomeForRunResult,
  LeaseLostError,
  startGithubChecksWorker,
  type CheckExecutionDeps,
  type CheckReport,
  type ClaimedGithubCheck,
} from "../github-checks-worker";
import { CheckStepError } from "../github-checks/sandbox";

// Two invariants drive every test here, because both are visible on somebody's
// pull request when they break:
//
//   1. A claimed trigger ALWAYS gets exactly one reported outcome, on every
//      path, and the sandbox is always torn down. An unreported claim shows up
//      as a check that hangs for five minutes and then goes neutral.
//   2. The outcome distinguishes the PR's fault from ours. `build_failed` and
//      `server_unhealthy` are the PR's; `infra_error` is ours. Backwards, and a
//      good PR gets a red X (or a real breakage is hidden).

const CLAIM: ClaimedGithubCheck = {
  triggerId: "trig-1",
  repoFullName: "mcpjam/mcp-check-fixture",
  prNumber: 12,
  headSha: "a".repeat(40),
  organizationId: "org-1",
  projectId: "proj-1",
  createdByExternalId: "user_workos_1",
  suiteId: "suite-1",
};

const RECIPE = {
  build: "npm ci && npm run build",
  start: "npm start",
  port: 3001,
  mcpPath: "/mcp",
};

type Harness = {
  deps: Partial<CheckExecutionDeps>;
  reports: CheckReport[];
  events: string[];
  heartbeats: string[];
};

/**
 * `liveness` scripts what the post-failure in-box liveness check finds: the stdout
 * the node one-liner prints, or "throws" for a box that no longer answers at all.
 * Default is empty stdout — no sentinel, so "could not tell", so neutral.
 */
function harness(
  overrides?: Partial<CheckExecutionDeps>,
  liveness?: string
): Harness {
  const reports: CheckReport[] = [];
  const events: string[] = [];
  const heartbeats: string[] = [];

  const sandbox = {
    sandboxId: "sb_1",
    getHost: (port: number) => `${port}-sb_1.e2b.app`,
    commands: {
      run: async (command: string) => {
        // The post-failure liveness check is the only command this fake sees.
        if (command.includes("MCPJAM_CHECK_PORT_OPEN")) {
          events.push("livenessCheck");
          if (liveness === "throws") throw new Error("sandbox not found");
          return { stdout: liveness ?? "" };
        }
        return {};
      },
    },
    updateNetwork: async () => {},
    kill: async () => {},
  } as unknown as Awaited<ReturnType<CheckExecutionDeps["provisionSandbox"]>>;

  const deps: Partial<CheckExecutionDeps> = {
    resolveRecipe: () => RECIPE,
    provisionSandbox: async () => {
      events.push("provision");
      return sandbox;
    },
    cloneAndCheckout: async () => {
      events.push("clone");
    },
    buildAndStart: async () => {
      events.push("buildAndStart");
      return {
        url: "https://3001-sb_1.e2b.app/mcp",
        readStderrTail: async () => "",
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
    runEvalSuite: async () => {
      events.push("runEvalSuite");
      return {
        runId: "run-1",
        result: "passed",
        summary: { total: 3, passed: 3, failed: 0, passRate: 1 },
      };
    },
    report: async (report) => {
      reports.push(report);
      events.push(`report:${report.outcome}`);
    },
    heartbeat: async (triggerId) => {
      heartbeats.push(triggerId);
    },
    heartbeatIntervalMs: 1_000,
    ...overrides,
  };

  return { deps, reports, events, heartbeats };
}

describe("executeClaimedCheck — happy path", () => {
  it("builds, creates the ephemeral server, runs the suite, reports passed, cleans up", async () => {
    const h = harness();
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);

    expect(h.events).toEqual([
      "provision",
      "clone",
      "buildAndStart",
      "getBearer",
      "createServer:gh-check-trig-1:https://3001-sb_1.e2b.app/mcp",
      "recordServer:trig-1:server-1",
      "runEvalSuite",
      "report:passed",
      "deleteServer:server-1",
      "killSandbox",
    ]);
    expect(h.reports).toEqual([
      {
        triggerId: "trig-1",
        outcome: "passed",
        runId: "run-1",
        summary: { total: 3, passed: 3, failed: 0, passRate: 1 },
      },
    ]);
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

  it("reports evals_failed with the pass counts when the run does not pass", async () => {
    const h = harness({
      runEvalSuite: async () => ({
        runId: "run-2",
        result: "failed",
        summary: { total: 4, passed: 1, failed: 3, passRate: 0.25 },
      }),
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.reports[0]).toMatchObject({
      outcome: "evals_failed",
      runId: "run-2",
      summary: { total: 4, passed: 1, failed: 3 },
    });
  });
});

describe("executeClaimedCheck — failure attribution", () => {
  it("reports recipe_unresolvable and touches no sandbox when there is no recipe", async () => {
    const h = harness({ resolveRecipe: () => null });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);

    expect(h.reports[0]).toMatchObject({ outcome: "recipe_unresolvable" });
    expect(h.events).not.toContain("provision");
  });

  it("reports infra_error when the sandbox cannot be provisioned", async () => {
    const h = harness({
      provisionSandbox: async () => {
        throw new CheckStepError("infra_error", "E2B 503");
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.reports[0]).toMatchObject({
      outcome: "infra_error",
      failureReason: "E2B 503",
    });
    // Nothing to delete, but teardown still runs.
    expect(h.events).toContain("killSandbox");
  });

  it("reports build_failed — the PR's fault — with the clamped log tail", async () => {
    const h = harness({
      buildAndStart: async () => {
        throw new CheckStepError(
          "build_failed",
          "build command exited 1",
          "```text\nnpm ERR! missing script: build\n```"
        );
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);

    expect(h.reports[0].outcome).toBe("build_failed");
    expect(h.reports[0].detailsMarkdown).toContain("missing script: build");
    // Re-clamping our own already-fenced block must not double-fence it.
    expect(h.reports[0].detailsMarkdown).not.toContain("```text\n```text");
    // No eval run was attempted, and the box was killed.
    expect(h.events).not.toContain("runEvalSuite");
    expect(h.events).toContain("killSandbox");
  });

  it("reports server_unhealthy when the built server never speaks MCP", async () => {
    const h = harness({
      buildAndStart: async () => {
        throw new CheckStepError(
          "server_unhealthy",
          "server never completed MCP initialize on port 3001/mcp",
          "```text\nlisten EADDRINUSE 127.0.0.1:3001\n```"
        );
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.reports[0].outcome).toBe("server_unhealthy");
    expect(h.reports[0].detailsMarkdown).toContain("EADDRINUSE");
  });

  const evalDies = {
    runEvalSuite: async () => {
      throw new Error("fetch failed: ECONNREFUSED");
    },
  };

  it("blames the PR when its server stops listening during the eval", async () => {
    // The server passed the health probe and then died. Asked from inside the box,
    // nothing is listening on its port — so this is the PR's server, not a network
    // path of ours, and it must earn `server_unhealthy`.
    const h = harness(evalDies, "MCPJAM_CHECK_PORT_CLOSED\n");
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.reports[0]).toMatchObject({ outcome: "server_unhealthy" });
    expect(h.reports[0].detailsMarkdown).toContain("ECONNREFUSED");
    expect(h.reports[0].detailsMarkdown).toContain("stopped listening");
    expect(h.events).toContain("livenessCheck");
  });

  it("stays neutral when the eval fails but the PR's server is still listening", async () => {
    // Same transport-shaped error, but the process is alive. The failure came from
    // somewhere else — ours — so the check must not blame the PR.
    const h = harness(evalDies, "MCPJAM_CHECK_PORT_OPEN\n");
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.reports[0].outcome).toBe("infra_error");
  });

  it("stays neutral when the sandbox command channel has gone away", async () => {
    // The box no longer answers, so we cannot tell whose fault the eval failure
    // was — and an E2B outage is ours. Ambiguity must never produce a red X.
    const h = harness(evalDies, "throws");
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.reports[0].outcome).toBe("infra_error");
  });

  it("stays neutral when the liveness check answers with neither sentinel", async () => {
    // A connect that timed out, or a node that printed nothing. Silence is not
    // evidence against the PR.
    const h = harness(evalDies, "");
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.reports[0].outcome).toBe("infra_error");
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
    const provision = h.deps.provisionSandbox!;
    h.deps.provisionSandbox = async (args) => {
      const box = await provision(args);
      const inner = box.commands.run;
      box.commands.run = async (command: string, opts?: unknown) => {
        if (command.includes("MCPJAM_CHECK_PORT_OPEN")) {
          inDiagnostic = true;
          // Let the 1ms heartbeat fire and register the loss mid-diagnostic.
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return inner.call(box.commands, command, opts as never);
      };
      return box;
    };

    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    // Abandoned, not reported — and the box is still torn down.
    expect(h.reports).toHaveLength(0);
    expect(h.events).toContain("killSandbox");
  });

  it("checks liveness over the command RPC, never the public URL", async () => {
    // The load-bearing property: a fetch to `getHost(port)` traverses E2B ingress,
    // DNS and TLS, and reports every one of those outages exactly like a dead
    // server. Attribution must not rest on that path, so the probe runs in-box
    // against loopback.
    const commands: string[] = [];
    const h = harness(evalDies, "MCPJAM_CHECK_PORT_CLOSED\n");
    const provision = h.deps.provisionSandbox!;
    h.deps.provisionSandbox = async (args) => {
      const box = await provision(args);
      const inner = box.commands.run;
      box.commands.run = async (command: string, opts?: unknown) => {
        commands.push(command);
        return inner.call(box.commands, command, opts as never);
      };
      return box;
    };
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    const liveness = commands.find((c) => c.includes("MCPJAM_CHECK_PORT_OPEN"));
    expect(liveness).toBeDefined();
    expect(liveness).toContain("127.0.0.1");
    expect(liveness).toContain(String(RECIPE.port));
    expect(liveness).not.toContain("e2b.app");
  });

  it("reports infra_error — not evals_failed — when the org is out of credits", async () => {
    const h = harness({
      runEvalSuite: async () => {
        throw new Error("billing_limit_reached: eval iterations");
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.reports[0]).toMatchObject({
      outcome: "infra_error",
      failureReason: "billing_limit_reached",
    });
  });

  it("reports infra_error when the delegated token cannot be minted", async () => {
    const h = harness({
      getBearer: async () => {
        throw new Error("Delegated token exchange failed (403)");
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.reports[0].outcome).toBe("infra_error");
    // No server row was created, so nothing to delete…
    expect(h.events.some((e) => e.startsWith("deleteServer"))).toBe(false);
    // …but the sandbox was already provisioned, and a leaked box costs money.
    expect(h.events).toContain("killSandbox");
  });

  it("still reports and cleans up when the clone drifts from the claimed sha", async () => {
    const h = harness({
      cloneAndCheckout: async () => {
        throw new CheckStepError("infra_error", "checkout drifted");
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    expect(h.reports).toHaveLength(1);
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
    expect(h.reports[0].outcome).toBe("passed");
  });

  it("does not fail the check when recording the ephemeral server fails", async () => {
    const h = harness({
      recordServer: async () => {
        throw new Error("route 500");
      },
    });
    await executeClaimedCheck(CLAIM, "worker-1", h.deps);
    // Recovery loses its cleanup pointer, but the PR still gets its verdict.
    expect(h.reports[0].outcome).toBe("passed");
  });

  it("never throws, even when reporting itself fails", async () => {
    const h = harness({
      report: async () => {
        throw new Error("convex unreachable");
      },
      runEvalSuite: async () => {
        throw new Error("boom");
      },
    });
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
      expect(h.reports[0].outcome).toBe("passed");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("classifyCheckFailure", () => {
  it("keeps a CheckStepError's own verdict rather than re-deriving one", () => {
    expect(
      classifyCheckFailure(
        new CheckStepError("build_failed", "exit 1", "```text\nlog\n```")
      )
    ).toMatchObject({
      outcome: "build_failed",
      detailsMarkdown: expect.any(String),
    });
    expect(
      classifyCheckFailure(new CheckStepError("server_unhealthy", "no init"))
    ).toMatchObject({ outcome: "server_unhealthy" });
  });

  it("maps only the canonical billing marker, never a loose substring", () => {
    expect(
      classifyCheckFailure(new Error("billing_limit_reached: iterations"))
    ).toMatchObject({ failureReason: "billing_limit_reached" });
    // An MCP server error that merely mentions billing must not be reclassified.
    expect(
      classifyCheckFailure(new Error("tool failed: check your billing page"))
    ).toMatchObject({
      outcome: "infra_error",
      failureReason: "tool failed: check your billing page",
    });
  });

  it("defaults unknown failures to infra_error, never to the PR's fault", () => {
    // Guessing from a message would mean a red X on a good PR when we guess
    // wrong, so an unrecognized failure is always OURS.
    expect(classifyCheckFailure(new Error("???")).outcome).toBe("infra_error");
    expect(classifyCheckFailure("a bare string").outcome).toBe("infra_error");
  });

  it("bounds the failure reason", () => {
    expect(
      classifyCheckFailure(new Error("x".repeat(1_000))).failureReason.length
    ).toBe(200);
  });
});

describe("outcomeForRunResult", () => {
  it("treats only `passed` as a pass", () => {
    expect(outcomeForRunResult("passed")).toBe("passed");
    for (const result of [
      "failed",
      "cancelled",
      "timed_out",
      "pending",
      null,
      undefined,
    ]) {
      expect(outcomeForRunResult(result)).toBe("evals_failed");
    }
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
    expect(outcomeForRunResult(effectiveRunResult(perfect))).toBe("passed");
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
