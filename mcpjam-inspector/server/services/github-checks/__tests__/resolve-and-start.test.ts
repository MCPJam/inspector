import { describe, expect, it } from "vitest";
import {
  judgeListeners,
  resolveAndStart,
  type ResolveAndStartDeps,
} from "../resolve-and-start";
import { CheckStepError, type CheckSandbox } from "../sandbox";
import type { ResolvedRecipe } from "../resolver/index";
import type { ListenerReport } from "../sandbox-inspect";
import {
  CheckStoppedByPlan,
  PlanProtocolError,
  PlanUnreachableError,
  type AttemptDecision,
  type AttemptInput,
  type CheckPlanSession,
  type PlannedCandidate,
} from "../check-plan";

// What this suite protects, after A3b-2 moved attribution to the backend:
//
//   1. THE PLAN IS THE PROGRAM. Candidates run in the PLAN's order, not the
//      detector's, and the typed ACTION decides what happens next. Nothing here
//      computes an outcome any more.
//   2. FAIL CLOSED. An unknown action, a 409, or an unreachable backend all
//      STOP. None of them falls back to a local candidate policy — behaviour
//      must not differ invisibly between healthy and degraded runs.
//   3. THE #3644 HARDENING SURVIVES THE REFACTOR. A fresh box per candidate with
//      the previous one dead BEFORE the next is provisioned; listener identity
//      anchored at SPAWN, so nothing the box writes can forge it; an over-cap
//      `mcpjam.yaml` reported as `recipe_invalid` rather than collapsing to
//      "absent".

const ARGS = {
  triggerId: "trig-1",
  repoFullName: "acme/mcp-thing",
  prNumber: 7,
  headSha: "b".repeat(40),
};

type ResolverInputs = Awaited<
  ReturnType<ResolveAndStartDeps["readResolverInputs"]>
>;

const EMPTY_INPUTS: ResolverInputs = {
  mcpjamYaml: { kind: "absent" },
  detection: {
    packageJson: null,
    packageLockJson: null,
    pnpmLockYaml: null,
    yarnLock: null,
    pyprojectToml: null,
    uvLock: null,
    serverJson: null,
    readme: null,
    repoFiles: [],
  },
};

function recipe(
  overrides: Partial<ResolvedRecipe> & { start?: string } = {}
): ResolvedRecipe {
  return {
    build: "npm ci",
    start: "npm start",
    port: 3001,
    mcpPath: "/mcp",
    rung: "detected",
    ownershipProof: "unverified",
    evidence: ["package.json scripts.start"],
    ...overrides,
  };
}

function planned(
  candidateId: string,
  overrides: Partial<ResolvedRecipe> = {}
): PlannedCandidate {
  const full = recipe(overrides);
  return {
    candidateId,
    recipe: {
      build: full.build,
      start: full.start,
      port: full.port,
      mcpPath: full.mcpPath,
      // Only when the caller asked for one: an env-free plan candidate is the
      // ordinary case, and it must arrive with no `env` key at all.
      ...(full.env ? { env: full.env } : {}),
    },
    rung: full.rung,
    evidence: full.evidence,
    ownershipProof: full.ownershipProof,
    source: "detected",
  };
}

/** The identity `buildAndStart` captured for the command it spawned. */
const SPAWN = { pid: 100, pgrp: 100 };

/** A listener that IS the spawned process. */
function goodReport(pid = SPAWN.pid): ListenerReport {
  return { processes: [{ pid, ppids: [], pgrp: pid }] };
}

type RecordedAttempt = AttemptInput;

/**
 * A fake plan session.
 *
 * `actions` scripts the backend's replies by `phase` (optionally `phase:ok`),
 * which is how a test says "the first candidate's build failure gets
 * `try_next_candidate`" without restating the state machine. Anything not
 * scripted answers the boring default: `continue_phase` for progress,
 * `run_eval` for an accepted candidate, `complete` for a failure.
 */
function fakeSession(options?: {
  candidates?: PlannedCandidate[];
  actions?: Record<string, AttemptDecision | (() => AttemptDecision)>;
  onCandidates?: (input: {
    evidenceDigest: string;
    resolverVersion: string;
    localCandidates: unknown[];
  }) => void;
  candidatesThrows?: unknown;
  attemptThrows?: Record<string, unknown>;
  stopPolicy?: { maxCandidates: number; wallClockMs: number };
}): {
  session: CheckPlanSession;
  attempts: RecordedAttempt[];
  completions: unknown[];
} {
  const attempts: RecordedAttempt[] = [];
  const completions: unknown[] = [];
  const session: CheckPlanSession = {
    planId: "plan-1",
    candidates: async (input) => {
      options?.onCandidates?.(input);
      if (options?.candidatesThrows) throw options.candidatesThrows;
      return {
        candidates: options?.candidates ?? [planned("c1")],
        stopPolicy: options?.stopPolicy ?? {
          maxCandidates: 3,
          wallClockMs: 20 * 60_000,
        },
      };
    },
    attempt: async (input) => {
      attempts.push(input);
      const keys = [`${input.phase}:${input.ok ? "ok" : "fail"}`, input.phase];
      for (const key of keys) {
        const thrown = options?.attemptThrows?.[key];
        if (thrown) throw thrown;
        const scripted = options?.actions?.[key];
        if (scripted) {
          return typeof scripted === "function" ? scripted() : scripted;
        }
      }
      if (!input.ok) return { action: "complete", reason: input.failureKind };
      if (input.phase === "verify") {
        return { action: "run_eval", reason: "candidate_accepted" };
      }
      return { action: "continue_phase" };
    },
    complete: async (input) => {
      completions.push(input);
    },
  };
  return { session, attempts, completions };
}

