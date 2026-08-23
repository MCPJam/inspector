import { describe, expect, it, vi } from "vitest";
import {
  computeRunTargets,
  PlatformApiClient,
  PlatformApiError,
  runEvalCaseOperation,
  runEvalSuiteOperation,
} from "../../src/platform/index.js";

/**
 * WHICH TARGETS a run launches, and what it costs to get that wrong.
 *
 * The rule these cover is that fan-out is EXPLICIT: a bare run on an ambiguous
 * suite refuses rather than guessing, because every guess here is a guess about
 * how much of the caller's money to spend. The other half is that every
 * selector is resolved AND checked against the suite's attachments before the
 * first request — a fan-out issues one launch per target, so a bad target
 * discovered late is a bad target discovered after its siblings started.
 */

const PROJECT = {
  id: "project-1",
  name: "Acme",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 2,
};

const SUITE = {
  id: "suite-1",
  name: "Smoke",
  description: null,
  projectId: PROJECT.id,
  createdAt: 1,
  updatedAt: 2,
};

const ENVIRONMENTS = [
  {
    id: "env-stg",
    projectId: PROJECT.id,
    name: "Staging",
    hostId: "host-1",
    revision: 4,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  },
  {
    id: "env-prod",
    projectId: PROJECT.id,
    name: "Prod",
    hostId: "host-2",
    revision: 9,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  },
];

const CASES = [
  { id: "case-1", suiteId: "suite-1", title: "echo works" },
  { id: "case-2", suiteId: "suite-1", title: "search works" },
];

function suiteDetail(
  overrides: Partial<{
    environmentIds: string[];
    hosts: Array<{ id: string; name: string }>;
  }> = {},
): Record<string, unknown> {
  return {
    id: SUITE.id,
    name: SUITE.name,
    description: null,
    projectId: PROJECT.id,
    environment: { servers: [] },
    executionConfig: null,
    hosts: overrides.hosts ?? [],
    environmentIds: overrides.environmentIds ?? [],
    settings: {},
    schedule: {},
    createdAt: 1,
    updatedAt: 2,
  };
}

interface Fixture {
  detail?: Record<string, unknown>;
  /** Target ids whose grouped launch should come back as a failed entry. */
  groupFailures?: Record<string, { code: string; message: string }>;
  /** Model a server with no grouped-launch endpoint. */
  noRunGroupEndpoint?: boolean;
  /** Model the LIVE route answering 404 for a real reason (suite deleted). */
  groupSuiteMissing?: boolean;
}

