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
//   4. THE TWO RUNTIME CHECKS. A listener that is not ours, or that runs code
//      from outside the checkout, never turns a check green.

const ARGS = {
  triggerId: "trig-1",
  repoFullName: "acme/mcp-thing",
  prNumber: 7,
  headSha: "b".repeat(40),
};

const EMPTY_INPUTS = {
  mcpjamYaml: null,
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

/** A listener that IS the spawned process, running checkout code. */
function goodReport(pid = 100): ListenerReport {
  return {
    expected: { pid, alive: true, pgrp: pid },
    processes: [
      {
        pid,
        ppids: [],
        pgrp: pid,
        cwd: "/home/user/repo",
        mainModule: "/home/user/repo/dist/index.js",
        mainModuleFromExe: false,
      },
    ],
  };
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
  startPid?: number | null;
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
      };
    },
    killSandbox: async (sandbox) => {
      events.push(`kill:${sandbox?.sandboxId ?? "none"}`);
    },
    resolveLadder: () => options.ladder,
    readResolverInputs: async () => EMPTY_INPUTS,
    readStartPid: async () =>
      options.startPid === undefined ? 100 : options.startPid,
    inspectListener: async (_sandbox, args) => {
      events.push(`inspect:${args.port}`);
      return options.listener
        ? options.listener(recipe({ port: args.port }))
        : goodReport(100);
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
      mcpjamYaml: "version: 1\nchecks:\n  build: npm ci\n",
    });

    const error = await failureOf(resolveAndStart(ARGS, f.deps));
    expect(error.outcome).toBe("recipe_invalid");
    expect(error.message).toContain("mcpjam.yaml");
    // Nothing was built: a broken declaration is not a licence to guess.
    expect(f.events.some((e) => e.startsWith("buildAndStart"))).toBe(false);
    expect(f.events).toContain("kill:sb_1");
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
        expected: { pid: 100, alive: true, pgrp: 100 },
        processes: [
          {
            pid: 555,
            ppids: [1],
            pgrp: 42,
            cwd: "/home/user/repo",
            mainModule: "/home/user/repo/node_modules/acme/server.js",
            mainModuleFromExe: false,
          },
        ],
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

  it("discards an unverified candidate whose listener runs node_modules code", async () => {
    // The corpus case: ~48% of resolved candidates are `unverified`, and a build
    // step can copy a published server into `dist/`. Only the running process
    // settles it.
    const f = fakes({
      ladder: { kind: "candidates", candidates: [candidateA, candidateB] },
      listener: (built) =>
        built.port === 3001 && built.mcpPath === "/mcp"
          ? {
              expected: { pid: 100, alive: true, pgrp: 100 },
              processes: [
                {
                  pid: 100,
                  ppids: [],
                  pgrp: 100,
                  cwd: "/home/user/repo",
                  mainModule:
                    "/home/user/repo/node_modules/@acme/server/bin.js",
                  mainModuleFromExe: false,
                },
              ],
            }
          : goodReport(100),
    });
    // Candidate B gets a clean verdict; A's listener is a dependency.
    let attempt = 0;
    f.deps.inspectListener = async () => {
      attempt += 1;
      return attempt === 1
        ? {
            expected: { pid: 100, alive: true, pgrp: 100 },
            processes: [
              {
                pid: 100,
                ppids: [],
                pgrp: 100,
                cwd: "/home/user/repo",
                mainModule: "/home/user/repo/node_modules/@acme/server/bin.js",
                mainModuleFromExe: false,
              },
            ],
          }
        : goodReport(100);
    };

    const result = await resolveAndStart(ARGS, f.deps);
    expect(result.recipe.start).toBe(candidateB.start);
    expect(f.boxes).toHaveLength(2);
  });

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
        ? {
            expected: { pid: 100, alive: true, pgrp: 100 },
            processes: [
              {
                pid: 777,
                ppids: [1],
                pgrp: 31,
                cwd: "/home/user/repo",
                mainModule: "/home/user/repo/dist/index.js",
                mainModuleFromExe: false,
              },
            ],
          }
        : goodReport(100);
    };

    const result = await resolveAndStart(ARGS, f.deps);
    expect(result.recipe.start).toBe(candidateB.start);
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

  it("treats a missing start pid the same way", async () => {
    const f = fakes({
      ladder: { kind: "candidates", candidates: [candidateA] },
      startPid: null,
    });
    await expect(resolveAndStart(ARGS, f.deps)).rejects.toMatchObject({
      outcome: "infra_error",
    });
  });
});

