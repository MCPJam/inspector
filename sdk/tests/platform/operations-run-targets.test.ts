import { describe, expect, it, vi } from "vitest";
import {
  computeRunTargets,
  PlatformApiClient,
  PlatformApiError,
  getEvalRunDisclosureOperation,
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
  /** Model a backend that predates the disclosure contract (G4b). */
  disclosureUnavailable?: boolean;
  /** Model a disclosure fetch that hangs — never resolves until aborted. */
  disclosureStalls?: boolean;
  /** Calls observed, in order, across every route this fixture serves. */
  callOrder?: string[];
}

const DISCLOSURE_FIXTURE: Record<string, unknown> = {
  contractVersion: 1,
  computedAt: 1_700_000_000_000,
  digest: "deadbeef",
  execution: {
    engine: "emulated",
    sandbox: { engaged: false, because: "no sandbox needed" },
    locus: { known: true, hosted: false },
    models: [],
    modelsUnresolved: { reason: "not derivable in this fixture" },
  },
  analysis: [],
  capture: {
    captureLevel: "full",
    reportingMode: "standard",
    tiersImplemented: false,
    redaction: {
      kind: "credential-shaped",
      module: "convex/lib/evalIngestRedaction.ts",
      isDlp: false,
      limitation: "not DLP",
      appliesTo: [],
    },
    exportDefaults: {
      includeContent: false,
      ruleLocation: "convex/traceExport.ts",
      note: "redacted by default",
    },
  },
  retention: {
    planName: "free",
    policyDays: 30,
    source: "plan entitlements",
    enforced: true,
    enforcementBlockers: [],
    effectiveToday: "swept-after-policy-days",
    evidentiaryClasses: [],
    backupStatement: {
      vendor: "Convex",
      capturedAt: "2026-08-23",
      sourceUrl: "https://docs.convex.dev/database/backup-restore",
      statements: [],
    },
  },
  region: { stated: false, reason: "no deployment region is derivable" },
  subprocessors: [],
};

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
    if (/\/run-disclosure$/.test(path) && method === "GET") {
      fixture.callOrder?.push("getEvalRunDisclosure");
      if (fixture.disclosureStalls) {
        // Never resolves on its own — a real fetch, matching how native fetch
        // behaves under an AbortSignal: it settles only when the signal
        // aborts.
        return new Promise<Response>((_resolve, reject) => {
          const signal = (init as RequestInit | undefined)?.signal;
          signal?.addEventListener("abort", () => {
            const error = new Error("The operation was aborted");
            error.name = "AbortError";
            reject(error);
          });
        });
      }
      if (fixture.disclosureUnavailable) {
        return Response.json(
          {
            code: "FEATURE_NOT_SUPPORTED",
            message: "This deployment predates the disclosure contract",
            details: { reason: "contract_unavailable" },
          },
          { status: 422 },
        );
      }
      return Response.json(DISCLOSURE_FIXTURE);
    }
    if (/\/eval-runs$/.test(path) && method === "POST") {
      fixture.callOrder?.push("createEvalRun");
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
      fixture.callOrder?.push("createEvalRunGroup");
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

describe("per-run import approvals reach the launch", () => {
  const APPROVALS = [
    { testCaseId: "case-1", reason: "Reviewed against the upstream rubric" },
  ];

  it("forwards them from a SINGLE-CASE run", async () => {
    const { client, fetchMock } = makeClient();
    await runEvalCaseOperation.execute(
      { suite: "Smoke", case: "echo works", importApprovals: APPROVALS },
      { client },
    );
    // Without this the operation could never launch an `approximated` case:
    // the platform refuses a selected approximation carrying no approval, so
    // the one caller who explicitly approved it would still be refused.
    expect(bodiesTo(fetchMock, "/eval-runs")).toEqual([
      {
        suiteId: "suite-1",
        caseIds: ["case-1"],
        importApprovals: APPROVALS,
      },
    ]);
  });

  it("forwards them from a SUITE run selecting the same one case", async () => {
    const { client, fetchMock } = makeClient();
    await runEvalCaseOperation.execute(
      { suite: "Smoke", case: "echo works", importApprovals: APPROVALS },
      { client },
    );
    const single = bodiesTo(fetchMock, "/eval-runs");
    const suiteRun = makeClient();
    await runEvalSuiteOperation.execute(
      { suite: "Smoke", cases: ["echo works"], importApprovals: APPROVALS },
      { client: suiteRun.client },
    );
    const viaSuite = bodiesTo(suiteRun.fetchMock, "/eval-runs") as Array<
      Record<string, unknown>
    >;
    // The two ways of running ONE case must not disagree about whether it may
    // run. Both carry the same approval to the same route.
    const [viaCase] = single as Array<Record<string, unknown>>;
    expect(viaCase?.importApprovals).toEqual(APPROVALS);
    expect(viaSuite[0]?.importApprovals).toEqual(APPROVALS);
  });

  it("omits the key entirely when nothing was approved", async () => {
    // Absent, never `[]`: an empty list would read as "somebody considered
    // the approximations and approved none", which is a different statement
    // from "no approval was part of this launch".
    const { client, fetchMock } = makeClient();
    await runEvalCaseOperation.execute(
      { suite: "Smoke", case: "echo works" },
      { client },
    );
    const [body] = bodiesTo(fetchMock, "/eval-runs") as Array<
      Record<string, unknown>
    >;
    expect(body && "importApprovals" in body).toBe(false);
  });
});

describe("run_eval_suite pre-run disclosure (G4b)", () => {
  it("fires onDisclosure before createEvalRun, and carries it on the receipt", async () => {
    const callOrder: string[] = [];
    const { client } = makeClient({ callOrder });
    let received: unknown;
    const result = await runEvalSuiteOperation.execute(
      { suite: "Smoke" },
      {
        client,
        onDisclosure: (disclosure) => {
          received = disclosure;
        },
      },
    );
    expect(callOrder).toEqual(["getEvalRunDisclosure", "createEvalRun"]);
    expect(received).toMatchObject({ contractVersion: 1 });
    expect(result.disclosure).toMatchObject({ contractVersion: 1 });
  });

  it("fires onDisclosure before createEvalRunGroup on a multi-target launch", async () => {
    const callOrder: string[] = [];
    const { client } = makeClient({
      detail: suiteDetail({ environmentIds: ["env-stg", "env-prod"] }),
      callOrder,
    });
    await runEvalSuiteOperation.execute(
      { suite: "Smoke", allAttached: true },
      { client },
    );
    expect(callOrder[0]).toBe("getEvalRunDisclosure");
    expect(callOrder).toContain("createEvalRunGroup");
  });

  it("never blocks or fails the launch when the disclosure fetch is unavailable, and fires onDisclosureUnavailable instead", async () => {
    // BEST EFFORT: a backend that predates the contract must not turn a
    // launch into a failure — this is a planning aid, not a gate. But an
    // absent disclosure with NO signal at all is indistinguishable from "no
    // disclosure feature on this build" — onDisclosureUnavailable exists so
    // a caller can say "attempted, failed" instead of rendering nothing.
    const { client } = makeClient({ disclosureUnavailable: true });
    let onDisclosureCalled = false;
    let unavailableReason: string | undefined;
    const result = await runEvalSuiteOperation.execute(
      { suite: "Smoke" },
      {
        client,
        onDisclosure: () => (onDisclosureCalled = true),
        onDisclosureUnavailable: (reason) => (unavailableReason = reason),
      },
    );
    expect(result.outcome).toBe("started");
    expect(result.disclosure).toBeUndefined();
    expect(onDisclosureCalled).toBe(false);
    expect(unavailableReason).toMatch(
      /predates the pre-run disclosure contract/,
    );
  });

  it("fires onDisclosureUnavailable with a timeout reason when the fetch stalls past its own budget", async () => {
    vi.useFakeTimers();
    try {
      const { client } = makeClient({ disclosureStalls: true });
      let unavailableReason: string | undefined;
      const resultPromise = runEvalSuiteOperation.execute(
        { suite: "Smoke" },
        {
          client,
          onDisclosureUnavailable: (reason) => (unavailableReason = reason),
        },
      );
      await vi.advanceTimersByTimeAsync(11_000);
      const result = await resultPromise;
      expect(result.outcome).toBe("started");
      expect(unavailableReason).toMatch(/timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("DISCLOSES a single-host launch off the frozen plan's host (G4c un-refusal)", async () => {
    // Before G4c this skipped the fetch: the contract took no host selector,
    // so the only query available was the suite-BASE derivation, which a host
    // config can contradict with its own model and harness — a run could be
    // disclosed "emulated, no sandbox" while booting a harness sandbox. The
    // contract now takes `namedHostId`, so the frozen plan's host is
    // forwarded and the disclosure describes what actually runs.
    const { client } = makeClient({
      detail: suiteDetail({
        hosts: [{ id: "host-claude", name: "Claude" }],
      }),
    });
    const disclosureSpy = vi.spyOn(client, "getEvalRunDisclosure");
    let disclosureCalled = false;
    let unavailableReason: string | undefined;
    const result = await runEvalSuiteOperation.execute(
      { suite: "Smoke" },
      {
        client,
        onDisclosure: () => (disclosureCalled = true),
        onDisclosureUnavailable: (reason) => (unavailableReason = reason),
      },
    );
    expect(result.outcome).toBe("started");
    expect(result.disclosure).toBeDefined();
    expect(disclosureCalled).toBe(true);
    expect(unavailableReason).toBeUndefined();
    expect(disclosureSpy).toHaveBeenCalledWith(
      expect.objectContaining({ namedHostId: "host-claude" }),
      expect.anything(),
    );
  });

  it("still reports a MULTI-TARGET launch spanning hosts as unavailable — one plan, one disclosure", async () => {
    // The remaining honest absence, and for a different reason than the
    // retired one: the contract answers for ONE launch plan (its one-axis
    // rule refuses a host alongside an environment selector), so a group
    // spanning hosts has no single engine or model set to disclose. Stitching
    // N round trips into a composite would be a different contract than the
    // audit stamp records.
    const { client } = makeClient({
      detail: suiteDetail({
        hosts: [
          { id: "host-claude", name: "Claude" },
          { id: "host-chatgpt", name: "ChatGPT" },
        ],
      }),
    });
    const disclosureSpy = vi.spyOn(client, "getEvalRunDisclosure");
    let disclosureCalled = false;
    let unavailableReason: string | undefined;
    const result = await runEvalSuiteOperation.execute(
      { suite: "Smoke", hosts: ["Claude", "ChatGPT"] },
      {
        client,
        onDisclosure: () => (disclosureCalled = true),
        onDisclosureUnavailable: (reason) => (unavailableReason = reason),
      },
    );
    expect(result.disclosure).toBeUndefined();
    expect(disclosureCalled).toBe(false);
    expect(unavailableReason).toMatch(/multi-target launch that includes a host/);
    // The fetch itself must never happen — there is no single query for it.
    expect(disclosureSpy).not.toHaveBeenCalled();
  });

  it("does not fire onDisclosureUnavailable for a caller-initiated cancellation — that is not a disclosure failure", async () => {
    // Every AbortError looks the same from inside the fetch, but a caller
    // cancelling the WHOLE operation (the launch's own signal aborting) is
    // not a "the disclosure fetch timed out" story — the launch is about to
    // fail the same way for an unrelated reason, and mislabeling it would
    // misdescribe that abort. Spies directly on the client method rather
    // than relying on the fetch mock to replicate native fetch's
    // synchronous already-aborted check, which it does not.
    const { client } = makeClient();
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    vi.spyOn(client, "getEvalRunDisclosure").mockRejectedValue(abortError);
    const controller = new AbortController();
    controller.abort(new Error("caller cancelled"));
    let unavailableReason: string | undefined;
    const result = await runEvalSuiteOperation
      .execute(
        { suite: "Smoke" },
        {
          client,
          signal: controller.signal,
          onDisclosureUnavailable: (reason) => (unavailableReason = reason),
        },
      )
      .catch((error: unknown) => error);
    expect(result).toBeDefined();
    expect(unavailableReason).toBeUndefined();
  });

  it("does not surface an unhandled rejection when an async onDisclosureUnavailable callback rejects", async () => {
    // Same defensive contract as onDisclosure: an async callback (despite
    // the sync-only type) must not turn its rejection into an unhandled one.
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const { client } = makeClient({ disclosureUnavailable: true });
      const result = await runEvalSuiteOperation.execute(
        { suite: "Smoke" },
        {
          client,
          onDisclosureUnavailable: async () => {
            await Promise.resolve();
            throw new Error("async callback rejection");
          },
        },
      );
      expect(result.outcome).toBe("started");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("does not surface an unhandled rejection when an async onDisclosure callback rejects", async () => {
    // TypeScript accepts an async function for a `void`-returning callback
    // param, so a caller awaiting inside `onDisclosure` can hand back a
    // rejecting Promise here. That must not become an unhandled rejection,
    // delay the launch, or erase the disclosure already fetched successfully.
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    try {
      const { client } = makeClient();
      const result = await runEvalSuiteOperation.execute(
        { suite: "Smoke" },
        {
          client,
          onDisclosure: async () => {
            await Promise.resolve();
            throw new Error("async callback rejection");
          },
        },
      );
      expect(result.outcome).toBe("started");
      expect(result.disclosure).toMatchObject({ contractVersion: 1 });
      // Let the callback's own microtask queue flush before asserting.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("times out a STALLED disclosure fetch on its own budget, without aborting the launch", async () => {
    // The bug this guards: if the disclosure fetch shared the launch's own
    // signal/deadline, a stalled disclosure request would burn through that
    // budget and leave the shared signal aborted by the time createEvalRun
    // ran a moment later — turning a best-effort read into a failed launch.
    vi.useFakeTimers();
    try {
      const { client } = makeClient({ disclosureStalls: true });
      const resultPromise = runEvalSuiteOperation.execute(
        { suite: "Smoke" },
        { client },
      );
      // Past the disclosure fetch's own bound, comfortably under the
      // client's default request timeout — only the disclosure-specific
      // timer should have anything to fire.
      await vi.advanceTimersByTimeAsync(11_000);
      const result = await resultPromise;
      expect(result.outcome).toBe("started");
      expect(result.disclosure).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keys the disclosure to the SAME frozen target the run launches, not a re-resolution", async () => {
    const { client } = makeClient({
      detail: suiteDetail({ environmentIds: ["env-stg"] }),
    });
    const spy = vi.spyOn(client, "getEvalRunDisclosure");
    await runEvalSuiteOperation.execute(
      { suite: "Smoke", environment: "Staging" },
      { client },
    );
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        suiteId: "suite-1",
        environmentId: "env-stg",
      }),
      expect.anything(),
    );
  });
});

describe("get_eval_run_disclosure target resolution parity with run_eval_suite", () => {
  it("auto-selects the suite's SOLE attached environment with no selector at all", async () => {
    // Same rule `run_eval_suite` uses via computeRunTargets: a bare call on a
    // suite with exactly one attached environment discloses THAT
    // environment, not a suite-base derivation that could name different
    // models than the auto-selected environment actually would.
    const { client } = makeClient({
      detail: suiteDetail({ environmentIds: ["env-stg"] }),
    });
    const spy = vi.spyOn(client, "getEvalRunDisclosure");
    await getEvalRunDisclosureOperation.execute(
      { suite: "Smoke" },
      { client },
    );
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ suiteId: "suite-1", environmentId: "env-stg" }),
      expect.anything(),
    );
  });

  it("refuses to guess with no selector when SEVERAL environments are attached", async () => {
    // A bare launch would refuse here too (TARGET_REQUIRED) rather than pick
    // one silently — disclosing one of several attached environments as if
    // it were the only one would misdescribe what an equally bare launch
    // actually does (refuse).
    const { client } = makeClient({
      detail: suiteDetail({ environmentIds: ["env-stg", "env-prod"] }),
    });
    const error = await getEvalRunDisclosureOperation
      .execute({ suite: "Smoke" }, { client })
      .catch((caught: unknown) => caught as PlatformApiError);
    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).message).toMatch(/TARGET_REQUIRED/);
    // This operation's input schema has no host/hosts/allAttached selector,
    // and it spends nothing (readOnly: true) — the shared run_eval_suite
    // refusal text names all three, which would send a caller retrying with
    // a flag this operation's own schema validation rejects.
    const message = (error as PlatformApiError).message;
    expect(message).not.toMatch(/allAttached/);
    expect(message).not.toMatch(/\bhost\b/i);
    expect(message).not.toMatch(/PAID RUN/);
    expect(message).toMatch(/environment/);
  });

  it("still discloses when a caller names one of several attached environments", async () => {
    const { client } = makeClient({
      detail: suiteDetail({ environmentIds: ["env-stg", "env-prod"] }),
    });
    const spy = vi.spyOn(client, "getEvalRunDisclosure");
    await getEvalRunDisclosureOperation.execute(
      { suite: "Smoke", environment: "Prod" },
      { client },
    );
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ suiteId: "suite-1", environmentId: "env-prod" }),
      expect.anything(),
    );
  });

  it("AUTO-SELECTS a host-only suite's sole attached host and discloses it (G4c un-refusal)", async () => {
    // Before G4c this refused: the backend contract took no host parameter,
    // so the only query available was the selector-less suite-base
    // derivation, which a host config can contradict with its own model and
    // harness. `testSuites:getRunDisclosure` now takes `namedHostId`, so the
    // auto-selected host is disclosed for real — the same auto-select rule
    // `run_eval_suite` uses for a bare launch on this exact suite.
    const { client } = makeClient({
      detail: suiteDetail({
        hosts: [{ id: "host-claude", name: "Claude" }],
      }),
    });
    const spy = vi.spyOn(client, "getEvalRunDisclosure");
    await getEvalRunDisclosureOperation.execute({ suite: "Smoke" }, { client });
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        suiteId: "suite-1",
        namedHostId: "host-claude",
      }),
      expect.anything(),
    );
    // ONE AXIS: never both, which the backend refuses outright.
    expect(spy.mock.calls[0]![0]).not.toHaveProperty("environmentId");
    expect(spy.mock.calls[0]![0]).not.toHaveProperty("environmentIds");
  });

  it("discloses the host a caller NAMES out of several attached hosts", async () => {
    const { client } = makeClient({
      detail: suiteDetail({
        hosts: [
          { id: "host-claude", name: "Claude" },
          { id: "host-chatgpt", name: "ChatGPT" },
        ],
      }),
    });
    const spy = vi.spyOn(client, "getEvalRunDisclosure");
    await getEvalRunDisclosureOperation.execute(
      { suite: "Smoke", host: "ChatGPT" },
      { client },
    );
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        suiteId: "suite-1",
        namedHostId: "host-chatgpt",
      }),
      expect.anything(),
    );
  });

  it("refuses SEVERAL attached hosts with no selector — and the refusal now names host, which a caller can actually apply", async () => {
    // Still `target-required` (a bare `run_eval_suite` launch refuses here
    // too, so parity holds), but no longer a dead end: before G4c this
    // operation had no host selector, so the refusal could only say the axis
    // was unavailable. Now it enumerates the attached hosts and names the
    // selector that resolves them.
    const { client } = makeClient({
      detail: suiteDetail({
        hosts: [
          { id: "host-claude", name: "Claude" },
          { id: "host-chatgpt", name: "ChatGPT" },
        ],
      }),
    });
    const spy = vi.spyOn(client, "getEvalRunDisclosure");
    const error = await getEvalRunDisclosureOperation
      .execute({ suite: "Smoke" }, { client })
      .catch((caught: unknown) => caught as PlatformApiError);
    expect(error).toBeInstanceOf(PlatformApiError);
    const message = (error as PlatformApiError).message;
    expect(message).toMatch(/TARGET_REQUIRED/);
    expect(message).toMatch(/"Claude"/);
    expect(message).toMatch(/"ChatGPT"/);
    expect(message).toMatch(/\bhost\b/);
    // readOnly: this operation spends nothing and has no `allAttached`.
    expect(message).not.toMatch(/allAttached/);
    expect(message).not.toMatch(/PAID RUN/);
    // No attached environments, so `environment` is not an applicable fix.
    expect(message).not.toMatch(/Name one with environment/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses host together with environment — a plan resolves on one axis", async () => {
    const { client } = makeClient({
      detail: suiteDetail({
        environmentIds: ["env-stg"],
        hosts: [{ id: "host-claude", name: "Claude" }],
      }),
    });
    const spy = vi.spyOn(client, "getEvalRunDisclosure");
    const error = await getEvalRunDisclosureOperation
      .execute({ suite: "Smoke", host: "Claude", environment: "Stg" }, { client })
      .catch((caught: unknown) => caught as PlatformApiError);
    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).message).toMatch(
      /environments or hosts, not both/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it("refuses — not auto-selects the environment — when exactly one environment AND one host are both attached", async () => {
    // `computeRunTargets` itself treats this as `target-required` (two total
    // attachments across axes, see the "refuses to choose when several are
    // attached" case in the `computeRunTargets` suite below) — a bare
    // `run_eval_suite` launch on this exact suite would refuse the same way,
    // so disclosure refusing too is the parity this operation exists to keep.
    // BOTH axes are nameable here since G4c, so the refusal enumerates both
    // and names both selectors — every fix it suggests is one a caller can
    // actually apply.
    const { client } = makeClient({
      detail: suiteDetail({
        environmentIds: ["env-stg"],
        hosts: [{ id: "host-claude", name: "Claude" }],
      }),
    });
    const spy = vi.spyOn(client, "getEvalRunDisclosure");
    const error = await getEvalRunDisclosureOperation
      .execute({ suite: "Smoke" }, { client })
      .catch((caught: unknown) => caught as PlatformApiError);
    expect(error).toBeInstanceOf(PlatformApiError);
    const message = (error as PlatformApiError).message;
    expect(message).toMatch(/TARGET_REQUIRED/);
    expect(message).toMatch(/Name one with environment or host/);
    expect(message).toMatch(/"Claude"/);
    expect(message).toMatch(/env-stg/);
    // readOnly wording throughout — this operation spends nothing.
    expect(message).not.toMatch(/PAID RUN/);
    expect(message).not.toMatch(/allAttached/);
    expect(spy).not.toHaveBeenCalled();
  });

  it("still discloses the named environment when one environment AND one host are both attached", async () => {
    // The same mixed suite as above, but the caller names the environment —
    // satisfiable, since there is exactly one to name.
    const { client } = makeClient({
      detail: suiteDetail({
        environmentIds: ["env-stg"],
        hosts: [{ id: "host-claude", name: "Claude" }],
      }),
    });
    const spy = vi.spyOn(client, "getEvalRunDisclosure");
    await getEvalRunDisclosureOperation.execute(
      { suite: "Smoke", environment: "env-stg" },
      { client },
    );
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ suiteId: "suite-1", environmentId: "env-stg" }),
      expect.anything(),
    );
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
