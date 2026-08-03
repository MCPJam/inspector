import { describe, expect, it } from "vitest";
import {
  judgeListeners,
  resolveAndStart,
  RecipeStartError,
  type ResolveAndStartDeps,
} from "../resolve-and-start";
import { CheckStepError, type CheckSandbox } from "../sandbox";
import type { ResolvedRecipe } from "../resolver/index";
import type { ListenerReport } from "../sandbox-inspect";

// What this suite is actually protecting, in the order the review rounds
// produced the requirements:
//
//   1. ATTRIBUTION. An authoritative rung never falls through: broken config is
//      `recipe_invalid` (the author's), a failing build under a VALID one is
//      `build_failed`. A heuristic guess that fails is a MISS, never a red X.
//   2. INFRASTRUCTURE IS NEVER A MISS. Provision/lockdown/E2B failures abort
//      with `infra_error` instead of burning the remaining candidates.
//   3. A FRESH BOX PER CANDIDATE, with the previous one dead BEFORE the next is
//      provisioned.
//   4. LISTENER IDENTITY, ANCHORED AT SPAWN. A listener that is not the process
//      we started never turns a check green — and the identity it is compared
//      against comes from the spawn (`StartedServer.spawn`), so nothing the box
//      writes can forge it.

const ARGS = {
  triggerId: "trig-1",
  repoFullName: "acme/mcp-thing",
  prNumber: 7,
  headSha: "b".repeat(40),
};

const EMPTY_INPUTS = {
  mcpjamYaml: { kind: "absent" } as const,
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

/** The identity `buildAndStart` captured for the command it spawned. */
const SPAWN = { pid: 100, pgrp: 100 };

/** A listener that IS the spawned process. */
function goodReport(pid = SPAWN.pid): ListenerReport {
  return { processes: [{ pid, ppids: [], pgrp: pid }] };
}

type Fakes = {
  deps: Partial<ResolveAndStartDeps>;
  events: string[];
  boxes: CheckSandbox[];
};

/**
 * `scripted` maps a recipe's `start` command to what its attempt should do —
 * which is how a test says "candidate 1 fails to build, candidate 2 works"
 * without knowing anything about box plumbing.
 */
function fakes(options: {
  ladder: ReturnType<ResolveAndStartDeps["resolveLadder"]>;
  attempt?: (recipe: ResolvedRecipe, boxId: string) => void | never;
  listener?: (recipe: ResolvedRecipe) => ListenerReport | null;
  spawn?: { pid: number; pgrp: number | null };
  provision?: (index: number) => void | never;
  now?: () => number;
  maxCandidates?: number;
  budgetMs?: number;
}): Fakes {
  const events: string[] = [];
  const boxes: CheckSandbox[] = [];
  let provisioned = 0;

  const deps: Partial<ResolveAndStartDeps> = {
    provisionSandbox: async () => {
      provisioned += 1;
      options.provision?.(provisioned);
      const box = {
        sandboxId: `sb_${provisioned}`,
        getHost: (port: number) => `${port}-sb_${provisioned}.e2b.app`,
        commands: { run: async () => ({}) },
        updateNetwork: async () => {},
        kill: async () => {},
      } as unknown as CheckSandbox;
      boxes.push(box);
      events.push(`provision:${box.sandboxId}`);
      return box;
    },
    cloneAndCheckout: async (sandbox) => {
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
    resolveLadder: () => options.ladder,
    readResolverInputs: async () => EMPTY_INPUTS,
    inspectListener: async (_sandbox, args) => {
      events.push(`inspect:${args.port}`);
      return options.listener
        ? options.listener(recipe({ port: args.port }))
        : goodReport();
    },
    onSandbox: () => {},
    assertLeaseHeld: () => {},
    ...(options.now ? { now: options.now } : {}),
    ...(options.maxCandidates !== undefined
      ? { maxCandidates: options.maxCandidates }
      : {}),
    ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
  };

  return { deps, events, boxes };
}

async function failureOf(promise: Promise<unknown>): Promise<RecipeStartError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof RecipeStartError) return error;
    throw error;
  }
  throw new Error("expected the resolution to fail");
}