describe("judgeListeners", () => {
  const base = {
    pid: 200,
    ppids: [150, 100],
    pgrp: 100,
    cwd: "/home/user/repo",
    mainModule: "/home/user/repo/dist/index.js",
    mainModuleFromExe: false,
  };

  it("accepts a descendant of the spawned start command", () => {
    expect(
      judgeListeners(
        { expected: { pid: 100, alive: true, pgrp: 100 }, processes: [base] },
        { expectedPid: 100, requireOwnership: true }
      )
    ).toEqual({ status: "ok" });
  });

  it("accepts a reparented process that kept our process group", () => {
    // A double-forked server loses the ancestry link but not the group it was
    // born into — and an install hook's leftover was born under a DIFFERENT
    // `commands.run`, so the group still separates the two.
    expect(
      judgeListeners(
        {
          expected: { pid: 100, alive: true, pgrp: 100 },
          processes: [{ ...base, ppids: [1] }],
        },
        { expectedPid: 100, requireOwnership: false }
      )
    ).toEqual({ status: "ok" });
  });

  it("rejects a listener from another process group entirely", () => {
    const verdict = judgeListeners(
      {
        expected: { pid: 100, alive: true, pgrp: 100 },
        processes: [{ ...base, ppids: [1], pgrp: 55 }],
      },
      { expectedPid: 100, requireOwnership: false }
    );
    expect(verdict.status).toBe("mismatch");
  });

  it("rejects when ANY listener on the port is foreign", () => {
    // SO_REUSEPORT lets a squatter bind beside us, and the kernel decides which
    // one answers — so "one of them is ours" is not a property to rely on.
    const verdict = judgeListeners(
      {
        expected: { pid: 100, alive: true, pgrp: 100 },
        processes: [base, { ...base, pid: 900, ppids: [1], pgrp: 900 }],
      },
      { expectedPid: 100, requireOwnership: false }
    );
    expect(verdict.status).toBe("mismatch");
  });

  it("rejects checkout-external code even when the process is ours", () => {
    const verdict = judgeListeners(
      {
        expected: { pid: 100, alive: true, pgrp: 100 },
        processes: [{ ...base, mainModule: "/usr/lib/acme/server.js" }],
      },
      { expectedPid: 100, requireOwnership: true }
    );
    expect(verdict.status).toBe("mismatch");
    // The PATH is PR-derived and reaches check output; only the shape is named.
    expect(verdict.status === "mismatch" && verdict.reason).not.toContain(
      "/usr/lib/acme"
    );
  });

  it("does not mistake a `node_modules_backup` directory for a dependency", () => {
    expect(
      judgeListeners(
        {
          expected: { pid: 100, alive: true, pgrp: 100 },
          processes: [
            {
              ...base,
              mainModule: "/home/user/repo/node_modules_backup/index.js",
            },
          ],
        },
        { expectedPid: 100, requireOwnership: true }
      )
    ).toEqual({ status: "ok" });
  });

  it("says 'unknown' — never ok — when no process could be attributed", () => {
    const verdict = judgeListeners(
      { expected: { pid: 100, alive: true, pgrp: 100 }, processes: [] },
      { expectedPid: 100, requireOwnership: true }
    );
    expect(verdict.status).toBe("unknown");
  });

  it("says 'mismatch' when the listening process's code cannot be resolved", () => {
    const verdict = judgeListeners(
      {
        expected: { pid: 100, alive: true, pgrp: 100 },
        processes: [{ ...base, mainModule: null }],
      },
      { expectedPid: 100, requireOwnership: true }
    );
    // A candidate that was accepted BECAUSE its provenance was unproven does not
    // get to stay unproven at runtime too.
    expect(verdict.status).toBe("mismatch");
  });
});