function makeClient(fixture: Fixture = {}) {
  const fetchMock = vi.fn(async (target: unknown, init?: RequestInit) => {
    const path = new URL(String(target)).pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/v1/projects") return Response.json({ items: [PROJECT] });
    if (/\/eval-suites$/.test(path)) return Response.json({ items: [SUITE] });
    if (/\/eval-suites\/[^/]+$/.test(path) && method === "GET") {
      return Response.json(fixture.detail ?? suiteDetail());
    }
    if (/\/eval-suites\/[^/]+\/cases$/.test(path)) {
      return Response.json({ items: CASES });
    }
    if (/\/environments$/.test(path)) {
      return Response.json({ items: ENVIRONMENTS });
    }
    if (/\/environments\/[^/]+$/.test(path) && method === "GET") {
      const id = path.split("/").pop()!;
      const match = ENVIRONMENTS.find((item) => item.id === id);
      if (!match) {
        return Response.json(
          { code: "NOT_FOUND", message: "Environment not found" },
          { status: 404 },
        );
      }
      return Response.json(match);
    }
    if (/\/eval-runs$/.test(path) && method === "POST") {
      const body = JSON.parse(String(init?.body)) as {
        environmentId?: string;
      };
      return Response.json(
        {
          runId: "run-single",
          suiteId: SUITE.id,
          status: "running",
          caseUpsert: { committed: [], failed: [] },
          servers: [{ id: "server-saved", name: "Saved" }],
          environment: body.environmentId
            ? { id: body.environmentId, name: "Staging", revision: 4 }
            : null,
        },
        { status: 202 },
      );
    }
    if (/\/eval-run-groups$/.test(path) && method === "POST") {
      if (fixture.noRunGroupEndpoint) {
        // A REAL route miss: the framework answers before any handler, so
        // there is no v1 error envelope — which is the only thing that
        // distinguishes it from the live route's own 404s.
        return new Response("404 Not Found", { status: 404 });
      }
      if (fixture.groupSuiteMissing) {
        return Response.json(
          {
            code: "NOT_FOUND",
            message: "Eval suite not found",
            details: { reason: "SUITE_NOT_FOUND" },
          },
          { status: 404 },
        );
      }
      const body = JSON.parse(String(init?.body)) as {
        suiteId: string;
        targets: Array<{ environmentId?: string; namedHostId?: string }>;
      };
      let started = 0;
      let failed = 0;
      const entries = body.targets.map((entryTarget, index) => {
        const id = entryTarget.environmentId ?? entryTarget.namedHostId ?? "";
        const failure = fixture.groupFailures?.[id];
        if (failure) {
          failed += 1;
          return { target: entryTarget, status: "failed", error: failure };
        }
        started += 1;
        return {
          target: entryTarget,
          status: "started",
          runId: `run-${index + 1}`,
          runStatus: "running",
          servers: [{ id: "server-saved", name: "Saved" }],
          environment: entryTarget.environmentId
            ? { id: entryTarget.environmentId, name: "Staging", revision: 4 }
            : null,
        };
      });
      const first = entries.find((entry) => entry.status === "started") as
        | { runId: string }
        | undefined;
      return Response.json(
        {
          runGroupId: "group-1",
          suiteId: body.suiteId,
          outcome:
            started === 0 ? "failed" : failed > 0 ? "partial" : "started",
          startedCount: started,
          failedCount: failed,
          targets: entries,
          ...(first ? { runId: first.runId, status: "running" } : {}),
        },
        { status: 202 },
      );
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.test/api/v1",
    getAuth: () => "t",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
}

function bodiesTo(fetchMock: ReturnType<typeof vi.fn>, suffix: string) {
  return fetchMock.mock.calls
    .filter(([target]) => String(target).endsWith(suffix))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

describe("computeRunTargets", () => {
  it("runs the saved selection when nothing is attached", () => {
    expect(
      computeRunTargets({ attachedEnvironments: [], attachedHosts: [] }),
    ).toEqual({ kind: "single" });
  });

  it("runs the LONE attachment automatically — not a guess, the only option", () => {
    expect(
      computeRunTargets({
        attachedEnvironments: [],
        attachedHosts: [{ id: "h1", name: "Claude" }],
      }),
    ).toEqual({
      kind: "single",
      target: { kind: "host", id: "h1", name: "Claude" },
    });
  });

  it("refuses to choose when several are attached", () => {
    const plan = computeRunTargets({
      attachedEnvironments: [{ id: "e1" }],
      attachedHosts: [{ id: "h1", name: "Claude" }],
    });
    expect(plan.kind).toBe("target-required");
  });

  it("expands ONE axis on allAttached, environments winning over hosts", () => {
    // An environment already resolves a host, so a cross product would execute
    // combinations the suite never described.
    expect(
      computeRunTargets({
        attachedEnvironments: [{ id: "e1" }, { id: "e2" }],
        attachedHosts: [{ id: "h1", name: "Claude" }],
        allAttached: true,
      }),
    ).toEqual({
      kind: "group",
      targets: [
        { kind: "environment", id: "e1" },
        { kind: "environment", id: "e2" },
      ],
    });
  });

  it("keeps allAttached working on a suite with nothing attached", () => {
    // "Run everything" on the simplest suite there is must not be an error.
    expect(
      computeRunTargets({
        attachedEnvironments: [],
        attachedHosts: [],
        allAttached: true,
      }),
    ).toEqual({ kind: "single" });
  });

  it("deduplicates explicit selectors by resolved id", () => {
    expect(
      computeRunTargets({
        attachedEnvironments: [{ id: "e1" }, { id: "e2" }],
        attachedHosts: [],
        selectedEnvironments: [{ id: "e1" }, { id: "e1" }],
      }),
    ).toEqual({ kind: "single", target: { kind: "environment", id: "e1" } });
  });

  it("REFUSES two named axes rather than silently picking one", () => {
    // Reachable only by a direct caller — the operations reject this pair
    // first — and a direct caller must not get a winner. Two named axes are
    // two different launches, and dropping one drops runs that were asked for.
    expect(
      computeRunTargets({
        attachedEnvironments: [{ id: "e1" }],
        attachedHosts: [{ id: "h1" }],
        selectedEnvironments: [{ id: "e1" }],
        selectedHosts: [{ id: "h1" }],
      }),
    ).toEqual({
      kind: "target-required",
      attachedEnvironments: [{ kind: "environment", id: "e1" }],
      attachedHosts: [{ kind: "host", id: "h1" }],
    });
  });

  it("treats an explicit server override as a single legacy run", () => {
    expect(
      computeRunTargets({
        attachedEnvironments: [{ id: "e1" }, { id: "e2" }],
        attachedHosts: [],
        serverIds: ["s1"],
      }),
    ).toEqual({ kind: "single", serverIds: ["s1"] });
  });
});

describe("run_eval_suite target selection", () => {
  it("sends one bare POST for a suite with no attachments", async () => {
    const { client, fetchMock } = makeClient();
    const result = await runEvalSuiteOperation.execute(
      { suite: "Smoke" },
      { client },
    );
    expect(bodiesTo(fetchMock, "/eval-runs")).toEqual([{ suiteId: "suite-1" }]);
    expect(result.outcome).toBe("started");
    expect(result.runId).toBe("run-single");
    expect(result.targets).toHaveLength(1);
  });

  it("auto-sends namedHostId for a suite with exactly ONE attached host", async () => {
    // The mis-attribution fix: this used to run under the suite's default host
    // config and report a result for a host that never ran.
    const { client, fetchMock } = makeClient({
      detail: suiteDetail({ hosts: [{ id: "host-claude", name: "Claude" }] }),
    });
    const result = await runEvalSuiteOperation.execute(
      { suite: "Smoke" },
      { client },
    );
    expect(bodiesTo(fetchMock, "/eval-runs")).toEqual([
      { suiteId: "suite-1", namedHostId: "host-claude" },
    ]);
    expect(result.targets[0]).toMatchObject({
      status: "started",
      host: { id: "host-claude", name: "Claude" },
    });
  });

  it("throws TARGET_REQUIRED — naming the choices — with ZERO run requests", async () => {
    const { client, fetchMock } = makeClient({
      detail: suiteDetail({
        hosts: [
          { id: "host-claude", name: "Claude" },
          { id: "host-chatgpt", name: "ChatGPT" },
        ],
      }),
    });
    const error = await runEvalSuiteOperation
      .execute({ suite: "Smoke" }, { client })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformApiError);
    const message = (error as PlatformApiError).message;
    expect(message).toContain("TARGET_REQUIRED");
    expect(message).toContain("Claude");
    expect(message).toContain("ChatGPT");
    expect(message).toContain("allAttached");
    expect(bodiesTo(fetchMock, "/eval-runs")).toHaveLength(0);
    expect(bodiesTo(fetchMock, "/eval-run-groups")).toHaveLength(0);
  });

  it("names the ENVIRONMENTS to choose between, not just their ids", async () => {
    // The suite detail carries attached environment ids and no names, so a
    // refusal built from it alone reads "env-stg, env-prod" — which is not
    // what the caller knows them as, and not what they would type back.
    const { client } = makeClient({
      detail: suiteDetail({ environmentIds: ["env-stg", "env-prod"] }),
    });
    const error = await runEvalSuiteOperation
      .execute({ suite: "Smoke" }, { client })
      .catch((caught: unknown) => caught);
    const message = (error as PlatformApiError).message;
    expect(message).toContain("TARGET_REQUIRED");
    expect(message).toContain('"Staging" (env-stg)');
    expect(message).toContain('"Prod" (env-prod)');
  });

  it("fans out through ONE batch request on allAttached, in attach order", async () => {
    const { client, fetchMock } = makeClient({
      detail: suiteDetail({
        hosts: [
          { id: "host-claude", name: "Claude" },
          { id: "host-chatgpt", name: "ChatGPT" },
        ],
      }),
    });
    const result = await runEvalSuiteOperation.execute(
      { suite: "Smoke", allAttached: true },
      { client },
    );
    expect(bodiesTo(fetchMock, "/eval-run-groups")).toEqual([
      {
        suiteId: "suite-1",
        targets: [
          { namedHostId: "host-claude" },
          { namedHostId: "host-chatgpt" },
        ],
      },
    ]);
    // Never N single launches: those would each charge their own slot.
    expect(bodiesTo(fetchMock, "/eval-runs")).toHaveLength(0);
    expect(result.outcome).toBe("started");
    expect(result.startedCount).toBe(2);
    expect(result.runGroupId).toBe("group-1");
    // Deprecated mirrors point at the first started run.
    expect(result.runId).toBe("run-1");
  });

  it("prefers the environment axis over hosts when both are attached", async () => {
    const { client, fetchMock } = makeClient({
      detail: suiteDetail({
        environmentIds: ["env-stg", "env-prod"],
        hosts: [{ id: "host-claude", name: "Claude" }],
      }),
    });
    await runEvalSuiteOperation.execute(
      { suite: "Smoke", allAttached: true },
      { client },
    );
    expect(bodiesTo(fetchMock, "/eval-run-groups")[0].targets).toEqual([
      { environmentId: "env-stg" },
      { environmentId: "env-prod" },
    ]);
  });

  it("narrows and deduplicates explicit environment selectors", async () => {
    const { client, fetchMock } = makeClient({
      detail: suiteDetail({ environmentIds: ["env-stg", "env-prod"] }),
    });
    await runEvalSuiteOperation.execute(
      { suite: "Smoke", environments: ["Staging", "env-stg", "Prod"] },
      { client },
    );
    expect(bodiesTo(fetchMock, "/eval-run-groups")[0].targets).toEqual([
      { environmentId: "env-stg" },
      { environmentId: "env-prod" },
    ]);
  });

  it("rejects an UNATTACHED selector before any launch", async () => {
    const { client, fetchMock } = makeClient({
      detail: suiteDetail({ environmentIds: ["env-stg"] }),
    });
    const error = await runEvalSuiteOperation
      .execute({ suite: "Smoke", environments: ["Staging", "Prod"] }, { client })
      .catch((caught: unknown) => caught);
    expect((error as PlatformApiError).message).toContain("not attached");
    expect(bodiesTo(fetchMock, "/eval-run-groups")).toHaveLength(0);
    expect(bodiesTo(fetchMock, "/eval-runs")).toHaveLength(0);
  });

  it("lands every knob in both the single and the batch body", async () => {
    const knobs = {
      iterations: 3,
      cases: ["echo works"],
      excludeSkills: true,
      notes: "nightly",
      minPassRate: 80,
      matchOptions: { toolCallOrder: "exact" as const },
      idempotencyKey: "key-1",
    };
    const expected = {
      suiteId: "suite-1",
      iterationOverride: 3,
      caseIds: ["case-1"],
      matchOptionsOverride: { toolCallOrder: "exact" },
      skillsOverride: "exclude",
      notes: "nightly",
      passCriteria: { minimumPassRate: 80 },
      idempotencyKey: "key-1",
    };

    const single = makeClient();
    await runEvalSuiteOperation.execute({ suite: "Smoke", ...knobs }, single);
    expect(bodiesTo(single.fetchMock, "/eval-runs")).toEqual([expected]);

    const group = makeClient({
      detail: suiteDetail({
        hosts: [
          { id: "host-claude", name: "Claude" },
          { id: "host-chatgpt", name: "ChatGPT" },
        ],
      }),
    });
    await runEvalSuiteOperation.execute(
      { suite: "Smoke", allAttached: true, ...knobs },
      group,
    );
    expect(bodiesTo(group.fetchMock, "/eval-run-groups")).toEqual([
      {
        ...expected,
        targets: [
          { namedHostId: "host-claude" },
          { namedHostId: "host-chatgpt" },
        ],
      },
    ]);
  });

  it("rejects refreshSnapshot on a multi-target launch, spending nothing", async () => {
    // It PERSISTS one snapshot on the suite; several runs racing to write it
    // would leave the suite pinned to whichever finished last.
    const { client, fetchMock } = makeClient({
      detail: suiteDetail({
        hosts: [
          { id: "host-claude", name: "Claude" },
          { id: "host-chatgpt", name: "ChatGPT" },
        ],
      }),
    });
    const error = await runEvalSuiteOperation
      .execute(
        { suite: "Smoke", allAttached: true, refreshSnapshot: true },
        { client },
      )
      .catch((caught: unknown) => caught);
    expect((error as PlatformApiError).message).toContain("refreshSnapshot");
    expect(bodiesTo(fetchMock, "/eval-run-groups")).toHaveLength(0);
  });

  it("rejects a server override against the PLURAL environment selector too", async () => {
    // The singular guard covered `environment`; without the plural rule this
    // pair cleared every check, and the override then suppressed the
    // suite-detail read — so the caller was told the suite "has no
    // environments at all" about a suite that has the named one attached.
    const { client, fetchMock } = makeClient({
      detail: suiteDetail({ environmentIds: ["env-stg"] }),
    });
    const error = await runEvalSuiteOperation
      .execute(
        { suite: "Smoke", environments: ["Staging"], servers: ["alpha"] },
        { client },
      )
      .catch((caught: unknown) => caught);
    expect((error as PlatformApiError).message).toContain(
      "environment or servers",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects allAttached combined with an explicit selector", async () => {
    const { client, fetchMock } = makeClient({
      detail: suiteDetail({ environmentIds: ["env-stg"] }),
    });
    const error = await runEvalSuiteOperation
      .execute(
        { suite: "Smoke", allAttached: true, environment: "Staging" },
        { client },
      )
      .catch((caught: unknown) => caught);
    expect((error as PlatformApiError).message).toContain("cannot both be");
    // Guards run before ANY request, including the project listing.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects the environment and host axes together, and singular with plural", async () => {
    const { client } = makeClient();
    for (const input of [
      { suite: "Smoke", environment: "Staging", host: "Claude" },
      { suite: "Smoke", environment: "Staging", environments: ["Prod"] },
      { suite: "Smoke", host: "Claude", hosts: ["ChatGPT"] },
      { suite: "Smoke", host: "Claude", servers: ["echo"] },
      // The PLURAL environment field too, not just the singular one. Without
      // this guard the combination fell through to the attachment check, which
      // — having skipped the suite read because servers were overridden —
      // reported "this suite has no environments at all" about a suite that
      // has them, and told the caller to attach one they already had.
      { suite: "Smoke", environments: ["Staging"], servers: ["echo"] },
      { suite: "Smoke", environment: "Staging", servers: ["echo"] },
    ]) {
      const error = await runEvalSuiteOperation
        .execute(input, { client })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PlatformApiError);
      expect((error as PlatformApiError).code).toBe("VALIDATION_ERROR");
    }
  });

  it("says SERVERS-OR-ENVIRONMENTS when both are sent, not 'nothing is attached'", async () => {
    const { client, fetchMock } = makeClient({
      detail: suiteDetail({ environmentIds: ["env-stg"] }),
    });
    const error = await runEvalSuiteOperation
      .execute(
        { suite: "Smoke", environments: ["Staging"], servers: ["echo"] },
        { client },
      )
      .catch((caught: unknown) => caught);
    expect((error as PlatformApiError).message).toContain(
      "closed server set",
    );
    expect((error as PlatformApiError).message).not.toContain("Attach it");
    expect(bodiesTo(fetchMock, "/eval-runs")).toHaveLength(0);
    expect(bodiesTo(fetchMock, "/eval-run-groups")).toHaveLength(0);
  });

  it("returns a PARTIAL receipt rather than throwing away the siblings that started", async () => {
    const { client } = makeClient({
      detail: suiteDetail({
        hosts: [
          { id: "host-claude", name: "Claude" },
          { id: "host-chatgpt", name: "ChatGPT" },
        ],
      }),
      groupFailures: {
        "host-chatgpt": { code: "VALIDATION_ERROR", message: "no servers" },
      },
    });
    const result = await runEvalSuiteOperation.execute(
      { suite: "Smoke", allAttached: true },
      { client },
    );
    expect(result.outcome).toBe("partial");
    expect(result.startedCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.targets[1]).toEqual({
      status: "failed",
      host: { id: "host-chatgpt", name: "ChatGPT" },
      error: { code: "VALIDATION_ERROR", message: "no servers" },
    });
    // Mirrors describe the first STARTED run, not the first entry.
    expect(result.runId).toBe("run-1");
  });

  it("NAMES the environment that failed, not just that something did", async () => {
    // A receipt whose failed entry carries no target is unactionable: the CLI
    // renders it as "Failed: target", and the caller cannot tell which of
    // several environments to retry. A failed target never launched, so there
    // is no pinned revision to report — but the id and the name the caller
    // selected by are both known here.
    const { client } = makeClient({
      detail: suiteDetail({ environmentIds: ["env-stg", "env-prod"] }),
      groupFailures: {
        "env-prod": {
          code: "ENVIRONMENT_REVISION_CONFLICT",
          message: "revision moved",
        },
      },
    });
    const result = await runEvalSuiteOperation.execute(
      { suite: "Smoke", allAttached: true },
      { client },
    );
    expect(result.outcome).toBe("partial");
    expect(result.targets[1]).toEqual({
      status: "failed",
      environment: { id: "env-prod", name: "Prod", revision: null },
      error: {
        code: "ENVIRONMENT_REVISION_CONFLICT",
        message: "revision moved",
      },
    });
  });

  it("RESOLVES with outcome failed when every target failed — it does not throw", async () => {
    // Throwing would discard the per-target reasons, which are the only thing
    // that tells the caller what to fix.
    const { client } = makeClient({
      detail: suiteDetail({
        hosts: [
          { id: "host-claude", name: "Claude" },
          { id: "host-chatgpt", name: "ChatGPT" },
        ],
      }),
      groupFailures: {
        "host-claude": { code: "VALIDATION_ERROR", message: "a" },
        "host-chatgpt": { code: "VALIDATION_ERROR", message: "b" },
      },
    });
    const result = await runEvalSuiteOperation.execute(
      { suite: "Smoke", allAttached: true },
      { client },
    );
    expect(result.outcome).toBe("failed");
    expect(result.startedCount).toBe(0);
    expect(result.targets.map((target) => target.status)).toEqual([
      "failed",
      "failed",
    ]);
    // Nothing started, so there is no run to mirror and none is invented.
    expect(result.runId).toBeUndefined();
  });

  it("explains a server too old for grouped launches instead of a raw NOT_FOUND", async () => {
    const { client } = makeClient({
      detail: suiteDetail({
        hosts: [
          { id: "host-claude", name: "Claude" },
          { id: "host-chatgpt", name: "ChatGPT" },
        ],
      }),
      noRunGroupEndpoint: true,
    });
    const error = await runEvalSuiteOperation
      .execute({ suite: "Smoke", allAttached: true }, { client })
      .catch((caught: unknown) => caught);
    expect((error as PlatformApiError).message).toContain("too old");
    expect((error as PlatformApiError).message).toContain("one at a time");
  });

  it("does NOT blame the server version for a real 404 from a live route", async () => {
    // The route 404s for reasons that have nothing to do with its existence —
    // the suite was deleted between resolving it and launching, or access was
    // revoked. Telling that caller to wait for an upgrade that already
    // happened sends them to fix the wrong thing.
    const { client } = makeClient({
      detail: suiteDetail({
        hosts: [
          { id: "host-claude", name: "Claude" },
          { id: "host-chatgpt", name: "ChatGPT" },
        ],
      }),
      groupSuiteMissing: true,
    });
    const error = await runEvalSuiteOperation
      .execute({ suite: "Smoke", allAttached: true }, { client })
      .catch((caught: unknown) => caught);
    expect((error as PlatformApiError).message).toBe("Eval suite not found");
    expect((error as PlatformApiError).message).not.toContain("too old");
  });
});

describe("run_eval_case host selection", () => {
  it("resolves an attached host by name and echoes it", async () => {
    const { client, fetchMock } = makeClient({
      detail: suiteDetail({ hosts: [{ id: "host-claude", name: "Claude" }] }),
    });
    const result = await runEvalCaseOperation.execute(
      { suite: "Smoke", case: "echo works", host: "Claude", iterations: 2 },
      { client },
    );
    expect(bodiesTo(fetchMock, "/eval-runs")).toEqual([
      {
        suiteId: "suite-1",
        caseIds: ["case-1"],
        namedHostId: "host-claude",
        iterationOverride: 2,
      },
    ]);
    expect(result.host).toEqual({ id: "host-claude", name: "Claude" });
  });

  it("does not read the suite detail when no host is named", async () => {
    // An optional selector must not tax the common path with an extra request.
    const { client, fetchMock } = makeClient();
    await runEvalCaseOperation.execute(
      { suite: "Smoke", case: "echo works" },
      { client },
    );
    const detailReads = fetchMock.mock.calls.filter(([target]) =>
      /\/eval-suites\/suite-1$/.test(new URL(String(target)).pathname),
    );
    expect(detailReads).toHaveLength(0);
  });
});

describe("run operations declare their hazard", () => {
  it("marks both launch operations as spend", () => {
    // Every surface reads this ONE facet instead of re-deriving "does this
    // cost money" from the operation name.
    expect(runEvalSuiteOperation.risk).toBe("spend");
    expect(runEvalCaseOperation.risk).toBe("spend");
  });
});