describe("resolveAndStart — authoritative rungs", () => {
  it("reports recipe_invalid for a present-but-broken mcpjam.yaml, and runs nothing", async () => {
    // The real ladder, so the mapping from its `RecipeResolutionError` to the
    // outcome is exercised rather than restated.
    const f = fakes({ ladder: { kind: "candidates", candidates: [] } });
    delete f.deps.resolveLadder;
    f.deps.readResolverInputs = async () => ({
      ...EMPTY_INPUTS,
      mcpjamYaml: {
        kind: "present",
        text: "version: 1\nchecks:\n  build: npm ci\n",
      },
    });

    const error = await failureOf(resolveAndStart(ARGS, f.deps));
    expect(error.outcome).toBe("recipe_invalid");
    expect(error.message).toContain("mcpjam.yaml");
    // Nothing was built: a broken declaration is not a licence to guess.
    expect(f.events.some((e) => e.startsWith("buildAndStart"))).toBe(false);
    expect(f.events).toContain("kill:sb_1");
  });

  it("reports recipe_invalid for an OVER-CAP mcpjam.yaml, and never falls through", async () => {
    // The defect this pins: the sandbox reader cannot pull an unbounded file
    // across the command channel, and reporting "absent" made an oversized
    // (therefore invalid) declared config look like no declaration at all — so
    // the ladder guessed, ran a command nobody wrote, and reported the result
    // under the author's name. `resolveLadder` is the REAL one here, so the
    // whole path from reader to outcome is exercised.
    const f = fakes({ ladder: { kind: "candidates", candidates: [] } });
    delete f.deps.resolveLadder;
    f.deps.readResolverInputs = async () => ({
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
    });

    const error = await failureOf(resolveAndStart(ARGS, f.deps));
    expect(error.outcome).toBe("recipe_invalid");
    expect(error.message).toContain("mcpjam.yaml");
    expect(error.message).toContain("limit for declared config");
    // Nothing was built: the fall-through is the bug, not the fix.
    expect(f.events.some((e) => e.startsWith("buildAndStart"))).toBe(false);
  });

  it("reports build_failed — not a miss — under a VALID authoritative recipe", async () => {
    const declared = recipe({ rung: "declared", ownershipProof: "verified" });
    const f = fakes({
      ladder: { kind: "authoritative", recipe: declared },
      attempt: () => {
        throw new CheckStepError(
          "build_failed",
          "build command exited 1",
          "```text\nboom\n```"
        );
      },
    });

    const error = await failureOf(resolveAndStart(ARGS, f.deps));
    expect(error.outcome).toBe("build_failed");
    expect(error.provenance).toEqual({
      recipeRung: "declared",
      recipeEvidence: declared.evidence,
    });
    // No fall-through: exactly one attempt, in exactly one box.
    expect(f.events.filter((e) => e.startsWith("buildAndStart"))).toHaveLength(
      1
    );
    expect(f.boxes).toHaveLength(1);
  });

  it("blames the declared recipe — server_unhealthy — when a squatter holds the port", async () => {
    // Authoritative rungs do not fall through, so the only question is which
    // verdict the author sees. `recipe_unresolvable` would be false (we DID
    // resolve it) and `recipe_invalid` would be false (it parsed); what actually
    // happened is that the declared server did not serve.
    const declared = recipe({ rung: "declared", ownershipProof: "verified" });
    const f = fakes({
      ladder: { kind: "authoritative", recipe: declared },
      listener: () => ({
        processes: [{ pid: 555, ppids: [1], pgrp: 42 }],
      }),
    });

    const error = await failureOf(resolveAndStart(ARGS, f.deps));
    expect(error.outcome).toBe("server_unhealthy");
    expect(error.detailsMarkdown).toContain(
      "not the server your `start` command"
    );
  });

  it("returns the running server without restarting it", async () => {
    const declared = recipe({ rung: "override", ownershipProof: "verified" });
    const f = fakes({ ladder: { kind: "authoritative", recipe: declared } });

    const result = await resolveAndStart(ARGS, f.deps);
    expect(result.provenance.recipeRung).toBe("override");
    expect(result.sandbox.sandboxId).toBe("sb_1");
    expect(result.started.url).toBe("https://3001-sb_1.e2b.app/mcp");
    // The winning box is the one that stays alive.
    expect(f.events).not.toContain("kill:sb_1");
  });
});