type CloneCall = Parameters<ResolveAndStartDeps["cloneAndCheckout"]>[1];

type Fakes = {
  deps: Partial<ResolveAndStartDeps> & { plan: CheckPlanSession };
  events: string[];
  boxes: CheckSandbox[];
  attempts: RecordedAttempt[];
  /** What `cloneAndCheckout` was asked for, per box. */
  clones: CloneCall[];
};

/**
 * `attempt` maps a recipe's `start` command to what its build should do — which
 * is how a test says "candidate 1 fails to build, candidate 2 works" without
 * knowing anything about box plumbing.
 */
function fakes(options: {
  ladder?: ReturnType<ResolveAndStartDeps["resolveLadder"]>;
  session?: ReturnType<typeof fakeSession>;
  attempt?: (recipe: ResolvedRecipe, boxId: string) => void | never;
  listener?: (recipe: ResolvedRecipe) => ListenerReport | null;
  spawn?: { pid: number; pgrp: number | null };
  provision?: (index: number) => void | never;
  clone?: (index: number) => void | never;
  inputs?: ResolverInputs;
}): Fakes {
  const events: string[] = [];
  const boxes: CheckSandbox[] = [];
  const clones: CloneCall[] = [];
  let provisioned = 0;
  const scripted = options.session ?? fakeSession();

  const deps: Partial<ResolveAndStartDeps> & { plan: CheckPlanSession } = {
    plan: scripted.session,
    provisionSandbox: async () => {
      provisioned += 1;
      options.provision?.(provisioned);
      const box = {
        sandboxId: `sb_${provisioned}`,
        getHost: (port: number) => `${port}-sb_${provisioned}.e2b.app`,
        commands: { run: async () => ({}) },
        kill: async () => {},
      } as unknown as CheckSandbox;
      boxes.push(box);
      events.push(`provision:${box.sandboxId}`);
      return box;
    },
    cloneAndCheckout: async (sandbox, cloneArgs) => {
      clones.push(cloneArgs);
      options.clone?.(boxes.length);
      events.push(`clone:${sandbox.sandboxId}`);
    },
    buildAndStart: async (sandbox, built) => {
      events.push(`buildAndStart:${sandbox.sandboxId}:${built.start}`);
      options.attempt?.(built as ResolvedRecipe, sandbox.sandboxId);
      return {
        url: `https://${sandbox.getHost(built.port)}${built.mcpPath}`,
        readStderrTail: async () => "",
        spawn: options.spawn ?? SPAWN,
      };
    },
    killSandbox: async (sandbox) => {
      events.push(`kill:${sandbox?.sandboxId ?? "none"}`);
    },
    ...(options.ladder ? { resolveLadder: () => options.ladder! } : {}),
    readResolverInputs: async () => options.inputs ?? EMPTY_INPUTS,
    inspectListener: async (_sandbox, args) => {
      events.push(`inspect:${args.port}`);
      return options.listener
        ? options.listener(recipe({ port: args.port }))
        : goodReport();
    },
    onSandbox: () => {},
    assertLeaseHeld: () => {},
    now: () => 0,
  };

  return { deps, events, boxes, attempts: scripted.attempts, clones };
}

async function stopOf(promise: Promise<unknown>): Promise<CheckStoppedByPlan> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CheckStoppedByPlan) return error;
    throw error;
  }
  throw new Error("expected the check to stop");
}

const failing = (kind: "build_failed" | "server_unhealthy") => () => {
  throw new CheckStepError(kind, `${kind} for the test`);
};