describe("resolveAndStart — heuristic candidates", () => {
  const candidateA = recipe({ start: "npm start", evidence: ["A"] });
  const candidateB = recipe({ start: "node dist/server.js", evidence: ["B"] });

  it("kills candidate A's box BEFORE provisioning candidate B's, and returns B", async () => {
    const f = fakes({
      ladder: { kind: "candidates", candidates: [candidateA, candidateB] },
      attempt: (built) => {
        if (built.start === candidateA.start) {
          throw new CheckStepError("build_failed", "exit 1");
        }
      },
    });

    const result = await resolveAndStart(ARGS, f.deps);
    expect(result.recipe.start).toBe(candidateB.start);
    expect(result.sandbox.sandboxId).toBe("sb_2");
    expect(f.boxes).toHaveLength(2);

    // The ordering IS the requirement: A's box must be gone before B's exists,
    // or B builds beside A's leftovers with egress already revoked.
    expect(f.events.indexOf("kill:sb_1")).toBeGreaterThan(-1);
    expect(f.events.indexOf("kill:sb_1")).toBeLessThan(
      f.events.indexOf("provision:sb_2")
    );
    expect(f.events).toContain("buildAndStart:sb_2:node dist/server.js");
    // And B's build ran in B's own box, never in A's.
    expect(f.events).not.toContain("buildAndStart:sb_1:node dist/server.js");
  });

  it("reports recipe_unresolvable — neutral — when every candidate fails", async () => {
    const f = fakes({
      ladder: { kind: "candidates", candidates: [candidateA, candidateB] },
      attempt: () => {
        throw new CheckStepError("server_unhealthy", "never answered");
      },
    });

    const error = await failureOf(resolveAndStart(ARGS, f.deps));
    // NOT `server_unhealthy`: nobody asked us to run those commands, so the PR
    // must not wear the failure of our guesses.
    expect(error.outcome).toBe("recipe_unresolvable");
    expect(error.detailsMarkdown).toContain("mcpjam.yaml");
    expect(f.boxes).toHaveLength(2);
    // Every box is dead on the failure path.
    expect(f.events).toContain("kill:sb_1");
    expect(f.events).toContain("kill:sb_2");
  });

  it("aborts with infra_error on a provision failure, and tries no further candidates", async () => {
    const f = fakes({
      ladder: { kind: "candidates", candidates: [candidateA, candidateB] },
      attempt: (built) => {
        if (built.start === candidateA.start) {
          throw new CheckStepError("build_failed", "exit 1");
        }
      },
      provision: (index) => {
        if (index === 2) throw new CheckStepError("infra_error", "E2B 503");
      },
    });

    await expect(resolveAndStart(ARGS, f.deps)).rejects.toMatchObject({
      outcome: "infra_error",
    });
    // Candidate B never ran: an outage consumed as a miss would spend the whole
    // ladder rediscovering it and then conclude a neutral verdict.
    expect(f.events.filter((e) => e.startsWith("buildAndStart"))).toHaveLength(
      1
    );
  });

  it("aborts with infra_error when the egress lockdown fails mid-candidate", async () => {
    const f = fakes({
      ladder: { kind: "candidates", candidates: [candidateA, candidateB] },
      attempt: () => {
        throw new CheckStepError(
          "infra_error",
          "failed to disable sandbox egress before starting PR code"
        );
      },
    });

    await expect(resolveAndStart(ARGS, f.deps)).rejects.toMatchObject({
      outcome: "infra_error",
    });
    expect(f.boxes).toHaveLength(1);
    expect(f.events).toContain("kill:sb_1");
  });

  it("stops at MAX_CANDIDATES even when the detector offered more", async () => {
    const many = [1, 2, 3, 4, 5].map((n) =>
      recipe({ start: `node ${n}.js`, evidence: [`c${n}`] })
    );
    const f = fakes({
      ladder: { kind: "candidates", candidates: many },
      attempt: () => {
        throw new CheckStepError("build_failed", "exit 1");
      },
      maxCandidates: 3,
    });

    const error = await failureOf(resolveAndStart(ARGS, f.deps));
    expect(error.outcome).toBe("recipe_unresolvable");
    expect(f.boxes).toHaveLength(3);
  });

  it("stops when the wall-clock budget is spent, rather than starting another box", async () => {
    let clock = 0;
    const f = fakes({
      ladder: {
        kind: "candidates",
        candidates: [candidateA, candidateB, recipe({ start: "node c.js" })],
      },
      attempt: () => {
        // Each attempt costs twelve minutes — more than the budget below, so
        // the second candidate must not be started at all.
        clock += 12 * 60_000;
        throw new CheckStepError("build_failed", "exit 1");
      },
      now: () => clock,
      budgetMs: 10 * 60_000,
    });

    const error = await failureOf(resolveAndStart(ARGS, f.deps));
    expect(error.outcome).toBe("recipe_unresolvable");
    expect(error.detailsMarkdown).toContain("time budget");
    // One attempt ran, the budget was spent, and no second box was paid for.
    expect(f.boxes).toHaveLength(1);
  });
});

describe("resolveAndStart — runtime verification", () => {
  const candidateA = recipe({ start: "node a.js", evidence: ["A"] });
  const candidateB = recipe({ start: "node b.js", evidence: ["B"] });

  it("discards a candidate whose listener is not the process we spawned", async () => {
    // The install-hook class: `"prepare": "nohup acme-server &"` squats the port
    // and answers our probe while the start command never binds.
    let attempt = 0;
    const f = fakes({
      ladder: { kind: "candidates", candidates: [candidateA, candidateB] },
    });
    f.deps.inspectListener = async () => {
      attempt += 1;
      return attempt === 1
        ? { processes: [{ pid: 777, ppids: [1], pgrp: 31 }] }
        : goodReport();
    };

    const result = await resolveAndStart(ARGS, f.deps);
    expect(result.recipe.start).toBe(candidateB.start);
  });

  it("cannot be fooled by a squatter that FORGES our pid inside the box", async () => {
    // The adversarial case the pid file created. A squatter that writes
    // `/tmp/mcp-server.pid` — or names any pid it likes anywhere in the box —
    // changes nothing here, because the expected identity is the one
    // `buildAndStart` captured at spawn and it never leaves this process.
    const f = fakes({
      ladder: { kind: "candidates", candidates: [candidateA] },
      // The real spawn produced pid 100.
      spawn: { pid: 100, pgrp: 100 },
      // The squatter is pid 900 in its own group, and would have claimed to be
      // pid 900 in a pid file it controls. The report carries only kernel facts.
      listener: () => ({ processes: [{ pid: 900, ppids: [1], pgrp: 900 }] }),
    });

    const error = await failureOf(resolveAndStart(ARGS, f.deps));
    expect(error.outcome).toBe("recipe_unresolvable");
    // And the box was never asked to supply the pid we compare against.
    expect(f.events).toContain("inspect:3001");
  });

  it("asks the box only which port to look at — never who to look for", async () => {
    let seen: unknown = null;
    const f = fakes({
      ladder: { kind: "candidates", candidates: [candidateA] },
    });
    f.deps.inspectListener = async (_sandbox, args) => {
      seen = args;
      return goodReport();
    };
    await resolveAndStart(ARGS, f.deps);
    expect(seen).toEqual({ port: 3001 });
  });

  it("treats an unreadable inspection as infra_error, never as a pass or a miss", async () => {
    const f = fakes({
      ladder: { kind: "candidates", candidates: [candidateA, candidateB] },
      listener: () => null,
    });

    await expect(resolveAndStart(ARGS, f.deps)).rejects.toMatchObject({
      outcome: "infra_error",
    });
    // Not consumed as a miss: candidate B never ran.
    expect(f.boxes).toHaveLength(1);
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
    // THE case the process-group fallback exists for, and the one the previous
    // test for it never actually exercised: a double-forked server is reparented
    // to init (`ppids: [1]`), so ancestry is lost, and the supervisor we spawned
    // has EXITED — so `/proc/<spawn pid>` does not exist and the report says
    // nothing at all about pid 100. The only thing left that can identify this
    // process is the group we recorded at spawn time. Reading the group out of
    // the box at this moment, as an earlier revision did, returns null here by
    // construction, and the fallback could never fire.
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