describe("resolveAndStart — the plan is the program", () => {
  it("executes the PLAN's candidates, in the PLAN's order", async () => {
    // The detector's own order is deliberately the reverse: the backend owns
    // ordering now, so what the detector preferred must not decide anything.
    const local = [
      recipe({ start: "node local-first.js" }),
      recipe({ start: "node local-second.js" }),
    ];
    const session = fakeSession({
      candidates: [
        planned("c1", { start: "node plan-first.js" }),
        planned("c2", { start: "node plan-second.js" }),
      ],
      actions: { "build:fail": { action: "try_next_candidate" } },
    });
    const f = fakes({
      ladder: { kind: "candidates", candidates: local },
      session,
      attempt: (built) => {
        if (built.start === "node plan-first.js") failing("build_failed")();
      },
    });

    const result = await resolveAndStart(ARGS, f.deps);
    expect(result.candidateId).toBe("c2");
    expect(result.recipe.start).toBe("node plan-second.js");
    expect(
      f.events.filter((event) => event.startsWith("buildAndStart"))
    ).toEqual([
      "buildAndStart:sb_1:node plan-first.js",
      "buildAndStart:sb_2:node plan-second.js",
    ]);
    // Nothing the detector proposed was executed directly.
    expect(f.events.join("|")).not.toContain("local-first");
  });

  it("hands the backend the digest, the resolver version and the local candidates", async () => {
    let seen: any = null;
    const session = fakeSession({ onCandidates: (input) => (seen = input) });
    const f = fakes({
      ladder: {
        kind: "candidates",
        candidates: [recipe({ start: "node a.js", evidence: ["A"] })],
      },
      session,
    });
    f.deps.resolverVersion = "test-resolver/9";

    await resolveAndStart(ARGS, f.deps);
    expect(seen.resolverVersion).toBe("test-resolver/9");
    expect(seen.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(seen.localCandidates).toEqual([
      {
        recipe: {
          build: "npm ci",
          start: "node a.js",
          port: 3001,
          mcpPath: "/mcp",
        },
        rung: "detected",
        evidence: ["A"],
        ownershipProof: "unverified",
      },
    ]);
  });

  it("reports the ladder phases with NO candidateId, in order", async () => {
    const session = fakeSession();
    const f = fakes({
      ladder: { kind: "candidates", candidates: [recipe()] },
      session,
    });
    await resolveAndStart(ARGS, f.deps);

    const ladder = f.attempts.filter((a) => !a.candidateId);
    expect(ladder.map((a) => a.phase)).toEqual([
      "provision",
      "clone",
      "resolve",
    ]);
    // And the candidate's own rows all carry one.
    expect(f.attempts.filter((a) => a.candidateId).map((a) => a.phase)).toEqual(
      ["probe", "verify"]
    );
  });
});

describe("resolveAndStart — the typed action decides what happens next", () => {
  it("`try_next_candidate` moves to the next planned candidate", async () => {
    const session = fakeSession({
      candidates: [planned("c1", { start: "node a.js" }), planned("c2")],
      actions: { "build:fail": { action: "try_next_candidate" } },
    });
    const f = fakes({
      session,
      ladder: { kind: "candidates", candidates: [recipe()] },
      attempt: (built) => {
        if (built.start === "node a.js") failing("build_failed")();
      },
    });
    const result = await resolveAndStart(ARGS, f.deps);
    expect(result.candidateId).toBe("c2");
  });

  it("`complete` on a candidate failure stops without trying the next", async () => {
    // This is the authoritative-rung case from the worker's side: the backend
    // refuses to fall through, and the Inspector no longer has an opinion.
    const session = fakeSession({
      candidates: [planned("c1"), planned("c2")],
      actions: {
        "build:fail": { action: "complete", reason: "authoritative_failure" },
      },
    });
    const f = fakes({
      session,
      ladder: { kind: "candidates", candidates: [recipe()] },
      attempt: failing("build_failed"),
    });

    const stop = await stopOf(resolveAndStart(ARGS, f.deps));
    expect(stop.reason).toBe("authoritative_failure");
    expect(f.boxes).toHaveLength(1);
    expect(
      f.events.filter((event) => event.startsWith("buildAndStart"))
    ).toHaveLength(1);
  });

  it("stops at a candidate boundary once the plan's wall clock is spent", async () => {
    // The backend can bound the SEARCH by issuing fewer candidates, but nothing
    // else stops a build-and-probe cycle per candidate while it keeps answering
    // `try_next_candidate` — the lease heartbeat keeps succeeding throughout.
    const session = fakeSession({
      candidates: [planned("c1"), planned("c2")],
      actions: { "build:fail": { action: "try_next_candidate" } },
      stopPolicy: { maxCandidates: 3, wallClockMs: 60_000 },
    });
    const f = fakes({
      session,
      ladder: { kind: "candidates", candidates: [recipe()] },
      attempt: failing("build_failed"),
    });
    let clock = 0;
    // The first candidate is inside the deadline; it overruns while running.
    f.deps.now = () => (clock += 45_000);

    const stop = await stopOf(resolveAndStart(ARGS, f.deps));
    expect(stop.reason).toBe("plan_wall_clock_exhausted");
    // The second candidate is never provisioned, let alone built.
    expect(
      f.events.filter((event) => event.startsWith("buildAndStart"))
    ).toHaveLength(1);
  });

  it("re-reads the deadline AFTER provisioning, before the build", async () => {
    // Provision and clone are minutes of budget themselves. A candidate that
    // was inside the deadline when its iteration began can be outside it by the
    // time there is a box to build in — and the build is the expensive half.
    const session = fakeSession({
      candidates: [planned("c1"), planned("c2")],
      actions: { "build:fail": { action: "try_next_candidate" } },
      stopPolicy: { maxCandidates: 3, wallClockMs: 60_000 },
    });
    // Still inside the deadline at the top of candidate 2's iteration — its own
    // provision is what spends the rest of the budget.
    let clock = 0;
    const f = fakes({
      session,
      ladder: { kind: "candidates", candidates: [recipe()] },
      attempt: failing("build_failed"),
      provision: (index) => {
        if (index === 2) clock = 90_000;
      },
    });
    f.deps.now = () => clock;

    const stop = await stopOf(resolveAndStart(ARGS, f.deps));
    expect(stop.reason).toBe("plan_wall_clock_exhausted");
    // The second box WAS provisioned — and then nothing was built in it.
    expect(f.events).toContain("provision:sb_2");
    expect(
      f.events.filter((event) => event.startsWith("buildAndStart"))
    ).toHaveLength(1);
  });

  it("treats `wallClockMs: 0` as NO deadline, not an expired one", async () => {
    const session = fakeSession({
      stopPolicy: { maxCandidates: 3, wallClockMs: 0 },
    });
    const f = fakes({
      session,
      ladder: { kind: "candidates", candidates: [recipe()] },
    });
    let clock = 0;
    f.deps.now = () => (clock += 10 * 60_000);

    const result = await resolveAndStart(ARGS, f.deps);
    expect(result.started.url).toBe("https://3001-sb_1.e2b.app/mcp");
  });

  it("`run_eval` on an accepted candidate returns the running server", async () => {
    const f = fakes({ ladder: { kind: "candidates", candidates: [recipe()] } });
    const result = await resolveAndStart(ARGS, f.deps);
    expect(result.started.url).toBe("https://3001-sb_1.e2b.app/mcp");
    expect(result.sandbox.sandboxId).toBe("sb_1");
    // The winning box is the one that stays alive.
    expect(f.events).not.toContain("kill:sb_1");
  });

  it("stops when `verify` ok is answered with anything but `run_eval`", async () => {
    // Fail closed: an accepted candidate that is not told to run the eval is a
    // contract we do not understand, and running one anyway could green a check
    // the backend meant to abort.
    const session = fakeSession({
      actions: { "verify:ok": { action: "continue_phase" } },
    });
    const f = fakes({
      session,
      ladder: { kind: "candidates", candidates: [recipe()] },
    });
    const stop = await stopOf(resolveAndStart(ARGS, f.deps));
    expect(stop.reason).toBe("continue_phase");
  });

  it("treats an UNKNOWN action as `complete`, and executes nothing further", async () => {
    // The client-side normalization lives in `check-plan.ts`; what this pins is
    // the orchestrator's half — it obeys the resulting `complete` and does not
    // carry on with the plan.
    const session = fakeSession({
      candidates: [planned("c1"), planned("c2")],
      actions: {
        "build:fail": {
          action: "complete",
          reason: "unknown_action",
          unknownAction: true,
        },
      },
    });
    const f = fakes({
      session,
      ladder: { kind: "candidates", candidates: [recipe()] },
      attempt: failing("build_failed"),
    });

    const stop = await stopOf(resolveAndStart(ARGS, f.deps));
    expect(stop.reason).toBe("unknown_action");
    expect(f.boxes).toHaveLength(1);
  });
});

describe("resolveAndStart — degraded and refused", () => {
  it("a 409 is a HARD STOP: no retry, no local fallback, no further candidates", async () => {
    const refusal = new PlanProtocolError("attempt", "phase_out_of_order", 409);
    const session = fakeSession({
      candidates: [planned("c1"), planned("c2")],
      attemptThrows: { "probe:ok": refusal },
    });
    const f = fakes({
      session,
      ladder: { kind: "candidates", candidates: [recipe(), recipe()] },
    });

    await expect(resolveAndStart(ARGS, f.deps)).rejects.toBe(refusal);
    // One box, one build: the second planned candidate was never touched, and
    // the refused call was never repeated.
    expect(f.boxes).toHaveLength(1);
    expect(f.attempts.filter((a) => a.phase === "probe" && a.ok)).toHaveLength(
      1
    );
    // Every box is dead on the failure path.
    expect(f.events).toContain("kill:sb_1");
  });

  it("an unreachable /plan/candidates executes NO local candidate", async () => {
    // The whole point of degraded mode: falling back to `localCandidates` in our
    // own order would make behaviour differ invisibly between healthy and
    // degraded runs, and every verdict un-reproducible.
    const unreachable = new PlanUnreachableError(
      "plan/candidates",
      "ECONNREFUSED"
    );
    const session = fakeSession({ candidatesThrows: unreachable });
    const f = fakes({
      session,
      ladder: {
        kind: "candidates",
        candidates: [recipe({ start: "node a.js" }), recipe()],
      },
    });

    await expect(resolveAndStart(ARGS, f.deps)).rejects.toBe(unreachable);
    expect(f.events.some((event) => event.startsWith("buildAndStart"))).toBe(
      false
    );
    expect(f.events).toContain("kill:sb_1");
  });

  it("stops when the plan comes back with no candidates at all", async () => {
    const session = fakeSession({ candidates: [] });
    const f = fakes({
      session,
      ladder: { kind: "candidates", candidates: [recipe()] },
    });
    const stop = await stopOf(resolveAndStart(ARGS, f.deps));
    expect(stop.reason).toBe("plan_has_no_candidates");
    expect(f.events.some((event) => event.startsWith("buildAndStart"))).toBe(
      false
    );
  });
});

describe("resolveAndStart — pre-candidate failures are attributable", () => {
  it("reports a provision failure against the begun plan, with no candidateId", async () => {
    const session = fakeSession();
    const f = fakes({
      session,
      ladder: { kind: "candidates", candidates: [recipe()] },
      provision: () => {
        throw new CheckStepError("infra_error", "E2B 503");
      },
    });

    const stop = await stopOf(resolveAndStart(ARGS, f.deps));
    expect(stop.reason).toBe("provision_failed");
    expect(f.attempts).toEqual([
      expect.objectContaining({
        phase: "provision",
        ok: false,
        failureKind: "provision_failed",
      }),
    ]);
    expect(f.attempts[0].candidateId).toBeUndefined();
  });

  it("reports a clone failure the same way", async () => {
    const session = fakeSession();
    const f = fakes({
      session,
      ladder: { kind: "candidates", candidates: [recipe()] },
      clone: () => {
        throw new CheckStepError("infra_error", "clone/checkout failed");
      },
    });

    const stop = await stopOf(resolveAndStart(ARGS, f.deps));
    expect(stop.reason).toBe("clone_failed");
    expect(f.attempts.map((a) => `${a.phase}:${a.ok}`)).toEqual([
      "provision:true",
      "clone:false",
    ]);
  });

  it("reports `recipe_invalid` at `resolve` for a broken mcpjam.yaml, and runs nothing", async () => {
    // The REAL ladder, so the mapping from its `RecipeResolutionError` to the
    // reported failure kind is exercised rather than restated.
    const session = fakeSession();
    const f = fakes({
      session,
      inputs: {
        ...EMPTY_INPUTS,
        mcpjamYaml: {
          kind: "present",
          text: "version: 1\nchecks:\n  build: npm ci\n",
        },
      },
    });

    const stop = await stopOf(resolveAndStart(ARGS, f.deps));
    expect(stop.reason).toBe("recipe_invalid");
    expect(stop.detailsMarkdown).toContain("present but not usable");
    expect(f.attempts.at(-1)).toMatchObject({
      phase: "resolve",
      ok: false,
      failureKind: "recipe_invalid",
    });
    // LADDER-scoped, which is what makes the authoritative-rung requirement true
    // by construction: `resolve` carries no candidate and therefore no rung.
    expect(f.attempts.at(-1)?.candidateId).toBeUndefined();
    expect(f.events.some((event) => event.startsWith("buildAndStart"))).toBe(
      false
    );
  });

  it("reports `recipe_invalid` for an OVER-CAP mcpjam.yaml, and never falls through", async () => {
    // The #3644 defect this pins: the sandbox reader cannot pull an unbounded
    // file across the command channel, and reporting "absent" made an oversized
    // (therefore invalid) declared config look like no declaration at all — so
    // the ladder guessed, ran a command nobody wrote, and the result was
    // reported under the author's name.
    const session = fakeSession();
    const f = fakes({
      session,
      inputs: {
        ...EMPTY_INPUTS,
        mcpjamYaml: { kind: "over_cap" },
        // A perfectly detectable repo, so there IS something to fall through to.
        detection: {
          ...EMPTY_INPUTS.detection,
          packageJson: JSON.stringify({
            name: "x",
            scripts: { start: "node dist/index.js", build: "tsc" },
          }),
          packageLockJson: "{}",
        },
      },
    });

    const stop = await stopOf(resolveAndStart(ARGS, f.deps));
    expect(stop.reason).toBe("recipe_invalid");
    expect(f.attempts.at(-1)).toMatchObject({ failureKind: "recipe_invalid" });
    expect(f.events.some((event) => event.startsWith("buildAndStart"))).toBe(
      false
    );
  });

  it("reports `no_candidates` at `resolve` when nothing is detectable", async () => {
    const session = fakeSession();
    const f = fakes({ session });

    const stop = await stopOf(resolveAndStart(ARGS, f.deps));
    expect(stop.reason).toBe("no_candidates");
    // The author-facing copy still points at the one-file fix.
    expect(stop.detailsMarkdown).toContain("mcpjam.yaml");
    expect(f.attempts.at(-1)).toMatchObject({
      phase: "resolve",
      ok: false,
      failureKind: "no_candidates",
    });
  });
});

describe("resolveAndStart — a fresh sandbox per candidate", () => {
  it("kills candidate A's box BEFORE provisioning candidate B's", async () => {
    // The ordering IS the requirement: A's box must be gone before B's exists,
    // or B builds beside A's leftovers with egress already revoked, and A's
    // server may still hold the port B is about to probe.
    const session = fakeSession({
      candidates: [
        planned("c1", { start: "node a.js" }),
        planned("c2", { start: "node b.js" }),
      ],
      actions: { "build:fail": { action: "try_next_candidate" } },
    });
    const f = fakes({
      session,
      ladder: { kind: "candidates", candidates: [recipe()] },
      attempt: (built) => {
        if (built.start === "node a.js") failing("build_failed")();
      },
    });

    const result = await resolveAndStart(ARGS, f.deps);
    expect(result.sandbox.sandboxId).toBe("sb_2");
    expect(f.boxes).toHaveLength(2);
    expect(f.events.indexOf("kill:sb_1")).toBeGreaterThan(-1);
    expect(f.events.indexOf("kill:sb_1")).toBeLessThan(
      f.events.indexOf("provision:sb_2")
    );
    // And B's build ran in B's own box, never in A's.
    expect(f.events).not.toContain("buildAndStart:sb_1:node b.js");
  });

  it("reports the second candidate's own provision and clone against IT", async () => {
    const session = fakeSession({
      candidates: [planned("c1", { start: "node a.js" }), planned("c2")],
      actions: { "build:fail": { action: "try_next_candidate" } },
    });
    const f = fakes({
      session,
      ladder: { kind: "candidates", candidates: [recipe()] },
      attempt: (built) => {
        if (built.start === "node a.js") failing("build_failed")();
      },
    });
    await resolveAndStart(ARGS, f.deps);

    // A fresh box per candidate means each candidate provisions and clones for
    // itself; which row is a LADDER row is decided by the candidateId, never by
    // the phase name.
    expect(
      f.attempts
        .filter((a) => a.phase === "provision" || a.phase === "clone")
        .map((a) => `${a.phase}:${a.candidateId ?? "-"}`)
    ).toEqual(["provision:-", "clone:-", "provision:c2", "clone:c2"]);
  });
});

describe("resolveAndStart — runtime verification", () => {
  it("reports `listener_mismatch` when the listener is not the process we spawned", async () => {
    // The install-hook class: `"prepare": "nohup acme-server &"` squats the port
    // and answers our probe while the start command never binds.
    const session = fakeSession({
      candidates: [planned("c1", { start: "node a.js" }), planned("c2")],
      actions: { "verify:fail": { action: "try_next_candidate" } },
    });
    let inspected = 0;
    const f = fakes({
      session,
      ladder: { kind: "candidates", candidates: [recipe()] },
    });
    f.deps.inspectListener = async () => {
      inspected += 1;
      return inspected === 1
        ? { processes: [{ pid: 777, ppids: [1], pgrp: 31 }] }
        : goodReport();
    };

    const result = await resolveAndStart(ARGS, f.deps);
    expect(result.candidateId).toBe("c2");
    expect(f.attempts).toContainEqual(
      expect.objectContaining({
        phase: "verify",
        ok: false,
        failureKind: "listener_mismatch",
      })
    );
  });

  it("cannot be fooled by a squatter that FORGES our pid inside the box", async () => {
    // The adversarial case the pid file created. A squatter that writes
    // `/tmp/mcp-server.pid` — or names any pid it likes anywhere in the box —
    // changes nothing, because the expected identity is the one `buildAndStart`
    // captured at spawn and it never leaves this process.
    const session = fakeSession();
    const f = fakes({
      session,
      ladder: { kind: "candidates", candidates: [recipe()] },
      spawn: { pid: 100, pgrp: 100 },
      listener: () => ({ processes: [{ pid: 900, ppids: [1], pgrp: 900 }] }),
    });

    await stopOf(resolveAndStart(ARGS, f.deps));
    expect(f.attempts.at(-1)).toMatchObject({
      failureKind: "listener_mismatch",
    });
    // And the box was never asked to supply the pid we compare against.
    expect(f.events).toContain("inspect:3001");
  });

  it("asks the box only which port to look at — never who to look for", async () => {
    let seen: unknown = null;
    const f = fakes({ ladder: { kind: "candidates", candidates: [recipe()] } });
    f.deps.inspectListener = async (_sandbox, args) => {
      seen = args;
      return goodReport();
    };
    await resolveAndStart(ARGS, f.deps);
    expect(seen).toEqual({ port: 3001 });
  });

  it("reports `listener_unknown` — never a pass, never a miss — when it cannot look", async () => {
    const session = fakeSession();
    const f = fakes({
      session,
      ladder: { kind: "candidates", candidates: [recipe()] },
      listener: () => null,
    });

    await stopOf(resolveAndStart(ARGS, f.deps));
    expect(f.attempts.at(-1)).toMatchObject({
      phase: "verify",
      ok: false,
      failureKind: "listener_unknown",
    });
  });

  it("maps a build failure to `build` and an unhealthy server to `probe`", async () => {
    for (const [outcome, phase, kind] of [
      ["build_failed", "build", "build_failed"],
      ["server_unhealthy", "probe", "probe_failed"],
    ] as const) {
      const session = fakeSession();
      const f = fakes({
        session,
        ladder: { kind: "candidates", candidates: [recipe()] },
        attempt: failing(outcome),
      });
      await stopOf(resolveAndStart(ARGS, f.deps));
      expect(f.attempts.at(-1)).toMatchObject({
        phase,
        ok: false,
        failureKind: kind,
        candidateId: "c1",
      });
    }
  });

  it("maps a build/start infrastructure failure to `sandbox_error`", async () => {
    // Not `build_failed`: nothing about the PR's build is established by E2B
    // falling over, and the backend aborts on the infrastructure kinds rather
    // than burning the remaining candidates.
    const session = fakeSession();
    const f = fakes({
      session,
      ladder: { kind: "candidates", candidates: [recipe()] },
      attempt: () => {
        throw new CheckStepError(
          "infra_error",
          "sandbox start failed: e2b 503"
        );
      },
    });
    await stopOf(resolveAndStart(ARGS, f.deps));
    expect(f.attempts.at(-1)).toMatchObject({ failureKind: "sandbox_error" });
  });
});

describe("judgeListeners", () => {
  const base = { pid: 200, ppids: [150, 100], pgrp: 100 };
  const spawn = { pid: 100, pgrp: 100 };

  it("accepts a descendant of the spawned start command", () => {
    expect(judgeListeners({ processes: [base] }, spawn)).toEqual({
      status: "ok",
    });
  });

  it("accepts a reparented server AFTER its supervisor is gone", () => {
    // THE case the process-group fallback exists for: a double-forked server is
    // reparented to init (`ppids: [1]`), so ancestry is lost, and the supervisor
    // we spawned has EXITED — so `/proc/<spawn pid>` does not exist and the
    // report says nothing at all about pid 100. The only thing left that can
    // identify this process is the group we recorded at spawn time. Reading the
    // group out of the box at this moment returns null here by construction, and
    // the fallback could never fire.
    const report = { processes: [{ pid: 200, ppids: [1], pgrp: 100 }] };
    expect(report.processes.some((process) => process.pid === spawn.pid)).toBe(
      false
    );
    expect(judgeListeners(report, spawn)).toEqual({ status: "ok" });
  });

  it("rejects that same reparented server when the spawn captured no group", () => {
    // A failed capture NARROWS the check to ancestry alone. It must never widen
    // it, and it must never fall back to something the box told us.
    const verdict = judgeListeners(
      { processes: [{ pid: 200, ppids: [1], pgrp: 100 }] },
      { pid: 100, pgrp: null }
    );
    expect(verdict.status).toBe("mismatch");
  });

  it("rejects a listener from another process group entirely", () => {
    const verdict = judgeListeners(
      { processes: [{ ...base, ppids: [1], pgrp: 55 }] },
      spawn
    );
    expect(verdict.status).toBe("mismatch");
  });

  it("rejects a listener that claims OUR pid but is a different process", () => {
    // A squatter cannot choose its own pid, but it could once choose the pid we
    // BELIEVED was ours. It cannot any more: the expected pid is E2B's, so a
    // process bearing an unrelated pid is simply not it.
    const verdict = judgeListeners(
      { processes: [{ pid: 4242, ppids: [1], pgrp: 4242 }] },
      spawn
    );
    expect(verdict.status).toBe("mismatch");
  });

  it("rejects when ANY listener on the port is foreign", () => {
    // SO_REUSEPORT lets a squatter bind beside us, and the kernel decides which
    // one answers — so "one of them is ours" is not a property to rely on.
    const verdict = judgeListeners(
      { processes: [base, { pid: 900, ppids: [1], pgrp: 900 }] },
      spawn
    );
    expect(verdict.status).toBe("mismatch");
  });

  it("says 'unknown' — never ok — when no process could be attributed", () => {
    const verdict = judgeListeners({ processes: [] }, spawn);
    expect(verdict.status).toBe("unknown");
  });
});

describe("resolveAndStart — the private-repository clone credential", () => {
  const TOKEN = "ghs_privateRepoToken1234567890";

  it("threads the token to EVERY clone, and to nothing else", async () => {
    // A fresh box per candidate means a fresh clone per candidate, so the
    // credential is needed on each one — a token threaded only to the first
    // would work right up until the second candidate, where it would look like
    // the repository disappeared.
    const session = fakeSession({
      candidates: [planned("c1", { start: "node a.js" }), planned("c2")],
      actions: { "build:fail": { action: "try_next_candidate" } },
    });
    const f = fakes({
      ladder: { kind: "candidates", candidates: [recipe()] },
      session,
      attempt: (built) => {
        if (built.start === "node a.js") failing("build_failed")();
      },
    });

    await resolveAndStart({ ...ARGS, cloneToken: TOKEN }, f.deps);

    expect(f.clones.length).toBeGreaterThan(1);
    for (const clone of f.clones) {
      expect(clone.cloneToken).toBe(TOKEN);
      expect(clone.headSha).toBe(ARGS.headSha);
    }
    // It travels on the CHECKOUT args and nowhere else. Recipes and planned
    // candidates are logged, digested and sent to the backend; a secret on one
    // of those types is a secret in the corpus.
    const localCandidates = JSON.stringify(f.attempts);
    expect(localCandidates).not.toContain(TOKEN);
  });

  it("asks for no credential at all when the repository is public", async () => {
    const f = fakes({
      ladder: { kind: "candidates", candidates: [recipe()] },
    });
    await resolveAndStart(ARGS, f.deps);
    expect(f.clones).toHaveLength(1);
    expect(f.clones[0].cloneToken).toBeUndefined();
    expect(f.clones[0]).not.toHaveProperty("cloneToken");
  });

  it("redacts the credential out of a clone failure before it reaches the backend", async () => {
    // `detailsClamped` is stored in the corpus. A secret that reaches it is a
    // secret nobody can un-store, so this is the second redaction boundary —
    // `sandbox.ts` owns the first, and neither is allowed to be the only one.
    const basic = Buffer.from(`x-access-token:${TOKEN}`, "utf8").toString(
      "base64"
    );
    const session = fakeSession();
    const f = fakes({
      session,
      clone: () => {
        throw new CheckStepError(
          "infra_error",
          `sandbox command failed: git -c 'http.extraheader=AUTHORIZATION: basic ${basic}' clone --depth 50 (token ${TOKEN})`
        );
      },
    });

    const stop = await stopOf(
      resolveAndStart({ ...ARGS, cloneToken: TOKEN }, f.deps)
    );
    expect(stop.reason).toBe("clone_failed");

    const cloneAttempt = f.attempts.find(
      (attempt) => attempt.phase === "clone" && !attempt.ok
    );
    expect(cloneAttempt?.failureKind).toBe("clone_failed");
    for (const form of [TOKEN, basic, `AUTHORIZATION: basic ${basic}`]) {
      expect(cloneAttempt?.detailsClamped ?? "").not.toContain(form);
    }
    // Redacted, not dropped: the failure is still legible.
    expect(cloneAttempt?.detailsClamped).toContain("sandbox command failed");
    expect(cloneAttempt?.detailsClamped).toContain("[redacted]");
    // And nothing leaked through the whole recorded attempt log either.
    expect(JSON.stringify(f.attempts)).not.toContain(TOKEN);
  });

  it("redacts before the 500-character bound, so no slice can halve the token", async () => {
    // Clamping after redacting is safe; redacting after clamping is not. A
    // token straddling the boundary would be cut in half, and half a token no
    // longer matches the literal the replacement looks for — so it would survive
    // into the corpus as a fragment nobody can search for later.
    const session = fakeSession();
    const f = fakes({
      session,
      clone: () => {
        // A plain Error, which is the branch `errorDetail` bounds at 500. The
        // padding puts the token at offsets 488-518, straddling the cut: redact
        // first and the whole literal goes, clamp first and its first 12
        // characters survive into the corpus as an unsearchable fragment.
        throw new Error(`${"padding ".repeat(61)}${TOKEN} trailing`);
      },
    });

    await stopOf(resolveAndStart({ ...ARGS, cloneToken: TOKEN }, f.deps));

    const detail =
      f.attempts.find((attempt) => attempt.phase === "clone" && !attempt.ok)
        ?.detailsClamped ?? "";
    expect(detail.length).toBeLessThanOrEqual(500);
    expect(detail).not.toContain(TOKEN);
    // No FRAGMENT of it either — the whole literal was replaced before the cut.
    expect(detail).not.toContain(TOKEN.slice(0, 12));
    expect(detail).toContain("[redacted]");
  });
});

describe("resolveAndStart — the declared environment travels with the recipe", () => {
  // The channel runs repo -> parser -> plan -> backend -> plan -> execution, and
  // this file owns the two hops in the middle. What must not happen at either
  // is the environment being dropped: a server started without the
  // configuration its author declared fails its probe and reports
  // `server_unhealthy` against a pull request that did nothing wrong.
  const ENV = { LOG_LEVEL: "debug", FIXTURE_MODE: "strict" };

  it("reports a declared candidate's env to the backend", async () => {
    let seen: any = null;
    const session = fakeSession({ onCandidates: (input) => (seen = input) });
    const f = fakes({
      ladder: {
        kind: "authoritative",
        recipe: recipe({
          rung: "declared",
          ownershipProof: "verified",
          evidence: ["mcpjam.yaml at repo root (version 1)"],
          env: ENV,
        }),
      },
      session,
    });

    await resolveAndStart(ARGS, f.deps);
    expect(seen.localCandidates).toEqual([
      {
        recipe: {
          build: "npm ci",
          start: "npm start",
          port: 3001,
          mcpPath: "/mcp",
          env: ENV,
        },
        rung: "declared",
        evidence: ["mcpjam.yaml at repo root (version 1)"],
        ownershipProof: "verified",
      },
    ]);
  });

  it("sends NO env key for a detected candidate, or an empty one", async () => {
    // Detection never proposes an environment, and the backend REJECTS `env` on
    // a cacheable rung — so an `env: undefined` or an `env: {}` riding along on
    // a detected candidate is not a harmless extra key, it is a 400 on a
    // candidate that would otherwise have run.
    let seen: any = null;
    const session = fakeSession({ onCandidates: (input) => (seen = input) });
    const f = fakes({
      ladder: {
        kind: "candidates",
        candidates: [
          recipe({ start: "node detected.js" }),
          // Defensive: even if something upstream hands over an empty map, it is
          // absence and must be reported as absence.
          recipe({ start: "node empty-env.js", env: {} }),
        ],
      },
      session,
    });

    await resolveAndStart(ARGS, f.deps);
    for (const candidate of seen.localCandidates) {
      expect("env" in candidate.recipe).toBe(false);
    }
  });

  it("hands the plan's env to buildAndStart, unchanged", async () => {
    // The backend owns the plan: whatever env it issues is the one that runs,
    // including one the Inspector never proposed.
    const built: Array<Record<string, string> | undefined> = [];
    const session = fakeSession({
      candidates: [
        planned("c1", {
          start: "node planned.js",
          rung: "declared",
          env: { FROM_PLAN: "yes" },
        }),
      ],
    });
    const f = fakes({
      // The local candidate carries NO environment, so what runs can only have
      // come from the plan.
      ladder: { kind: "candidates", candidates: [recipe()] },
      session,
    });
    const inner = f.deps.buildAndStart!;
    f.deps.buildAndStart = async (sandbox, recipeToRun) => {
      built.push(recipeToRun.env);
      return inner(sandbox, recipeToRun);
    };

    const result = await resolveAndStart(ARGS, f.deps);
    expect(built).toEqual([{ FROM_PLAN: "yes" }]);
    expect(result.recipe.env).toEqual({ FROM_PLAN: "yes" });
  });

  it("leaves no env key on an env-free planned candidate", async () => {
    const built: Array<Record<string, unknown>> = [];
    const f = fakes({ ladder: { kind: "candidates", candidates: [recipe()] } });
    const inner = f.deps.buildAndStart!;
    f.deps.buildAndStart = async (sandbox, recipeToRun) => {
      built.push(recipeToRun as unknown as Record<string, unknown>);
      return inner(sandbox, recipeToRun);
    };

    await resolveAndStart(ARGS, f.deps);
    expect(built).toHaveLength(1);
    expect("env" in built[0]).toBe(false);
  });
});

describe("resolveAndStart — an empty environment is an absent one, everywhere", () => {
  // `{}` is truthy, so "copy it when it is there" and "copy it when there is
  // something in it" are different rules, and only the second one holds the
  // contract. The backend cannot issue an empty map today — its candidates come
  // from the env-free cache or from the local candidates we already normalize —
  // so this is the boundary staying honest ahead of the case rather than after
  // it.
  it("drops a backend-planned `env: {}` instead of carrying it forward", async () => {
    const built: Array<Record<string, unknown>> = [];
    const session = fakeSession({
      candidates: [planned("c1", { env: {} })],
    });
    const f = fakes({
      ladder: { kind: "candidates", candidates: [recipe()] },
      session,
    });
    const inner = f.deps.buildAndStart!;
    f.deps.buildAndStart = async (sandbox, recipeToRun) => {
      built.push(recipeToRun as unknown as Record<string, unknown>);
      return inner(sandbox, recipeToRun);
    };

    const result = await resolveAndStart(ARGS, f.deps);
    expect(built).toHaveLength(1);
    expect("env" in built[0]).toBe(false);
    expect("env" in result.recipe).toBe(false);
  });
});
