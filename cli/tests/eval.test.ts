import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/index.js";

const telemetryDisabled = {
  env: {
    ...process.env,
    MCPJAM_TELEMETRY_DISABLED: "1",
  },
};

async function captureProcessOutput<T>(fn: () => Promise<T>): Promise<{
  result: T;
  stdout: string;
  stderr: string;
}> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stdout = "";
  let stderr = "";

  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === "string") {
      stdout += chunk;
      return true;
    }
    return (originalStdoutWrite as (...args: unknown[]) => boolean)(
      chunk,
      ...rest,
    );
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    if (typeof chunk === "string") {
      stderr += chunk;
      return true;
    }
    return (originalStderrWrite as (...args: unknown[]) => boolean)(
      chunk,
      ...rest,
    );
  }) as typeof process.stderr.write;

  try {
    const result = await fn();
    return { result, stdout, stderr };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
}

const PROJECTS = [
  {
    id: "proj-alpha",
    name: "Alpha",
    description: null,
    icon: null,
    organizationId: "org-1",
    visibility: null,
    createdAt: 1,
    updatedAt: 200,
  },
];

const SERVERS = [
  {
    id: "srv-ready",
    projectId: "proj-alpha",
    name: "Ready Server",
    enabled: true,
    transportType: "http",
    url: "https://ready.example.com/mcp",
    useOAuth: false,
    hasClientSecret: false,
    createdAt: null,
    updatedAt: null,
  },
  {
    id: "srv-stdio",
    projectId: "proj-alpha",
    name: "Stdio Server",
    enabled: true,
    transportType: "stdio",
    url: null,
    useOAuth: false,
    hasClientSecret: false,
    createdAt: null,
    updatedAt: null,
  },
];

const ENVIRONMENTS = [
  {
    id: "env-staging",
    projectId: "proj-alpha",
    name: "Staging",
    hostId: "host-1",
    revision: 4,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  },
  {
    id: "env-prod",
    projectId: "proj-alpha",
    name: "Prod",
    hostId: "host-1",
    revision: 2,
    archived: false,
    createdAt: 1,
    updatedAt: 2,
  },
];

const STEP_RESULTS = [
  { stepId: "s1", stepIndex: 0, kind: "prompt", status: "ok", reason: null },
  {
    stepId: "s2",
    stepIndex: 1,
    kind: "assert",
    status: "fail",
    reason: "clear-cart never called",
    evidence: { screenshotUrl: "https://blob/s2.png", source: "scripted" },
  },
];

const TRACE = {
  traceVersion: 1,
  messages: [{ role: "user", content: "hi" }],
  videoUrl: "https://blob.example.com/run.webm",
  widgetRenderObservations: [],
  browserInteractionSteps: [],
};

const FAILED_ITERATION = {
  id: "iter-failed",
  testCaseId: "case-1",
  title: "Fetch order",
  iterationNumber: 1,
  status: "completed",
  result: "failed",
  model: null,
  provider: null,
  startedAt: 1,
  durationMs: 10,
  tokensUsed: null,
  usage: null,
  actualToolCalls: [{ toolName: "fetch_order" }],
  expectedToolCalls: [{ toolName: "fetch_order" }],
  error: "server rejected arguments",
  stageResults: [
    { stage: "connection", state: "passed", reason: "observed" },
    { stage: "discovery", state: "passed", reason: "observed" },
    { stage: "selection", state: "passed", reason: "observed" },
    { stage: "call", state: "failed", reason: "argumentMismatch" },
    { stage: "response", state: "notReached", reason: "earlierStageFailed" },
    { stage: "userValue", state: "notReached", reason: "earlierStageFailed" },
  ],
  firstFailedStage: "call",
  failureCategory: "arguments",
  stageAnalyzerVersion: 2,
};

const SETUP_ABORT_ITERATION = {
  ...FAILED_ITERATION,
  id: "iter-setup",
  title: "Setup abort",
  error: "could not connect",
  actualToolCalls: [],
  stageResults: [
    { stage: "connection", state: "notMeasured", reason: "setupAborted" },
    { stage: "discovery", state: "notMeasured", reason: "setupAborted" },
    { stage: "selection", state: "notMeasured", reason: "setupAborted" },
    { stage: "call", state: "notMeasured", reason: "setupAborted" },
    { stage: "response", state: "notMeasured", reason: "setupAborted" },
    { stage: "userValue", state: "notMeasured", reason: "setupAborted" },
  ],
  firstFailedStage: undefined,
  failureCategory: "setup",
};

/**
 * How the fixture's suite presents itself to the run ops, which read the suite
 * DETAIL to decide what a run targets.
 *
 * Default: NOTHING attached — the bare-rerun shape most of these tests are
 * about, and the one whose request body must stay byte-identical.
 */
interface EvalFixtureOptions {
  suiteDetail?: {
    environmentIds?: string[];
    hosts?: Array<{ id: string; name: string }>;
  };
  /** Target ids the grouped-launch endpoint should report as failures. */
  groupFailures?: Record<string, { code: string; message: string }>;
  runCaseResult?: "passed" | "failed" | "inconclusive" | null;
  /** Non-terminal keeps `--wait` polling until its deadline. */
  runCaseStatus?: "running" | "completed" | "cancelled" | "timed_out" | "failed";
  /** Stamp the fixture's `run-case` as decided under verdict policy 2. */
  runCasePolicyVersion2?: boolean;
  runCaseIterationFetchError?: boolean;
  /** Like `runCaseIterationFetchError`, but the wire code is UNAUTHORIZED. */
  runCaseIterationFetchAuthError?: boolean;
  runOneResult?: "passed" | "failed" | "inconclusive";
  /** A terminal execution state distinct from the result verdict. */
  runOneStatus?: "completed" | "cancelled";
  /** Makes `GET /eval-runs/run-1/iterations` answer 500. */
  runOneIterationFetchError?: boolean;
  /** Makes the run-disclosure endpoint answer 422 contract_unavailable. */
  disclosureUnavailable?: boolean;
  /**
   * Drives `GET /eval-runs/run-1/compare` for `eval gate --baseline` /
   * `eval compare` tests. Absent means the endpoint is never hit.
   */
  compare?: {
    /** 404 with `details.reason: "BASELINE_NOT_FOUND"`, no baseline resolves. */
    notFound?: boolean;
    basePassed?: number;
    baseTotal?: number;
    comparePassed?: number;
    compareTotal?: number;
    /** Adds a `new_case` row, breaking the population rule. */
    caseSetChanged?: boolean;
  };
  /**
   * Per-target-run overrides for a grouped (`--all-targets` / `--host` x2)
   * launch, keyed by the fixture's deterministic `run-group-<n>` id.
   * Anything not named here defaults to `status: "completed"`,
   * `result: "passed"` — the shape most fan-out tests do not care about.
   */
  groupRunOverrides?: Record<
    string,
    { status?: string; result?: string | null }
  >;
  /**
   * `"launch"` — the launch POST (single-target `/eval-runs`, grouped
   * `/eval-run-groups`) returns 401 UNAUTHORIZED before any run exists.
   * `"poll"` — the launch succeeds, but `GET .../run-case` returns
   * "running" on its FIRST call and 401 UNAUTHORIZED on every call after
   * that, simulating a token that expired mid-wait.
   */
  authFailure?: "launch" | "poll";
  /**
   * Make the single-target launch POST (`/eval-runs`) fail with this wire
   * error instead of succeeding — the shape a real `PlatformApiError`
   * carries. A single-target launch throws rather than reporting a per-
   * target failure, which is exactly the case `classifyLaunchErrorExitCode`
   * exists to classify.
   */
  singleRunLaunchError?: {
    code: string;
    message: string;
    status?: number;
    details?: Record<string, unknown>;
  };
  /**
   * Tear the fixture server down shortly after the single-target launch
   * response is flushed, so the first `getEvalRun` poll fails to connect —
   * a mid-wait NETWORK_ERROR the CLI observes after evaluation has already
   * started.
   */
  closeAfterLaunch?: boolean;
  /**
   * Delete `process.env.MCPJAM_API_KEY` the moment the single-target launch
   * POST is handled, simulating a credential that dies in the window
   * between the launch preflight and the wait phase's own recheck. Only
   * meaningful when the caller resolves its credential from that env var
   * (no `--api-key` flag) — see `evalArgvNoKey`.
   */
  deleteCredentialAfterLaunch?: boolean;
}

async function startEvalFixture(options: EvalFixtureOptions = {}): Promise<{
  baseUrl: string;
  authHeaders: string[];
  createBodies: unknown[];
  runBodies: unknown[];
  groupBodies: unknown[];
  composeBodies: unknown[];
  attachBodies: unknown[];
  disclosureRequests: Array<{
    caseIds: string | null;
    environmentId: string | null;
    environmentIds: string | null;
    host: string | null;
  }>;
  close: () => Promise<void>;
}> {
  const authHeaders: string[] = [];
  const createBodies: unknown[] = [];
  const runBodies: unknown[] = [];
  const groupBodies: unknown[] = [];
  const composeBodies: unknown[] = [];
  const attachBodies: unknown[] = [];
  const disclosureRequests: Array<{
    caseIds: string | null;
    environmentId: string | null;
    environmentIds: string | null;
    host: string | null;
  }> = [];
  const UNAUTHORIZED_BODY = JSON.stringify({
    code: "UNAUTHORIZED",
    message: "token expired",
  });
  let runCasePollCount = 0;
  let networkFailureArmed = false;
  const sockets = new Set<import("node:net").Socket>();
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
    }
    authHeaders.push(req.headers.authorization ?? "");
    const url = new URL(req.url ?? "/", "http://fixture");
    res.setHeader("content-type", "application/json");

    if (url.pathname === "/api/v1/projects") {
      res.end(JSON.stringify({ items: PROJECTS }));
      return;
    }
    if (
      url.pathname === "/api/v1/organizations/org-1/eval-check-repos" &&
      (req.method ?? "GET") === "GET"
    ) {
      res.end(
        JSON.stringify({
          organizationId: "org-1",
          available: true,
          items: [
            {
              id: "cfg-1",
              repo: "acme/widgets",
              enabled: true,
              suiteId: "suite-1",
              projectId: "proj-alpha",
              outagePolicy: null,
              createdAt: 1,
              updatedAt: 2,
            },
          ],
          connectable: [{ repo: "acme/widgets" }],
        }),
      );
      return;
    }
    if (
      url.pathname === "/api/v1/organizations/org-1/eval-check-repos" &&
      req.method === "POST"
    ) {
      const body = raw ? JSON.parse(raw) : {};
      createBodies.push(body);
      res.statusCode = 201;
      res.end(
        JSON.stringify({
          id: "cfg-2",
          organizationId: "org-1",
          projectId: body.projectId,
          suiteId: body.suiteId,
          repo: body.repo,
          outagePolicy: body.outagePolicy,
        }),
      );
      return;
    }
    if (url.pathname === "/api/v1/projects/proj-alpha/servers") {
      res.end(JSON.stringify({ items: SERVERS }));
      return;
    }
    if (
      url.pathname ===
      "/api/v1/projects/proj-alpha/environments/capabilities"
    ) {
      res.end(
        JSON.stringify({
          modelOverrides: true,
          modelMatrix: true,
          ephemeralEnvironmentLaunch: true,
        }),
      );
      return;
    }
    if (url.pathname === "/api/v1/projects/proj-alpha/environments") {
      res.end(JSON.stringify({ items: ENVIRONMENTS }));
      return;
    }
    if (url.pathname === "/api/v1/projects/proj-alpha/hosts") {
      res.end(
        JSON.stringify({
          items: [{ id: "host-claude", name: "Claude Code" }],
        }),
      );
      return;
    }
    if (url.pathname === "/api/v1/projects/proj-alpha/images") {
      res.end(
        JSON.stringify({ items: [{ id: "img-default", name: "default" }] }),
      );
      return;
    }
    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/environments/ensure-adhoc" &&
      req.method === "POST"
    ) {
      const body = raw ? JSON.parse(raw) : {};
      composeBodies.push(body);
      const modelId =
        typeof body.modelId === "string" ? body.modelId : undefined;
      const id = modelId
        ? `env-adhoc-${modelId.replace(/[^a-z0-9]+/gi, "-")}`
        : "env-adhoc";
      res.end(
        JSON.stringify({
          environment: {
            id,
            projectId: "proj-alpha",
            name: null,
            adhoc: true,
            hostId: "host-claude",
            ...(modelId ? { modelId } : {}),
            revision: 1,
            archived: false,
            createdAt: 1,
            updatedAt: 1,
          },
          created: true,
        }),
      );
      return;
    }
    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/eval-suites/suite-1/environments" &&
      req.method === "POST"
    ) {
      attachBodies.push(raw ? JSON.parse(raw) : {});
      res.end(
        JSON.stringify({
          suiteId: "suite-1",
          attached: true,
          environmentIds: ["env-adhoc"],
        }),
      );
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-suites/suite-1" &&
      req.method === "PATCH"
    ) {
      const body = raw ? JSON.parse(raw) : {};
      createBodies.push(body);
      res.end(
        JSON.stringify({
          id: "suite-1",
          name: "Smoke",
          environmentIds: body.environmentIds ?? [],
          settings: {},
        }),
      );
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-suites" &&
      req.method === "POST"
    ) {
      const body = raw ? JSON.parse(raw) : {};
      createBodies.push(body);
      res.statusCode = 201;
      res.end(
        JSON.stringify({
          suiteId: "suite-created",
          name: body.name ?? null,
          servers: (body.serverIds ?? []).map((id: string) => ({ id })),
          caseUpsert: { committed: [{ name: "case-1" }], failed: [] },
        }),
      );
      return;
    }

    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/eval-runs/run-1/iterations/iter-1/steps" &&
      (req.method ?? "GET") === "GET"
    ) {
      res.end(JSON.stringify({ items: STEP_RESULTS }));
      return;
    }
    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/eval-runs/run-1/iterations/iter-1/trace" &&
      (req.method ?? "GET") === "GET"
    ) {
      res.end(JSON.stringify(TRACE));
      return;
    }
    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/eval-runs/run-failed/iterations" &&
      (req.method ?? "GET") === "GET"
    ) {
      res.end(JSON.stringify({ items: [FAILED_ITERATION] }));
      return;
    }
    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/eval-runs/run-setup/iterations" &&
      (req.method ?? "GET") === "GET"
    ) {
      res.end(JSON.stringify({ items: [SETUP_ABORT_ITERATION] }));
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-suites" &&
      (req.method ?? "GET") === "GET"
    ) {
      res.end(
        JSON.stringify({
          items: [
            {
              id: "suite-1",
              name: "Smoke",
              projectId: "proj-alpha",
              createdAt: 1,
              updatedAt: 2,
              latestRun: null,
              totals: { passed: 0, failed: 0, runs: 0 },
              passRateTrend: [],
            },
          ],
        }),
      );
      return;
    }
    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/eval-suites/suite-1/cases" &&
      (req.method ?? "GET") === "GET"
    ) {
      res.end(
        JSON.stringify({
          items: [{ id: "case-1", suiteId: "suite-1", title: "echo works" }],
        }),
      );
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-suites/suite-1" &&
      (req.method ?? "GET") === "GET"
    ) {
      res.end(
        JSON.stringify({
          id: "suite-1",
          name: "Smoke",
          description: null,
          projectId: "proj-alpha",
          environment: { servers: [] },
          executionConfig: null,
          hosts: options.suiteDetail?.hosts ?? [],
          environmentIds: options.suiteDetail?.environmentIds ?? [],
          settings: {},
          schedule: {},
          createdAt: 1,
          updatedAt: 2,
        }),
      );
      return;
    }
    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/eval-suites/suite-1/run-disclosure" &&
      (req.method ?? "GET") === "GET"
    ) {
      disclosureRequests.push({
        caseIds: url.searchParams.get("caseIds"),
        environmentId: url.searchParams.get("environmentId"),
        environmentIds: url.searchParams.get("environmentIds"),
        host: url.searchParams.get("host"),
      });
      if (options.disclosureUnavailable) {
        res.statusCode = 422;
        res.end(
          JSON.stringify({
            code: "FEATURE_NOT_SUPPORTED",
            message: "This deployment predates the disclosure contract",
            details: { reason: "contract_unavailable" },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          contractVersion: 1,
          computedAt: 1_700_000_000_000,
          digest: "deadbeef",
          execution: {
            engine: "emulated",
            sandbox: { engaged: false, because: "no sandbox needed" },
            locus: { known: true, hosted: false },
            models: [
              {
                modelId: "openai/gpt-5.4-mini",
                provider: "openai",
                tenantEgress: "mcpjam-hosted",
                rail: {
                  managed: true,
                  possibleDestinations: ["gateway", "openrouter"],
                  outcomeIfRunNow: {
                    destination: "gateway",
                    observedAt: 1_700_000_000_000,
                    volatile: true,
                  },
                  inputs: {
                    mode: "auto",
                    gatewayEligible: true,
                    hasOpenRouterFallback: null,
                  },
                  ruleLocation: "convex/lib/chatProvider.ts#resolveChatProvider",
                  authoritativePerRequestRecord: "llmUsageRecord",
                },
              },
            ],
          },
          analysis: [
            {
              touchpoint: "goalCompletion",
              label: "Goal-completion judge",
              model: "openai/gpt-5.4-mini",
              rail: { fixed: "openrouter", because: "x" },
              destinations: ["OpenRouter (openrouter.ai)"],
              evidenceSent: ["case prompt"],
              fires: "explicit-request-only",
            },
            {
              touchpoint: "runInsights",
              label: "Run insights report",
              model: "openai/gpt-5.4-mini",
              rail: { fixed: "openrouter", because: "x" },
              destinations: ["A wholly different destination"],
              evidenceSent: ["failure signatures"],
              fires: "auto-on-completion",
            },
          ],
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
        }),
      );
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-run-groups" &&
      req.method === "POST"
    ) {
      if (options.authFailure === "launch") {
        res.statusCode = 401;
        res.end(UNAUTHORIZED_BODY);
        return;
      }
      const body = raw ? JSON.parse(raw) : {};
      groupBodies.push(body);
      let started = 0;
      let failed = 0;
      const targets = (
        body.targets as Array<{ environmentId?: string; namedHostId?: string }>
      ).map((target, index) => {
        const id = target.environmentId ?? target.namedHostId ?? "";
        const failure = options.groupFailures?.[id];
        if (failure) {
          failed += 1;
          return { target, status: "failed", error: failure };
        }
        started += 1;
        return {
          target,
          status: "started",
          runId: `run-group-${index + 1}`,
          runStatus: "running",
          servers: [{ id: "srv-ready", name: "Ready Server" }],
          environment: null,
        };
      });
      const first = targets.find((entry) => entry.status === "started") as
        | { runId: string }
        | undefined;
      res.statusCode = 202;
      res.end(
        JSON.stringify({
          runGroupId: "grp-1",
          suiteId: body.suiteId,
          outcome:
            started === 0 ? "failed" : failed > 0 ? "partial" : "started",
          startedCount: started,
          failedCount: failed,
          targets,
          ...(first ? { runId: first.runId, status: "running" } : {}),
        }),
      );
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-runs" &&
      req.method === "POST"
    ) {
      if (options.authFailure === "launch") {
        res.statusCode = 401;
        res.end(UNAUTHORIZED_BODY);
        return;
      }
      if (options.singleRunLaunchError) {
        res.statusCode = options.singleRunLaunchError.status ?? 400;
        res.end(
          JSON.stringify({
            code: options.singleRunLaunchError.code,
            message: options.singleRunLaunchError.message,
            ...(options.singleRunLaunchError.details
              ? { details: options.singleRunLaunchError.details }
              : {}),
          }),
        );
        return;
      }
      const body = raw ? JSON.parse(raw) : {};
      createBodies.push(body);
      runBodies.push(body);
      res.statusCode = 202;
      res.end(
        JSON.stringify({
          runId: "run-case",
          suiteId: "suite-1",
          status: "running",
          caseUpsert: { committed: [], failed: [] },
          servers: [{ id: "srv-ready", name: "Ready Server" }],
          environment: body.environmentId
            ? { id: body.environmentId, name: "Staging", revision: 4 }
            : null,
        }),
      );
      // Armed AFTER this response is queued, so the launch itself always
      // succeeds — only the FOLLOWING poll request hits the failure.
      if (options.closeAfterLaunch) {
        networkFailureArmed = true;
      }
      if (options.deleteCredentialAfterLaunch) {
        delete process.env.MCPJAM_API_KEY;
      }
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-runs/run-case" &&
      (req.method ?? "GET") === "GET"
    ) {
      runCasePollCount += 1;
      if (networkFailureArmed) {
        // No response at all — the client sees a connection failure, not an
        // HTTP error. Deterministic: this only fires on the poll AFTER the
        // launch response was already queued, never on the launch itself.
        req.socket.destroy();
        return;
      }
      if (options.authFailure === "poll" && runCasePollCount > 1) {
        res.statusCode = 401;
        res.end(UNAUTHORIZED_BODY);
        return;
      }
      const result =
        options.authFailure === "poll"
          ? undefined
          : (options.runCaseResult ?? "passed");
      const status =
        options.authFailure === "poll"
          ? "running"
          : (options.runCaseStatus ?? "completed");
      const policy2 =
        options.runCasePolicyVersion2 || result === "inconclusive";
      res.end(
        JSON.stringify({
          id: "run-case",
          suiteId: "suite-1",
          runNumber: 4,
          status,
          result: result ?? null,
          summary:
            result === "failed"
              ? { total: 1, passed: 0, failed: 1, passRate: 0 }
              : { total: 1, passed: 1, failed: 0, passRate: 1 },
          source: "api",
          notes: null,
          createdAt: 10,
          completedAt: 20,
          ...(policy2
            ? {
                verdictPolicyVersion: 2,
                verdictSummary: {
                  decision: result,
                  reasons:
                    result === "inconclusive"
                      ? ["completionRate below minCompletionRate"]
                      : [],
                },
              }
            : {}),
        }),
      );
      return;
    }
    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/eval-runs/run-case/iterations" &&
      (req.method ?? "GET") === "GET"
    ) {
      if (options.runCaseIterationFetchError) {
        res.statusCode = 500;
        res.end(
          JSON.stringify({
            code: "ITERATIONS_FETCH_FAILED",
            message: "iteration results unavailable",
          }),
        );
        return;
      }
      if (options.runCaseIterationFetchAuthError) {
        res.statusCode = 401;
        res.end(UNAUTHORIZED_BODY);
        return;
      }
      const result = options.runCaseResult ?? "passed";
      res.end(
        JSON.stringify({
          items: [
            {
              id: "iter-case",
              testCaseId: "case-1",
              title: "echo works",
              iterationNumber: 1,
              status: "completed",
              result: result === "inconclusive" ? "passed" : result,
              model: null,
              provider: null,
              startedAt: 10,
              durationMs: 10,
              tokensUsed: null,
              usage: null,
              actualToolCalls: [],
              expectedToolCalls: [],
              error:
                result === "failed"
                  ? "Authorization: Bearer top-secret"
                  : null,
            },
          ],
        }),
      );
      return;
    }
    const groupRunMatch = /^\/api\/v1\/projects\/proj-alpha\/eval-runs\/(run-group-\d+)$/.exec(
      url.pathname,
    );
    if (groupRunMatch && (req.method ?? "GET") === "GET") {
      const runId = groupRunMatch[1]!;
      const override = options.groupRunOverrides?.[runId];
      const status = override?.status ?? "completed";
      const result = override && "result" in override ? override.result : "passed";
      res.end(
        JSON.stringify({
          id: runId,
          suiteId: "suite-1",
          runNumber: 5,
          status,
          result,
          summary:
            result === "failed"
              ? { total: 1, passed: 0, failed: 1, passRate: 0 }
              : { total: 1, passed: 1, failed: 0, passRate: 1 },
          source: "api",
          notes: null,
          createdAt: 10,
          completedAt: 20,
        }),
      );
      return;
    }
    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/eval-runs/run-group-1/iterations" &&
      (req.method ?? "GET") === "GET"
    ) {
      res.end(
        JSON.stringify({
          items: [
            {
              id: "iter-group-1",
              testCaseId: "case-1",
              title: "echo works",
              iterationNumber: 1,
              status: "completed",
              result: "passed",
              model: null,
              provider: null,
              startedAt: 10,
              durationMs: 10,
              tokensUsed: null,
              usage: null,
              actualToolCalls: [],
              expectedToolCalls: [],
              error: null,
            },
          ],
        }),
      );
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-runs/run-1" &&
      (req.method ?? "GET") === "GET"
    ) {
      const status = options.runOneStatus ?? "completed";
      // A cancelled run is an EXECUTION state, not a verdict: it carries no
      // result at all, distinct from an inconclusive result on a completed
      // run — both are "incomplete" gate-wise, for different reasons.
      const result =
        status === "cancelled" ? null : (options.runOneResult ?? "passed");
      res.end(
        JSON.stringify({
          id: "run-1",
          suiteId: "suite-1",
          runNumber: 3,
          status,
          result,
          summary:
            result === "failed"
              ? { total: 2, passed: 1, failed: 1, passRate: 0.5 }
              : { total: 2, passed: 2, failed: 0, passRate: 1 },
          source: "api",
          notes: null,
          createdAt: 1,
          completedAt: 2,
          judges: {
            goalCompletion: {
              status: "completed",
              errorCode: null,
              summary: "Both answers hit the goal.",
              generatedAt: 9,
              modelUsed: "openai/gpt-5.4-mini",
              threshold: 0.7,
              cases: [
                {
                  caseKey: "a",
                  score: 0.9,
                  passed: true,
                  reason: "ok",
                  rubricHits: [],
                },
                {
                  caseKey: "b",
                  score: 0.4,
                  passed: false,
                  reason: "missed",
                  rubricHits: [],
                },
              ],
            },
            // Never requested — the CLI must print nothing for it.
            groundedness: {
              status: null,
              errorCode: null,
              summary: null,
              generatedAt: null,
              modelUsed: null,
              threshold: null,
              cases: [],
            },
          },
        }),
      );
      return;
    }
    if (
      (url.pathname ===
        "/api/v1/projects/proj-alpha/eval-runs/run-failed" ||
        url.pathname ===
          "/api/v1/projects/proj-alpha/eval-runs/run-setup") &&
      (req.method ?? "GET") === "GET"
    ) {
      const setup = url.pathname.endsWith("run-setup");
      res.end(
        JSON.stringify({
          id: setup ? "run-setup" : "run-failed",
          suiteId: "suite-1",
          runNumber: 4,
          status: "failed",
          result: "failed",
          summary: { total: 1, passed: 0, failed: 1, passRate: 0 },
          source: "api",
          notes: null,
          createdAt: 1,
          completedAt: 2,
          judges: {},
        }),
      );
      return;
    }
    if (
      url.pathname ===
        "/api/v1/projects/proj-alpha/eval-runs/run-1/iterations" &&
      (req.method ?? "GET") === "GET"
    ) {
      if (options.runOneIterationFetchError) {
        res.statusCode = 500;
        res.end(
          JSON.stringify({
            code: "ITERATIONS_FETCH_FAILED",
            message: "iteration results unavailable",
          }),
        );
        return;
      }
      const result = options.runOneResult ?? "passed";
      res.end(
        JSON.stringify({
          items: [
            {
              id: "iter-1",
              testCaseId: "case-1",
              title: "echo works",
              iterationNumber: 1,
              status: "completed",
              result: result === "inconclusive" ? "passed" : result,
              model: null,
              provider: null,
              startedAt: 1,
              durationMs: 1,
              tokensUsed: null,
              usage: null,
              actualToolCalls: [],
              expectedToolCalls: [],
              error: result === "failed" ? "goal completion failed" : null,
            },
          ],
        }),
      );
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-runs/run-1/compare" &&
      (req.method ?? "GET") === "GET"
    ) {
      if (options.compare?.notFound) {
        res.statusCode = 404;
        res.end(
          JSON.stringify({
            code: "NOT_FOUND",
            message: "no baseline resolves for this run",
            details: { reason: "BASELINE_NOT_FOUND" },
          }),
        );
        return;
      }
      const cmp = options.compare ?? {};
      const baseRunId = url.searchParams.get("baseRunId") ?? "run-baseline";
      // These defaults are the SAME oracle-pinned 56/70 -> 48/80 regression
      // `eval-compare-exit-code.test.ts` checks against statsmodels, reused
      // here rather than re-derived. They deliberately do NOT track run-1's
      // own (tiny, 1-2 iteration) `/eval-runs/run-1` summary: the code under
      // test never cross-checks the two summaries against each other — one
      // feeds `reportForRun`'s threshold gate, the other feeds
      // `evaluateBaselineComparison`'s comparative gate — and collapsing them
      // to the same small sample would make every baseline test below
      // "insufficient_data" instead of exercising a real regression.
      const baseTotal = cmp.baseTotal ?? 70;
      const compareTotal = cmp.compareTotal ?? 80;
      const basePassed = cmp.basePassed ?? 56;
      const comparePassed = cmp.comparePassed ?? 48;
      const zero = {
        base: null,
        compare: null,
        delta: null,
        percentDelta: null,
      };
      const caseSide = (iterationId: string) => ({
        outcome: "passed" as const,
        iterationIds: [iterationId],
        representativeIterationId: iterationId,
        error: null,
      });
      res.end(
        JSON.stringify({
          suite: { id: "suite-1", name: "Smoke" },
          baseline: { policy: "run", baseRunId },
          baseRun: {
            id: baseRunId,
            runNumber: 2,
            result: "passed",
            createdAt: 1,
            completedAt: 2,
            summary: {
              total: baseTotal,
              passed: basePassed,
              failed: baseTotal - basePassed,
              passRate: basePassed / baseTotal,
            },
          },
          compareRun: {
            id: "run-1",
            runNumber: 3,
            result: comparePassed === compareTotal ? "passed" : "failed",
            createdAt: 3,
            completedAt: 4,
            summary: {
              total: compareTotal,
              passed: comparePassed,
              failed: compareTotal - comparePassed,
              passRate: comparePassed / compareTotal,
            },
          },
          passSummary: {
            passRatePercent: zero,
            total: zero,
            passed: zero,
            failed: zero,
          },
          metrics: {
            wallDurationMs: zero,
            totalTokens: zero,
            estimatedCostUsd: zero,
          },
          scoreContract: {
            base: {
              evaluationConfigHash: "cfg",
              scoreIntegrity: "valid",
              scoredIterations: baseTotal,
              quarantinedIterations: 0,
            },
            compare: {
              evaluationConfigHash: "cfg",
              scoreIntegrity: "valid",
              scoredIterations: compareTotal,
              quarantinedIterations: 0,
            },
            evaluationConfigChanged: false,
            scorers: [],
          },
          cases: cmp.caseSetChanged
            ? [
                {
                  caseKey: "ck_a",
                  title: "Case A",
                  status: "unchanged_passed",
                  configChanged: false,
                  evaluationConfigChanged: false,
                  scoreDeltas: [],
                  base: caseSide("b1"),
                  compare: caseSide("c1"),
                },
                {
                  caseKey: "ck_new",
                  title: "Case New",
                  status: "new_case",
                  configChanged: false,
                  evaluationConfigChanged: false,
                  scoreDeltas: [],
                  base: {
                    outcome: "absent",
                    iterationIds: [],
                    representativeIterationId: null,
                    error: null,
                  },
                  compare: caseSide("c2"),
                },
              ]
            : [
                {
                  caseKey: "ck_a",
                  title: "Case A",
                  status: "unchanged_passed",
                  configChanged: false,
                  evaluationConfigChanged: false,
                  scoreDeltas: [],
                  base: caseSide("b1"),
                  compare: caseSide("c1"),
                },
              ],
        }),
      );
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-runs/run-1/judge" &&
      req.method === "POST"
    ) {
      createBodies.push(raw ? JSON.parse(raw) : {});
      res.statusCode = 202;
      res.end(
        JSON.stringify({
          runId: "run-1",
          projectId: "proj-alpha",
          status: "pending",
        }),
      );
      return;
    }
    if (
      url.pathname === "/api/v1/projects/proj-alpha/eval-runs/run-1/cancel" &&
      req.method === "POST"
    ) {
      res.end(
        JSON.stringify({
          id: "run-1",
          suiteId: "suite-created",
          runNumber: 1,
          status: "cancelled",
          result: "cancelled",
          summary: null,
          source: "api",
          notes: null,
          createdAt: 1,
          completedAt: 2,
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ code: "NOT_FOUND", message: "no route" }));
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture server has no address");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/api/v1`,
    authHeaders,
    createBodies,
    runBodies,
    groupBodies,
    composeBodies,
    attachBodies,
    disclosureRequests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function evalArgv(fixtureUrl: string, ...args: string[]): string[] {
  return [
    "node",
    "mcpjam",
    "cloud",
    "eval",
    ...args,
    "--api-key",
    "sk_test",
    "--api-url",
    fixtureUrl,
  ];
}

/** Like {@link evalArgv}, but omits `--api-key` — for missing-credential tests. */
function evalArgvNoKey(fixtureUrl: string, ...args: string[]): string[] {
  return ["node", "mcpjam", "cloud", "eval", ...args, "--api-url", fixtureUrl];
}

/**
 * Run one `main()` invocation with NO stored/env credential visible: no
 * `--api-key` flag, `MCPJAM_API_KEY` unset, and `MCPJAM_AUTH_FILE` pointed at
 * a path that does not exist. `preflightCloudCredentials` resolves through
 * real `process.env` (not `dependencies.telemetry.env`), so this mutates and
 * restores the actual process environment around the call — same pattern as
 * `auth-commands.test.ts`.
 */
async function withNoCredential<T>(fn: () => Promise<T>): Promise<T> {
  const originalApiKey = process.env.MCPJAM_API_KEY;
  const originalAuthFile = process.env.MCPJAM_AUTH_FILE;
  delete process.env.MCPJAM_API_KEY;
  process.env.MCPJAM_AUTH_FILE = path.join(
    os.tmpdir(),
    `mcpjam-no-auth-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  try {
    return await fn();
  } finally {
    if (originalApiKey === undefined) delete process.env.MCPJAM_API_KEY;
    else process.env.MCPJAM_API_KEY = originalApiKey;
    if (originalAuthFile === undefined) delete process.env.MCPJAM_AUTH_FILE;
    else process.env.MCPJAM_AUTH_FILE = originalAuthFile;
  }
}

/**
 * Run one `main()` invocation with a credential that starts VALID (read
 * from `MCPJAM_API_KEY`, not a `--api-key` flag, so it can disappear
 * mid-flight) and a safe, nonexistent `MCPJAM_AUTH_FILE` so there is no
 * stored-login fallback masking the deletion. Pairs with
 * `deleteCredentialAfterLaunch` on the fixture, which removes the env var
 * the moment the launch POST is handled.
 */
async function withDyingCredential<T>(fn: () => Promise<T>): Promise<T> {
  const originalApiKey = process.env.MCPJAM_API_KEY;
  const originalAuthFile = process.env.MCPJAM_AUTH_FILE;
  process.env.MCPJAM_API_KEY = "sk_test";
  process.env.MCPJAM_AUTH_FILE = path.join(
    os.tmpdir(),
    `mcpjam-dying-auth-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  try {
    return await fn();
  } finally {
    if (originalApiKey === undefined) delete process.env.MCPJAM_API_KEY;
    else process.env.MCPJAM_API_KEY = originalApiKey;
    if (originalAuthFile === undefined) delete process.env.MCPJAM_AUTH_FILE;
    else process.env.MCPJAM_AUTH_FILE = originalAuthFile;
  }
}

test("eval create posts an authored suite and echoes the new suite id", async () => {
  const fixture = await startEvalFixture();
  try {
    const definition = {
      project: "proj-alpha",
      name: "Authored smoke",
      servers: ["Ready Server"],
      model: "anthropic/claude-haiku-4.5",
      cases: [
        {
          title: "echo works",
          steps: [
            { id: "s1", kind: "prompt", prompt: "say hi" },
            {
              id: "s2",
              kind: "assert",
              assertion: {
                type: "toolCalledWith",
                toolName: "echo",
                args: { args: {} },
              },
            },
          ],
          advancedConfig: { system: "be terse", temperature: 0.1 },
        },
      ],
    };
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "create",
            "--json",
            JSON.stringify(definition),
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.equal(fixture.createBodies.length, 1);
    const body = fixture.createBodies[0] as Record<string, any>;
    assert.equal(body.name, "Authored smoke");
    assert.deepEqual(body.serverIds, ["srv-ready"]);
    assert.deepEqual(body.serverNames, ["Ready Server"]);
    assert.equal(body.model, "anthropic/claude-haiku-4.5");
    assert.equal(body.tests.length, 1);
    assert.equal(body.tests[0].title, "echo works");
    // Advanced authoring fields forward instead of being stripped.
    assert.deepEqual(body.tests[0].advancedConfig, {
      system: "be terse",
      temperature: 0.1,
    });

    assert.ok(fixture.authHeaders.includes("Bearer sk_test"));
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.suite.id, "suite-created");
  } finally {
    await fixture.close();
  }
});

test("eval create lets --server override the file's servers", async () => {
  const fixture = await startEvalFixture();
  try {
    const definition = {
      name: "Override",
      servers: ["Stdio Server"],
      model: "anthropic/claude-haiku-4.5",
      cases: [{ title: "t", steps: [{ id: "s1", kind: "prompt", prompt: "q" }] }],
    };
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "create",
          "--project",
          "proj-alpha",
          "--json",
          JSON.stringify(definition),
          "--server",
          "Ready Server",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const body = fixture.createBodies[0] as Record<string, any>;
    assert.deepEqual(body.serverIds, ["srv-ready"]);
  } finally {
    await fixture.close();
  }
});

test("eval create forwards a --provider override for bare model ids", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "create",
          "--project",
          "proj-alpha",
          "--name",
          "Bare model",
          "--model",
          "my-local-model",
          "--provider",
          "custom",
          "--server",
          "Ready Server",
          "--json",
          JSON.stringify({ cases: [{ title: "t", steps: [{ id: "s1", kind: "prompt", prompt: "q" }] }] }),
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const body = fixture.createBodies[0] as Record<string, any>;
    assert.equal(body.model, "my-local-model");
    assert.equal(body.provider, "custom");
  } finally {
    await fixture.close();
  }
});

test("eval create rejects stdio servers before any write", async () => {
  const fixture = await startEvalFixture();
  try {
    const definition = {
      project: "proj-alpha",
      name: "Bad",
      servers: ["Stdio Server"],
      model: "anthropic/claude-haiku-4.5",
      cases: [{ title: "t", steps: [{ id: "s1", kind: "prompt", prompt: "q" }] }],
    };
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "create",
          "--json",
          JSON.stringify(definition),
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.notEqual(run.result.exitCode, 0);
    assert.equal(fixture.createBodies.length, 0);
    assert.match(run.stderr, /stdio/i);
  } finally {
    await fixture.close();
  }
});

test("eval create --json with schemaVersion points at eval run --file", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "create",
          "--json",
          JSON.stringify({
            schemaVersion: "1",
            mode: "agentWorkflow",
            suite: { id: "s_billing", name: "Billing" },
          }),
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 2);
    assert.equal(fixture.createBodies.length, 0);
    assert.match(run.stderr, /eval run --file/);
  } finally {
    await fixture.close();
  }
});

test("eval create rejects an invalid suite definition as a usage error", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "create",
          "--json",
          JSON.stringify({ name: "No cases", servers: ["Ready Server"] }),
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 2);
    assert.equal(fixture.createBodies.length, 0);
    assert.match(run.stderr, /USAGE_ERROR/);
  } finally {
    await fixture.close();
  }
});

test("eval create rejects an unknown --json key as a usage error", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "create",
          "--json",
          JSON.stringify({
            project: "proj-alpha",
            name: "Authored smoke",
            servers: ["Ready Server"],
            model: "anthropic/claude-haiku-4.5",
            cases: [
              { title: "t", steps: [{ id: "s1", kind: "prompt", prompt: "q" }] },
            ],
            hostz: [],
          }),
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 2);
    assert.equal(fixture.createBodies.length, 0);
    assert.match(run.stderr, /USAGE_ERROR/);
    assert.match(run.stderr, /hostz/);
  } finally {
    await fixture.close();
  }
});

test("eval create rejects malformed JSON in --json", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(fixture.baseUrl, "create", "--json", "{ not json"),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 2);
    assert.equal(fixture.createBodies.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval steps returns per-authored-step results for an iteration", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "steps",
            "--project",
            "proj-alpha",
            "--run",
            "run-1",
            "--iteration",
            "iter-1",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const payload = JSON.parse(run.stdout) as {
      runId: string;
      iterationId: string;
      steps: Array<{ stepId: string; status: string }>;
    };
    assert.equal(payload.runId, "run-1");
    assert.equal(payload.iterationId, "iter-1");
    assert.deepEqual(
      payload.steps.map((s) => [s.stepId, s.status]),
      [
        ["s1", "ok"],
        ["s2", "fail"],
      ],
    );
  } finally {
    await fixture.close();
  }
});

test("eval video surfaces the iteration's resolved replay URL", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "video",
            "--project",
            "proj-alpha",
            "--run",
            "run-1",
            "--iteration",
            "iter-1",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const payload = JSON.parse(run.stdout) as {
      runId: string;
      iterationId: string;
      videoUrl: string;
    };
    assert.equal(payload.runId, "run-1");
    assert.equal(payload.iterationId, "iter-1");
    assert.equal(payload.videoUrl, "https://blob.example.com/run.webm");
  } finally {
    await fixture.close();
  }
});

test("eval cancel POSTs the cancel and echoes the cancelled run", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "cancel",
            "--project",
            "proj-alpha",
            "--run",
            "run-1",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const payload = JSON.parse(run.stdout) as {
      run: { id: string; status: string; result: string };
    };
    assert.equal(payload.run.id, "run-1");
    assert.equal(payload.run.status, "cancelled");
    assert.equal(payload.run.result, "cancelled");
  } finally {
    await fixture.close();
  }
});

test("eval cases run starts a persisted single-case run with caseIds", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "cases",
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--case",
            "case-1",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const payload = JSON.parse(run.stdout) as {
      runId: string;
      case: { id: string };
    };
    assert.equal(payload.runId, "run-case");
    assert.equal(payload.case.id, "case-1");
    // The run-create POST carried the single-case filter.
    const runBody = fixture.createBodies.at(-1) as { caseIds?: string[] };
    assert.deepEqual(runBody.caseIds, ["case-1"]);
  } finally {
    await fixture.close();
  }
});

test("eval run --environment resolves the name and reports the pinned revision", async () => {
  // ATTACHED to the suite, because the op checks attachment client-side now:
  // a fan-out issues one launch per target, so an unattached one has to fail
  // before its siblings start spending rather than after.
  const fixture = await startEvalFixture({
    suiteDetail: { environmentIds: ["env-staging"] },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--environment",
            "staging",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const payload = JSON.parse(run.stdout) as {
      environment: { id: string; name: string; revision: number } | null;
    };
    assert.deepEqual(payload.environment, {
      id: "env-staging",
      name: "Staging",
      revision: 4,
    });
    const runBody = fixture.createBodies.at(-1) as { environmentId?: string };
    assert.equal(runBody.environmentId, "env-staging");
  } finally {
    await fixture.close();
  }
});

test("eval run rejects --environment together with --server before any request", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--environment",
          "Staging",
          "--server",
          "Ready Server",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.notEqual(run.result.exitCode, 0);
    assert.match(run.stderr, /either environment or servers/);
    // The CLI calls the operation directly, so this guard has to live in the
    // execute body — a schema-only refine would never fire here.
    assert.equal(fixture.createBodies.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval update rejects an unknown --json key as a usage error", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "update",
          "--suite",
          "suite-1",
          "--json",
          JSON.stringify({ hostz: [] }),
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 2);
    assert.equal(fixture.createBodies.length, 0);
    assert.match(run.stderr, /USAGE_ERROR/);
    assert.match(run.stderr, /hostz/);
  } finally {
    await fixture.close();
  }
});

test("eval update --judge on writes enabled AND autoRun together", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "update",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--judge",
            "on",
            "--judge-threshold",
            "0.8",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const patchBody = fixture.createBodies.at(-1) as {
      settings?: { judge?: Record<string, unknown> };
    };
    // `enabled` alone is a no-op — it already defaults on, and the grader
    // gates on `autoRun`. One flag, both fields, matching the app's switch.
    assert.deepEqual(patchBody.settings?.judge, {
      enabled: true,
      autoRun: true,
      threshold: 0.8,
    });
  } finally {
    await fixture.close();
  }
});

test("eval update --judge off turns autoRun off with it", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "update",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--judge",
            "off",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const patchBody = fixture.createBodies.at(-1) as {
      settings?: { judge?: Record<string, unknown> };
    };
    assert.deepEqual(patchBody.settings?.judge, {
      enabled: false,
      autoRun: false,
    });
  } finally {
    await fixture.close();
  }
});

test("eval update rejects an unusable --judge-threshold before any write", async () => {
  const fixture = await startEvalFixture();
  try {
    // "" and "   " are the interesting ones: `Number("")` is 0, a perfectly
    // valid threshold, so a blank flag would otherwise pass the range check
    // and silently set "every case passes" (`passed = score >= 0`).
    for (const value of ["80", "", "   ", "abc", "-0.1"]) {
      const run = await captureProcessOutput(() =>
        main(
          evalArgv(
            fixture.baseUrl,
            "update",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--judge-threshold",
            value,
          ),
          { telemetry: telemetryDisabled },
        ),
      );

      assert.notEqual(run.result.exitCode, 0, `accepted ${JSON.stringify(value)}`);
      assert.match(
        run.stderr,
        /--judge-threshold must be a number between 0 and 1/,
      );
    }
    assert.equal(fixture.createBodies.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval update still accepts an explicit --judge-threshold 0", async () => {
  // Rejecting blank must not reject a threshold someone deliberately set to 0.
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "update",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--judge-threshold",
            "0",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const patchBody = fixture.createBodies.at(-1) as {
      settings?: { judge?: Record<string, unknown> };
    };
    assert.equal(patchBody.settings?.judge?.threshold, 0);
  } finally {
    await fixture.close();
  }
});

test("eval environments set PATCHes the resolved ids in the given order", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "environments",
            "set",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--environment",
            "Prod",
            "env-staging",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const patchBody = fixture.createBodies.at(-1) as {
      environmentIds?: string[] | null;
    };
    assert.deepEqual(patchBody.environmentIds, ["env-prod", "env-staging"]);
  } finally {
    await fixture.close();
  }
});

test("eval environments clear sends an explicit null", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "environments",
            "clear",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const patchBody = fixture.createBodies.at(-1) as {
      environmentIds?: string[] | null;
    };
    assert.equal(patchBody.environmentIds, null);
  } finally {
    await fixture.close();
  }
});

test("eval environments set rejects an unknown environment before any write", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "environments",
          "set",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--environment",
          "Staging",
          "ghost",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.notEqual(run.result.exitCode, 0);
    // The failure names the bad selector AND enumerates the real choices, so a
    // typo is one round trip to fix rather than a bare "not found". Quotes are
    // matched loosely because the payload is JSON-encoded here.
    assert.match(run.stderr, /Project environment .*ghost.* was not found/);
    assert.match(run.stderr, /Staging \(id: env-staging\)/);
    assert.match(run.stderr, /Prod \(id: env-prod\)/);
    // Resolution failing means nothing is PATCHed — a partially-attached suite
    // is worse than an unattached one.
    assert.equal(fixture.createBodies.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval run appends a View link in human format", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
          ),
          // Explicit: the CLI resolves the default format from TTY-ness, and
          // a captured test stream is never a TTY (so it defaults to json).
          "--format",
          "human",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const lines = run.stdout.trimEnd().split("\n");
    // The link comes AFTER the payload, on its own line, so a human reader
    // can act on the upload they just made without leaving the terminal.
    assert.equal(
      lines.at(-1),
      "View: http://127.0.0.1:" +
        new URL(fixture.baseUrl).port +
        "/evals/suite/suite-1/runs/run-case?project=proj-alpha",
    );
  } finally {
    await fixture.close();
  }
});

test("eval status appends a View link in human format", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "status",
            "--project",
            "proj-alpha",
            "--run",
            "run-1",
          ),
          "--format",
          "human",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const lines = run.stdout.trimEnd().split("\n");
    assert.equal(
      lines.at(-1),
      "View: http://127.0.0.1:" +
        new URL(fixture.baseUrl).port +
        "/evals/suite/suite-1/runs/run-1?project=proj-alpha",
    );
  } finally {
    await fixture.close();
  }
});

test("eval status renders an actionable decision summary for failed runs", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "status",
            "--project",
            "proj-alpha",
            "--run",
            "run-failed",
          ),
          "--format",
          "human",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.match(run.stdout, /Decision summary: failed — 0\/1 cases passed/);
    assert.match(run.stdout, /first failed stage call/);
    assert.match(run.stdout, /next action: review the authored arguments/);
    assert.match(run.stdout, /View: /);
    assert.equal(run.stderr.includes("Decision summary:"), false);
  } finally {
    await fixture.close();
  }
});

test("eval status does not invent a stage for a setup abort", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "status",
            "--project",
            "proj-alpha",
            "--run",
            "run-setup",
          ),
          "--format",
          "human",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.match(run.stdout, /no first failed stage — did not reach the server's stages/);
    assert.doesNotMatch(run.stdout, /first failed stage (connection|discovery|selection|call|response|userValue)/);
  } finally {
    await fixture.close();
  }
});

test("--format json output stays byte-identical — no View line", async () => {
  const fixture = await startEvalFixture();
  try {
    for (const args of [
      ["run", "--project", "proj-alpha", "--suite", "suite-1"],
      ["status", "--project", "proj-alpha", "--run", "run-1"],
    ]) {
      const run = await captureProcessOutput(() =>
        main([...evalArgv(fixture.baseUrl, ...args), "--format", "json"], {
          telemetry: telemetryDisabled,
        }),
      );

      assert.equal(run.result.exitCode, 0);
      // Scripts parse this stream. One line, still valid JSON end to end.
      assert.equal(run.stdout.trimEnd().split("\n").length, 1);
      assert.doesNotThrow(() => JSON.parse(run.stdout));
      assert.ok(!run.stdout.includes("View:"));
    }
  } finally {
    await fixture.close();
  }
});

test("eval run --format json emits exactly one document, containing disclosure", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.equal(run.stdout.trimEnd().split("\n").length, 1);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.disclosure.contractVersion, 1);
    assert.equal(parsed.disclosure.execution.engine, "emulated");
    assert.equal(fixture.disclosureRequests.length, 1);
  } finally {
    await fixture.close();
  }
});

test("eval run prints the disclosure block in human mode, before the run link", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
          ),
          "--format",
          "human",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const disclosureIndex = run.stdout.indexOf("Pre-run disclosure:");
    const viewIndex = run.stdout.indexOf("View:");
    assert.notEqual(disclosureIndex, -1);
    assert.notEqual(viewIndex, -1);
    assert.ok(disclosureIndex < viewIndex);
    assert.match(run.stdout, /Execution: emulated/);
    // Each firing touchpoint gets its OWN destination line — pooling them
    // under the first touchpoint's destination would misattribute where the
    // others' evidence goes.
    assert.match(
      run.stdout,
      /Goal-completion judge.*OpenRouter \(openrouter\.ai\)/,
    );
    assert.match(
      run.stdout,
      /Run insights report.*A wholly different destination/,
    );
    assert.ok(
      !/Goal-completion judge.*A wholly different destination/.test(
        run.stdout,
      ),
    );
    // Capture/redaction facts are the human's only pre-launch view of what
    // happens to content once it exists (the standalone disclosure command
    // is excluded) — a consequential setting like a non-DLP redaction module
    // must not be silently absent from the printed block.
    assert.match(run.stdout, /Capture: full · reporting standard/);
    assert.match(
      run.stdout,
      /Redaction: credential-shaped — NOT a DLP system \(not DLP\)/,
    );
    assert.match(
      run.stdout,
      /Export defaults: excludes content \(redacted by default\)/,
    );
    // "fires automatically" vs "fires only if asked" are different consent
    // stories — the fixture's goalCompletion touchpoint is
    // explicit-request-only, runInsights is auto-on-completion, and this
    // renderer must not flatten that distinction just because both "fire".
    assert.match(
      run.stdout,
      /Goal-completion judge fires only if explicitly requested/,
    );
    assert.match(
      run.stdout,
      /Run insights report fires automatically on completion/,
    );
    // The raw enum plus policy days beside it can read as self-contradictory
    // for an org whose policy number isn't enforced — "kept-indefinitely
    // (30d policy)" makes the 30 the number a reader takes away. Print the
    // humanized claim only, matching the UI's already-correct phrasing.
    assert.match(run.stdout, /Retention: swept after 30 day\(s\)/);
    assert.equal(run.stdout.includes("kept-indefinitely"), false);
  } finally {
    await fixture.close();
  }
});

test("eval run --host prints a disclosure block, forwarding the host (G4c)", async () => {
  // Before G4c a `--host` run printed NO disclosure block at all: the SDK
  // skipped the fetch because the contract had no host selector. The human
  // renderer never needed a change — it prints whatever comes back — so this
  // asserts the un-refusal end to end: the host reaches the query, and the
  // block appears for a host-targeted launch exactly as for an ordinary one.
  const fixture = await startEvalFixture({
    suiteDetail: { hosts: [{ id: "host-claude", name: "Claude" }] },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--host",
            "Claude",
          ),
          "--format",
          "human",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.equal(fixture.disclosureRequests.length, 1);
    assert.equal(fixture.disclosureRequests[0]?.host, "host-claude");
    // ONE AXIS — never a host and an environment in the same query.
    assert.equal(fixture.disclosureRequests[0]?.environmentId, null);
    assert.equal(fixture.disclosureRequests[0]?.environmentIds, null);
    assert.notEqual(run.stdout.indexOf("Pre-run disclosure:"), -1);
    assert.match(run.stdout, /Execution: emulated/);
    // WHAT WAS DISCLOSED IS WHAT RAN. Asserting only the disclosure query
    // would still pass if the launch dropped the host or picked a different
    // one — the exact divergence this contract exists to rule out.
    const launched = fixture.runBodies.at(-1) as Record<string, unknown>;
    assert.equal(launched.namedHostId, "host-claude");
    assert.equal(launched.environmentId, undefined);
  } finally {
    await fixture.close();
  }
});

test("eval run prints a disclosure-unavailable line in human mode when the fetch fails", async () => {
  // An absent disclosure with NO output at all is indistinguishable from "no
  // disclosure feature on this build" — this is the failure counterpart to
  // the happy-path block above.
  const fixture = await startEvalFixture({ disclosureUnavailable: true });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
          ),
          "--format",
          "human",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.match(
      run.stdout,
      /Pre-run disclosure unavailable: this deployment predates the pre-run disclosure contract/,
    );
    assert.equal(run.stdout.includes("Pre-run disclosure:"), false);
  } finally {
    await fixture.close();
  }
});

test("eval run --wait writes failed JSON and JUnit reports before returning", async () => {
  const fixture = await startEvalFixture({ runCaseResult: "failed" });
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-eval-run-"));
  const jsonPath = path.join(directory, "report.json");
  const junitPath = path.join(directory, "report.xml");
  try {
    const jsonRun = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--wait",
          "--reporter",
          "json-summary",
          "--out",
          jsonPath,
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    const jsonRaw = await readFile(jsonPath, "utf8");
    const json = JSON.parse(jsonRaw);

    // A run that COMPLETED having FAILED its cases is the one and only
    // producer of exit 1 under --wait's six-code contract.
    assert.equal(jsonRun.result.exitCode, 1);
    assert.deepEqual(
      {
        schemaVersion: json.schemaVersion,
        kind: json.kind,
        passed: json.passed,
        summary: json.summary,
        caseCount: json.cases.length,
      },
      {
        schemaVersion: 1,
        kind: "eval-run",
        passed: false,
        summary: {
          total: 1,
          passed: 0,
          failed: 1,
          byCategory: {
            eval: { total: 1, passed: 0, failed: 1 },
          },
        },
        caseCount: 1,
      },
    );
    assert.equal(json.cases[0].error, "Authorization: [REDACTED]");
    assert.equal(jsonRaw.includes("top-secret"), false);
    // A reporter's stdout output must stay ONE parseable document: the
    // pre-run disclosure block prints from `onDisclosure` on this same
    // stream, and if it isn't suppressed for a reporter run it prepends
    // "Pre-run disclosure:" prose ahead of the JSON, breaking a CI caller
    // that parses stdout as JSON.
    assert.equal(jsonRun.stdout.includes("Pre-run disclosure:"), false);
    JSON.parse(jsonRun.stdout);

    const junitRun = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--wait",
          "--reporter",
          "junit-xml",
          "--out",
          junitPath,
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    const junit = await readFile(junitPath, "utf8");

    assert.equal(junitRun.result.exitCode, 1);
    assert.match(junit, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.equal(junit.match(/<testcase /g)?.length, 1);
    assert.match(junit, /tests="1"/);
    assert.match(junit, /failures="1"/);
    assert.match(junit, /<failure message="Authorization: \[REDACTED\]"/);
    assert.equal(junit.includes("top-secret"), false);
    assert.equal(junitRun.stdout.includes("Pre-run disclosure:"), false);
    assert.match(junitRun.stdout, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  } finally {
    await fixture.close();
  }
});

test("eval run --format human --reporter redirects the disclosure block to stderr, not stdout", async () => {
  // A CI user on --reporter is the population most likely to want a record
  // of what a run discloses, and the fetch happens regardless of whether
  // anyone consumes it — fully suppressing the block would leave them no
  // route to it at all. stderr keeps stdout a single parseable document
  // while still surfacing the disclosure somewhere visible.
  const fixture = await startEvalFixture({ runCaseResult: "failed" });
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-eval-run-"));
  const jsonPath = path.join(directory, "report.json");
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--wait",
          "--reporter",
          "json-summary",
          "--out",
          jsonPath,
          "--format",
          "human",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    // A completed run with a failed verdict is the sole producer of exit 1
    // under --wait's six-code contract (E1) — unrelated to this test's own
    // concern (where the disclosure block gets routed).
    assert.equal(run.result.exitCode, 1);
    assert.equal(run.stdout.includes("Pre-run disclosure:"), false);
    JSON.parse(await readFile(jsonPath, "utf8"));
    assert.match(run.stderr, /Pre-run disclosure:/);
    assert.match(run.stderr, /Execution: emulated/);
  } finally {
    // A nonzero exit code otherwise leaks into `process.exitCode` for
    // whichever `main()` call in this file runs last.
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval run --wait --reporter html writes the artifact atomically and to stdout", async () => {
  const fixture = await startEvalFixture({ runCaseResult: "failed" });
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-eval-run-"));
  const htmlPath = path.join(directory, "report.html");
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--wait",
          "--reporter",
          "html",
          "--out",
          htmlPath,
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    const html = await readFile(htmlPath, "utf8");

    // A completed run with a failed verdict is the sole producer of exit 1
    // under --wait's six-code contract (E1) — unrelated to this test's own
    // concern (whether the html reporter/artifact wiring works).
    assert.equal(run.result.exitCode, 1);
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /Authorization: \[REDACTED\]/);
    assert.equal(html.includes("top-secret"), false);
    assert.equal(/<script/i.test(html), false);
    // Written to the file AND stdout — `--out` and `--reporter` are two
    // terminals for the same run.
    assert.match(run.stdout, /^<!doctype html>/i);
    assert.equal(run.stdout, html);
  } finally {
    // A nonzero exit code otherwise leaks into `process.exitCode` for
    // whichever `main()` call in this file runs last.
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval run --reporter html without --wait is still a usage error", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--reporter",
          "html",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 2);
    assert.match(run.stderr, /--reporter and --out require --wait\./);
  } finally {
    await fixture.close();
  }
});

test("eval run writes an error report after a completed-run reporting failure", async () => {
  const fixture = await startEvalFixture({
    runCaseIterationFetchError: true,
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-eval-run-"));
  const jsonPath = path.join(directory, "report.json");
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--wait",
          "--out",
          jsonPath,
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    const report = JSON.parse(await readFile(jsonPath, "utf8"));

    // The run itself passed; only its report could not be assembled — "no
    // valid verdict OBSERVED" (5), never the verdict-failure code (1) and
    // never an infrastructure code (4) for something the CLI observed after
    // evaluation had already run.
    assert.equal(run.result.exitCode, 5);
    assert.equal(report.passed, false);
    assert.equal(report.cases.length, 1);
    assert.partialDeepStrictEqual(report.cases[0], {
      id: "run-case:iterations",
      category: "reporting",
      passed: false,
    });
    assert.match(report.cases[0].error, /iteration results unavailable/);
    assert.equal(report.metadata.runs[0].status, "completed");
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval run exits 3, not 5, when the report-fetch failure is auth-shaped", async () => {
  // Same shape as the previous test, but the iteration fetch failed with a
  // real 401 (the credential died between the terminal poll and the report
  // fetch) rather than a generic infra error. That must read as 3 (auth),
  // not 5 (no valid verdict observed) — a token that expired is a
  // different, more actionable claim than "the report never assembled".
  const fixture = await startEvalFixture({
    runCaseIterationFetchAuthError: true,
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-eval-run-"));
  const jsonPath = path.join(directory, "report.json");
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--wait",
          "--out",
          jsonPath,
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 3);
    const stderrLines = run.stderr.trim().split("\n");
    const failure = JSON.parse(stderrLines[stderrLines.length - 1]);
    assert.equal(failure.error.code, "OPERATIONAL_ERROR");
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval run writes completed cases and launch failures before a partial exit", async () => {
  const fixture = await startEvalFixture({
    suiteDetail: {
      hosts: [
        { id: "host-claude", name: "Claude Code" },
        { id: "host-chatgpt", name: "ChatGPT" },
      ],
    },
    groupFailures: {
      "host-chatgpt": { code: "HOST_OFFLINE", message: "host unavailable" },
    },
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-eval-run-"));
  const jsonPath = path.join(directory, "report.json");
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--all-targets",
          "--wait",
          "--out",
          jsonPath,
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    const report = JSON.parse(await readFile(jsonPath, "utf8"));

    // A partial fan-out whose started run PASSED is a setup defect the CLI
    // observed directly (one target never launched) — 4, not the verdict
    // code 1. See "Partial fan-out whose started runs all passed" in E1.
    assert.equal(run.result.exitCode, 4);
    assert.equal(report.passed, false);
    assert.deepEqual(
      report.cases
        .map(
          (entry: { category: string; passed: boolean; error?: string }) => ({
            category: entry.category,
            passed: entry.passed,
            ...(entry.error ? { error: entry.error } : {}),
          }),
        )
        .sort((left: { category: string }, right: { category: string }) =>
          left.category.localeCompare(right.category),
        ),
      [
        { category: "eval", passed: true },
        { category: "launch", passed: false, error: "host unavailable" },
      ],
    );
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval run --wait still prints the launch receipt when the wait times out", async () => {
  // The run ids are the only handle a caller has on runs it has already PAID
  // for. Raising the timeout before the receipt is written left
  // `--wait --format json > out.json` holding an empty file.
  const fixture = await startEvalFixture({ runCaseStatus: "running" });
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--wait",
          "--wait-timeout",
          "1",
          "--format",
          "json",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    // A wait deadline with the run still non-terminal is "no valid verdict
    // observed" (5), not the launch/completion code (1).
    assert.equal(run.result.exitCode, 5);
    const receipt = JSON.parse(run.stdout.trim());
    assert.equal(receipt.launch.targets[0].runId, "run-case");
    assert.deepEqual(receipt.runs, []);
    // The failure itself is still reported, and names the runs machine-readably
    // so a pipeline never has to parse English out of stderr.
    // stderr also carries the cloud-context announce line; the error document
    // is the last thing written to it.
    const stderrLines = run.stderr.trim().split("\n");
    const failure = JSON.parse(stderrLines[stderrLines.length - 1]);
    assert.equal(failure.error.code, "OPERATIONAL_ERROR");
    assert.deepEqual(failure.error.details.runIds, ["run-case"]);
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval run keeps a lowercase launch failure code out of the redactor", async () => {
  // `billing_limit_reached` and friends are the v1 API's real vocabulary. Under
  // the key name `code` the telemetry redactor read them as OAuth authorization
  // codes and replaced every one with "[REDACTED]" — the out-of-credits case
  // included. SCREAMING_SNAKE codes survived either way, which is why the
  // sibling test above never caught it.
  const fixture = await startEvalFixture({
    suiteDetail: {
      hosts: [
        { id: "host-claude", name: "Claude Code" },
        { id: "host-chatgpt", name: "ChatGPT" },
      ],
    },
    groupFailures: {
      "host-chatgpt": {
        code: "billing_limit_reached",
        message: "out of credits",
      },
    },
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-eval-run-"));
  const jsonPath = path.join(directory, "report.json");
  try {
    await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--all-targets",
          "--wait",
          "--out",
          jsonPath,
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    const report = JSON.parse(await readFile(jsonPath, "utf8"));
    const launchCase = report.cases.find(
      (entry: { category: string }) => entry.category === "launch",
    );

    assert.equal(launchCase.error, "out of credits");
    assert.equal(launchCase.details.errorCode, "billing_limit_reached");
  } finally {
    await fixture.close();
  }
});

test("eval gate writes its JUnit report before a gate-failure exit", async () => {
  const fixture = await startEvalFixture({ runOneResult: "failed" });
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-eval-gate-"));
  const junitPath = path.join(directory, "report.xml");
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "gate",
          "--project",
          "proj-alpha",
          "--run",
          "run-1",
          "--wait",
          "--min-pass-rate-percent",
          "100",
          "--reporter",
          "junit-xml",
          "--out",
          junitPath,
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    const junit = await readFile(junitPath, "utf8");

    assert.equal(run.result.exitCode, 1);
    assert.match(junit, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    assert.match(junit, /<failure message="1\/2 iterations passed"/);
    assert.match(junit, /goal completion failed/);
  } finally {
    await fixture.close();
  }
});

test("eval gate --reporter html --out writes an HTML report before a gate-failure exit", async () => {
  const fixture = await startEvalFixture({ runOneResult: "failed" });
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-eval-gate-"));
  const htmlPath = path.join(directory, "report.html");
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "gate",
          "--project",
          "proj-alpha",
          "--run",
          "run-1",
          "--wait",
          "--min-pass-rate-percent",
          "100",
          "--reporter",
          "html",
          "--out",
          htmlPath,
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    const html = await readFile(htmlPath, "utf8");

    assert.equal(run.result.exitCode, 1);
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /1\/2 iterations passed/);
    assert.match(html, /goal completion failed/);
    assert.equal(/<script/i.test(html), false);
    // A measured gate failure — MUST stay red, not the neutral incomplete
    // color a fetch/wait failure gets below.
    assert.match(html, /badge-fail">failed/);
  } finally {
    await fixture.close();
  }
});

// A gate that never got to evaluate (network/auth/timeout, or an unreadable
// run) is INCOMPLETE, not a measured failure — the whole reason it exits 3
// and not 1. `--reporter`/`--out` must still be honored on this path, and the
// HTML verdict must render neutral, never the same red a real failure gets.
test("eval gate --reporter html --out honors the reporter on a fetch failure, and renders it neutral", async () => {
  const fixture = await startEvalFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-eval-gate-"));
  const htmlPath = path.join(directory, "report.html");
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "gate",
          "--project",
          "proj-alpha",
          // No route mocks this run id: the fixture's default 404 makes
          // `getEvalRun` throw, landing in the fetch-failure catch path.
          "--run",
          "run-does-not-exist",
          "--reporter",
          "html",
          "--out",
          htmlPath,
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    const html = await readFile(htmlPath, "utf8");

    assert.equal(run.result.exitCode, 3);
    assert.match(html, /^<!doctype html>/i);
    assert.match(run.stdout, /^<!doctype html>/i);
    assert.equal(run.stdout, html);
    assert.match(html, /badge-neutral">inconclusive/);
    assert.equal(html.includes('badge-fail">'), false);
  } finally {
    await fixture.close();
  }
});

// `--out` and `--reporter` are two terminals for the same artifact for every
// other reporting command (`eval run`, `eval gate`) — `eval compare` must not
// be the one place `--out` always writes raw JSON regardless of `--reporter`.
test("eval compare --reporter html --out writes the reporter-selected format to the file", async () => {
  const fixture = await startEvalFixture({ compare: { notFound: true } });
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-eval-compare-"));
  const htmlPath = path.join(directory, "report.html");
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "compare",
          "--project",
          "proj-alpha",
          "--run",
          "run-1",
          "--reporter",
          "html",
          "--out",
          htmlPath,
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    const html = await readFile(htmlPath, "utf8");

    // Incomplete (no baseline), not a regression: exit code says so, and the
    // rendered verdict must agree — neutral, never the red a real failure
    // gets, even though `passed` is false either way.
    assert.match(html, /^<!doctype html>/i);
    assert.equal(/<script/i.test(html), false);
    assert.match(run.stdout, /^<!doctype html>/i);
    assert.equal(run.stdout, html);
    assert.match(html, /badge-neutral">inconclusive/);
    assert.equal(html.includes('badge-fail">'), false);
  } finally {
    await fixture.close();
  }
});

// ── eval gate --baseline ────────────────────────────────────────────────────

test("eval gate rejects a SHA-shaped --baseline before any request", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "gate",
          "--project",
          "proj-alpha",
          "--run",
          "run-1",
          "--baseline",
          "a".repeat(40),
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    assert.equal(run.result.exitCode, 2);
    assert.match(run.stderr, /SHA baselines are not supported yet/);
    // A usage error caught before parsing must never spend a request.
    assert.equal(fixture.authHeaders.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval gate rejects a blank --baseline, e.g. an unset CI variable interpolated into the flag", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "gate",
          "--project",
          "proj-alpha",
          "--run",
          "run-1",
          "--baseline",
          "",
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    assert.equal(run.result.exitCode, 2);
    assert.match(run.stderr, /must not be blank/);
    // A usage error caught before parsing must never spend a request, and
    // MUST NOT silently fall through to a threshold-only, exit-0 gate.
    assert.equal(fixture.authHeaders.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval gate rejects using the gated run as its own baseline", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "gate",
          "--project",
          "proj-alpha",
          "--run",
          "run-1",
          "--baseline",
          "run-1",
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    assert.equal(run.result.exitCode, 2);
    assert.match(run.stderr, /cannot be its own baseline/);
    assert.equal(fixture.authHeaders.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval gate rejects a comparative tuning flag without --baseline", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "gate",
          "--project",
          "proj-alpha",
          "--run",
          "run-1",
          "--min-sample-size",
          "10",
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    assert.equal(run.result.exitCode, 2);
    assert.match(run.stderr, /pass --baseline/);
    assert.equal(fixture.authHeaders.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval gate --baseline exits 3 when no baseline resolves", async () => {
  const fixture = await startEvalFixture({ compare: { notFound: true } });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "gate",
            "--project",
            "proj-alpha",
            "--run",
            "run-1",
            "--wait",
            "--baseline",
            "run-baseline",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );
    assert.equal(run.result.exitCode, 3);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.gate.outcome, "incomplete");
    assert.match(
      payload.gate.verdicts
        .map((v: { message: string }) => v.message)
        .join("; "),
      /no baseline to compare against/,
    );
  } finally {
    await fixture.close();
  }
});

test("eval gate --baseline exits 1 on a statistically significant regression", async () => {
  // `run-1` passes its own (absent) threshold trivially; the baseline's
  // 56/70 -> 48/80 is the oracle-pinned regression from `eval-compare-exit-
  // code.test.ts`, so the merged exit code comes ENTIRELY from the
  // comparative half.
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "gate",
            "--project",
            "proj-alpha",
            "--run",
            "run-1",
            "--wait",
            "--baseline",
            "run-baseline",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );
    assert.equal(run.result.exitCode, 1);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.gate.outcome, "failed");
    const regression = payload.gate.verdicts.find(
      (v: { gate: string }) => v.gate === "passRateRegression",
    );
    assert.equal(regression?.status, "failed");
  } finally {
    await fixture.close();
  }
});

test("eval gate --baseline still evaluates the comparison when the run's own iterations fail to fetch", async () => {
  // `--out` forces the iteration fetch for `run-1` itself (needed for the
  // report), and that fetch fails. `/compare` is a SEPARATE request that
  // does not depend on those iterations — the regression it finds must still
  // reach exit 1, not be silently downgraded to exit 3 by an unrelated fetch
  // hiccup on the other half of the report.
  const fixture = await startEvalFixture({ runOneIterationFetchError: true });
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "mcpjam-eval-gate-baseline-fetch-error-"),
  );
  const reportPath = path.join(directory, "report.json");
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "gate",
          "--project",
          "proj-alpha",
          "--run",
          "run-1",
          "--wait",
          "--baseline",
          "run-baseline",
          "--reporter",
          "json-summary",
          "--out",
          reportPath,
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    assert.equal(run.result.exitCode, 1, run.stderr);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const gateCase = report.cases.find((c: { id: string }) => c.id === "gate");
    const gates = gateCase.details.verdicts.map(
      (v: { gate: string }) => v.gate,
    );
    // Both survive: the local fetch failure AND the real regression.
    assert.ok(gates.includes("fetch"));
    assert.ok(gates.includes("passRateRegression"));
    const regression = gateCase.details.verdicts.find(
      (v: { gate: string }) => v.gate === "passRateRegression",
    );
    assert.equal(regression.status, "failed");
  } finally {
    await fixture.close();
  }
});

test("eval gate --baseline: a threshold miss and a baseline regression fold into one report", async () => {
  const fixture = await startEvalFixture({ runOneResult: "failed" });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "gate",
            "--project",
            "proj-alpha",
            "--run",
            "run-1",
            "--wait",
            "--min-pass-rate-percent",
            "100",
            "--baseline",
            "run-baseline",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );
    assert.equal(run.result.exitCode, 1);
    const payload = JSON.parse(run.stdout);
    const gates = payload.gate.verdicts.map((v: { gate: string }) => v.gate);
    // Both families' verdicts survive the merge — neither buries the other.
    assert.ok(gates.includes("minimumPassRate"));
    assert.ok(gates.includes("passRateRegression"));
  } finally {
    await fixture.close();
  }
});

test("eval gate --baseline writes provenance into the JSON report, notRecorded included", async () => {
  const fixture = await startEvalFixture();
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "mcpjam-eval-gate-baseline-")
  );
  const reportPath = path.join(directory, "report.json");
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "gate",
          "--project",
          "proj-alpha",
          "--run",
          "run-1",
          "--wait",
          "--baseline",
          "run-baseline",
          "--reporter",
          "json-summary",
          "--out",
          reportPath,
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    assert.equal(run.result.exitCode, 1);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const provenance = report.metadata.baselineComparison;
    assert.equal(provenance.requestedBaseline, "run-baseline");
    assert.equal(provenance.baseRunId, "run-baseline");
    assert.equal(provenance.compareRunId, "run-1");
    assert.equal(provenance.compatibility.caseSetChanged, false);
    // The pin names "comparable case ids" explicitly — not just the boolean.
    assert.deepEqual(provenance.compatibility.comparableCaseIds, ["ck_a"]);
    assert.deepEqual(provenance.compatibility.incompatibleCases, []);
    // Dimensions the pinned contract requires but the `/compare` wire does not
    // carry yet must be explicit, never silently dropped.
    assert.equal(provenance.notRecorded.modelProvider, "notRecorded");
    assert.equal(provenance.notRecorded.hostHarness, "notRecorded");
    assert.equal(
      provenance.notRecorded.serverEnvironmentIdentity,
      "notRecorded"
    );
    // The same provenance rides on the "gate" case row, so `--reporter
    // junit-xml` (which has no metadata section) still carries it.
    const gateCase = report.cases.find((c: { id: string }) => c.id === "gate");
    assert.equal(
      gateCase.details.baseline.notRecorded.modelProvider,
      "notRecorded"
    );
  } finally {
    await fixture.close();
  }
});

test("eval gate --baseline sends the TRIMMED value on the wire, not the padded one", async () => {
  // Validation checks the trimmed value; if the raw one were forwarded
  // instead, `baseRunId` on the wire (and so the provenance echoed back)
  // would still carry the padding — observable proof of the bug even though
  // this fixture's mock backend does not itself reject an unknown run id.
  const fixture = await startEvalFixture();
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "mcpjam-eval-gate-baseline-trim-"),
  );
  const reportPath = path.join(directory, "report.json");
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "gate",
          "--project",
          "proj-alpha",
          "--run",
          "run-1",
          "--wait",
          "--baseline",
          "  run-baseline  ",
          "--reporter",
          "json-summary",
          "--out",
          reportPath,
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    assert.equal(run.result.exitCode, 1);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    const provenance = report.metadata.baselineComparison;
    assert.equal(provenance.requestedBaseline, "run-baseline");
    assert.equal(provenance.baseRunId, "run-baseline");
  } finally {
    await fixture.close();
  }
});

test("eval gate --baseline exits 3 when the case set changed, not 1", async () => {
  // Same regressed pass-rate numbers as the exit-1 test above, but the case
  // set churned — the population rule makes the whole-run rate incomparable,
  // and that must never read as a regression.
  const fixture = await startEvalFixture({ compare: { caseSetChanged: true } });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "gate",
            "--project",
            "proj-alpha",
            "--run",
            "run-1",
            "--wait",
            "--baseline",
            "run-baseline",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );
    assert.equal(run.result.exitCode, 3);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.gate.outcome, "incomplete");
    const regression = payload.gate.verdicts.find(
      (v: { gate: string }) => v.gate === "passRateRegression",
    );
    assert.equal(regression?.status, "non_gateable");
  } finally {
    await fixture.close();
  }
});

test("eval judge POSTs the per-run override and echoes the pending receipt", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "judge",
            "--project",
            "proj-alpha",
            "--run",
            "run-1",
            "--force",
            "--enable",
            "--judge-model",
            "openai/gpt-5",
            "--judge-threshold",
            "0.8",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.deepEqual(fixture.createBodies.at(-1), {
      force: true,
      enable: true,
      model: "openai/gpt-5",
      threshold: 0.8,
    });
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.judge.status, "pending");
  } finally {
    await fixture.close();
  }
});

test("eval judge sends an empty body when no override was asked for", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "judge",
            "--project",
            "proj-alpha",
            "--run",
            "run-1",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    // An empty body means "grade with the suite's config" — sending
    // `enable: false` or a null model would state something the caller did not.
    assert.deepEqual(fixture.createBodies.at(-1), {});
  } finally {
    await fixture.close();
  }
});

test("eval judge rejects an out-of-range --judge-threshold before any request", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "judge",
          "--project",
          "proj-alpha",
          "--run",
          "run-1",
          "--judge-threshold",
          "1.5",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.notEqual(run.result.exitCode, 0);
    assert.match(run.stderr, /--judge-threshold must be a number between 0 and 1/);
    // It SPENDS — a bad flag must not reach the wire.
    assert.equal(fixture.createBodies.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval judge rejects a blank --judge-threshold before any request", async () => {
  const fixture = await startEvalFixture();
  try {
    for (const value of ["", "   "]) {
      const run = await captureProcessOutput(() =>
        main(
          evalArgv(
            fixture.baseUrl,
            "judge",
            "--project",
            "proj-alpha",
            "--run",
            "run-1",
            "--judge-threshold",
            value,
          ),
          { telemetry: telemetryDisabled },
        ),
      );
      assert.notEqual(run.result.exitCode, 0, `accepted ${JSON.stringify(value)}`);
      assert.match(
        run.stderr,
        /--judge-threshold must be a number between 0 and 1/,
      );
    }
    assert.equal(fixture.createBodies.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval judge rejects a blank --judge-model before any request", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "judge",
          "--project",
          "proj-alpha",
          "--run",
          "run-1",
          "--judge-model",
          "   ",
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    assert.equal(run.result.exitCode, 2, run.stderr);
    assert.match(run.stderr, /Invalid input:.*model/);
    assert.equal(fixture.createBodies.length, 0);
    assert.equal(fixture.authHeaders.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval iterations rejects a bad --limit before any request", async () => {
  const fixture = await startEvalFixture();
  try {
    for (const value of ["abc", "0", "201", "-1"]) {
      const run = await captureProcessOutput(() =>
        main(
          evalArgv(
            fixture.baseUrl,
            "iterations",
            "--project",
            "proj-alpha",
            "--run",
            "run-1",
            "--limit",
            value,
          ),
          { telemetry: telemetryDisabled },
        ),
      );
      assert.equal(run.result.exitCode, 2, `accepted --limit ${JSON.stringify(value)}: ${run.stderr}`);
      assert.match(run.stderr, /Invalid input:.*limit/);
    }
    assert.equal(fixture.authHeaders.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval status summarizes the judges that graded, and stays silent about the rest", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "status",
            "--project",
            "proj-alpha",
            "--run",
            "run-1",
          ),
          "--format",
          "human",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const lines = run.stdout.trimEnd().split("\n");
    assert.equal(
      lines.at(-2),
      "Judge goal completion: 1/2 passed at threshold 0.7 — openai/gpt-5.4-mini",
    );
    // groundedness was never requested, so it gets no SUMMARY line — listing
    // it would turn a status read into a catalog of judges the platform could
    // have run. (It is still in the JSON payload above, which is the point:
    // the envelope is complete, the summary is only what happened.)
    assert.ok(!run.stdout.includes("Judge groundedness"));
    // The View link stays the closing line.
    assert.match(lines.at(-1) ?? "", /^View: /);
  } finally {
    await fixture.close();
  }
});

test("eval update --min-iterations off sends an explicit null", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "update",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--min-iterations",
            "off",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const patchBody = fixture.createBodies.at(-1) as {
      settings?: { minimumIterations?: number | null };
    };
    // NOT undefined: `undefined` means "leave alone" the whole way down, so a
    // dropped null would make "off" a no-op that still reports success.
    assert.ok("minimumIterations" in (patchBody.settings ?? {}));
    assert.equal(patchBody.settings?.minimumIterations, null);
  } finally {
    await fixture.close();
  }
});

test("eval update --min-iterations sends the number", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "update",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--min-iterations",
            "3",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const patchBody = fixture.createBodies.at(-1) as {
      settings?: { minimumIterations?: number | null };
    };
    assert.equal(patchBody.settings?.minimumIterations, 3);
  } finally {
    await fixture.close();
  }
});

test("eval update rejects an out-of-range --min-iterations before any write", async () => {
  const fixture = await startEvalFixture();
  try {
    for (const value of ["0", "11", "2.5"]) {
      const run = await captureProcessOutput(() =>
        main(
          evalArgv(
            fixture.baseUrl,
            "update",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--min-iterations",
            value,
          ),
          { telemetry: telemetryDisabled },
        ),
      );
      assert.notEqual(run.result.exitCode, 0);
      assert.match(
        run.stderr,
        /--min-iterations must be a whole number from 1 to 10/,
      );
    }
    assert.equal(fixture.createBodies.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval update --computer-image sends the selector, off sends null", async () => {
  const fixture = await startEvalFixture();
  try {
    const set = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "update",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--computer-image",
            "Playwright",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );
    assert.equal(set.result.exitCode, 0);
    let patchBody = fixture.createBodies.at(-1) as {
      environment?: Record<string, unknown>;
    };
    // The server resolves name-or-id; the CLI forwards the selector as typed
    // and does NOT restate servers, which is what preserves them.
    assert.deepEqual(patchBody.environment, {
      computerEnvironment: "Playwright",
    });

    const cleared = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "update",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--computer-image",
            "off",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );
    assert.equal(cleared.result.exitCode, 0);
    patchBody = fixture.createBodies.at(-1) as {
      environment?: Record<string, unknown>;
    };
    assert.deepEqual(patchBody.environment, { computerEnvironment: null });
  } finally {
    await fixture.close();
  }
});

test("eval checks list reports connected and connectable repositories", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(fixture.baseUrl, "checks", "list", "--project", "proj-alpha"),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    const payload = JSON.parse(run.stdout);
    assert.equal(payload.checks.available, true);
    assert.equal(payload.checks.items[0].repo, "acme/widgets");
    // An unchosen policy stays null rather than being reported as fail_open.
    assert.equal(payload.checks.items[0].outagePolicy, null);
    assert.deepEqual(payload.checks.connectable, [{ repo: "acme/widgets" }]);
  } finally {
    await fixture.close();
  }
});

test("eval checks connect maps the hyphenated policy onto the wire spelling", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "checks",
            "connect",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--repo",
            "acme/widgets",
            "--outage-policy",
            "fail-closed",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.deepEqual(fixture.createBodies.at(-1), {
      projectId: "proj-alpha",
      suiteId: "suite-1",
      repo: "acme/widgets",
      outagePolicy: "fail_closed",
    });
  } finally {
    await fixture.close();
  }
});

test("eval checks connect refuses an unknown outage policy before any write", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "checks",
          "connect",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--repo",
          "acme/widgets",
          "--outage-policy",
          "maybe",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.notEqual(run.result.exitCode, 0);
    assert.match(run.stderr, /--outage-policy must be/);
    // It reaches a shared repository — a bad flag must not get that far.
    assert.equal(fixture.createBodies.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval checks connect requires an outage policy at all", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "checks",
          "connect",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--repo",
          "acme/widgets",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.notEqual(run.result.exitCode, 0);
    assert.equal(fixture.createBodies.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval run refuses to guess a target when several are attached", async () => {
  // The whole point of the explicit-fan-out rule: guessing here is guessing
  // how much of the caller's money to spend, so the CLI exits non-zero with
  // the op's own message and starts nothing.
  const fixture = await startEvalFixture({
    suiteDetail: {
      hosts: [
        { id: "host-claude", name: "Claude" },
        { id: "host-chatgpt", name: "ChatGPT" },
      ],
    },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.notEqual(run.result.exitCode, 0);
    assert.match(run.stderr, /TARGET_REQUIRED/);
    // The message already enumerates the choices — the CLI does not
    // re-implement that list and cannot drift from it.
    assert.match(run.stderr, /Claude/);
    assert.match(run.stderr, /ChatGPT/);
    assert.equal(fixture.runBodies.length, 0);
    assert.equal(fixture.groupBodies.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval run --all-targets hits the grouped endpoint exactly once", async () => {
  const fixture = await startEvalFixture({
    suiteDetail: {
      hosts: [
        { id: "host-claude", name: "Claude" },
        { id: "host-chatgpt", name: "ChatGPT" },
      ],
    },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--all-targets",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    // ONE grouped launch, never N single ones: those would each be metered
    // separately and could not fit under the concurrency cap.
    assert.equal(fixture.groupBodies.length, 1);
    assert.equal(fixture.runBodies.length, 0);
    assert.deepEqual(
      (fixture.groupBodies[0] as { targets: unknown }).targets,
      [{ namedHostId: "host-claude" }, { namedHostId: "host-chatgpt" }],
    );

    // EXACTLY ONE JSON document, so a CI caller can parse stdout directly.
    const payload = JSON.parse(run.stdout) as {
      outcome: string;
      startedCount: number;
      runGroupId: string;
      runId: string;
      targets: unknown[];
    };
    assert.equal(payload.outcome, "started");
    assert.equal(payload.startedCount, 2);
    assert.equal(payload.runGroupId, "grp-1");
    // The deprecated top-level mirror survives for scripts reading `runId`.
    assert.equal(payload.runId, "run-group-1");
    assert.equal(payload.targets.length, 2);
  } finally {
    await fixture.close();
  }
});

test("eval run exits non-zero and names each failure on a partial fan-out", async () => {
  const fixture = await startEvalFixture({
    suiteDetail: {
      hosts: [
        { id: "host-claude", name: "Claude" },
        { id: "host-chatgpt", name: "ChatGPT" },
      ],
    },
    groupFailures: {
      "host-chatgpt": { code: "VALIDATION_ERROR", message: "no servers" },
    },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--all-targets",
          "--format",
          "human",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    // Exiting 0 would let a pipeline read "1 of 2 runs never started" as a
    // clean launch.
    assert.equal(run.result.exitCode, 1);
    assert.match(run.stdout, /Started 1\/2 runs \(group grp-1\)/);
    assert.match(run.stdout, /View: .*\/runs\/run-group-1/);
    assert.match(run.stderr, /Failed: ChatGPT — VALIDATION_ERROR: no servers/);
  } finally {
    await fixture.close();
  }
});

test("eval run maps every knob flag onto the request body", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--iterations",
            "3",
            "--case",
            "echo works",
            "--exclude-skills",
            "--notes",
            "nightly",
            "--min-pass-rate",
            "80",
            "--match-options",
            '{"toolCallOrder":"exact"}',
            "--idempotency-key",
            "key-1",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.deepEqual(fixture.runBodies.at(-1), {
      suiteId: "suite-1",
      iterationOverride: 3,
      caseIds: ["case-1"],
      matchOptionsOverride: { toolCallOrder: "exact" },
      skillsOverride: "exclude",
      notes: "nightly",
      passCriteria: { minimumPassRate: 80 },
      idempotencyKey: "key-1",
    });
  } finally {
    await fixture.close();
  }
});

test("eval run rejects malformed --match-options with a usage error", async () => {
  // The op's schema would reject the parsed value with a field-level message,
  // which is unhelpful when the real problem is a missing quote in the shell.
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--match-options",
          "{not json",
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    assert.notEqual(run.result.exitCode, 0);
    assert.match(run.stderr, /--match-options must be valid JSON/);
    assert.equal(fixture.runBodies.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval run --host resolves an attached host by name", async () => {
  // The mis-attribution fix from the caller's side: without a host the run
  // used to execute under the suite's default config and report the wrong one.
  const fixture = await startEvalFixture({
    suiteDetail: {
      hosts: [
        { id: "host-claude", name: "Claude" },
        { id: "host-chatgpt", name: "ChatGPT" },
      ],
    },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--host",
            "Claude",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.deepEqual(fixture.runBodies.at(-1), {
      suiteId: "suite-1",
      namedHostId: "host-claude",
    });
    // ONE host is a single run, not a group.
    assert.equal(fixture.groupBodies.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval run --host with two values fans out through the group endpoint", async () => {
  const fixture = await startEvalFixture({
    suiteDetail: {
      hosts: [
        { id: "host-claude", name: "Claude" },
        { id: "host-chatgpt", name: "ChatGPT" },
      ],
    },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--host",
            "Claude",
            "ChatGPT",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.equal(fixture.groupBodies.length, 1);
    assert.deepEqual(
      (fixture.groupBodies[0] as { targets: unknown }).targets,
      [{ namedHostId: "host-claude" }, { namedHostId: "host-chatgpt" }],
    );
  } finally {
    await fixture.close();
  }
});

test("eval cases run forwards --host, --iterations and --idempotency-key", async () => {
  const fixture = await startEvalFixture({
    suiteDetail: { hosts: [{ id: "host-claude", name: "Claude" }] },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "cases",
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--case",
            "echo works",
            "--host",
            "Claude",
            "--iterations",
            "2",
            "--idempotency-key",
            "key-2",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.deepEqual(fixture.runBodies.at(-1), {
      suiteId: "suite-1",
      caseIds: ["case-1"],
      namedHostId: "host-claude",
      iterationOverride: 2,
      idempotencyKey: "key-2",
    });
  } finally {
    await fixture.close();
  }
});

test("eval run --compose-* mints ephemerally and does not attach", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--compose-host",
            "Claude Code",
            "--compose-computer",
            "default",
            "--compose-model",
            "anthropic/claude-haiku-4.5",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.deepEqual(fixture.composeBodies.at(-1), {
      hostId: "host-claude",
      sandboxImageId: "img-default",
      modelId: "anthropic/claude-haiku-4.5",
    });
    assert.equal(fixture.attachBodies.length, 0);
    assert.deepEqual(fixture.runBodies.at(-1), {
      suiteId: "suite-1",
      environmentId: "env-adhoc-anthropic-claude-haiku-4-5",
      ephemeralEnvironment: true,
    });
    const payload = JSON.parse(run.stdout) as {
      composed: { environment: { created: boolean }; attachment: unknown };
    };
    assert.equal(payload.composed.environment.created, true);
    assert.deepEqual(payload.composed.attachment, { attached: false });
  } finally {
    await fixture.close();
  }
});

test("eval run --compose-model variadic launches one group without attaching", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--compose-host",
            "Claude Code",
            "--compose-model",
            "anthropic/claude-haiku-4.5",
            "google/gemini-2.5-flash",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.equal(fixture.composeBodies.length, 2);
    assert.equal(fixture.attachBodies.length, 0);
    assert.deepEqual(fixture.groupBodies.at(-1), {
      suiteId: "suite-1",
      ephemeralEnvironment: true,
      targets: [
        { environmentId: "env-adhoc-anthropic-claude-haiku-4-5" },
        { environmentId: "env-adhoc-google-gemini-2-5-flash" },
      ],
    });
    const payload = JSON.parse(run.stdout) as {
      runGroupId?: string;
      startedCount: number;
    };
    assert.equal(payload.runGroupId, "grp-1");
    assert.equal(payload.startedCount, 2);
  } finally {
    await fixture.close();
  }
});

test("eval run --save-targets attaches the composed cell", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          ...evalArgv(
            fixture.baseUrl,
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--compose-host",
            "Claude Code",
            "--save-targets",
          ),
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 0);
    assert.deepEqual(fixture.attachBodies.at(-1), {
      environmentId: "env-adhoc",
    });
    assert.deepEqual(fixture.runBodies.at(-1), {
      suiteId: "suite-1",
      environmentId: "env-adhoc",
    });
  } finally {
    await fixture.close();
  }
});

test("eval run rejects a --compose-* refinement with no --compose-host", async () => {
  // The host is what MAKES it a composed run; the others only refine a stack
  // that already has one, so a silently-ignored flag would be worse.
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--compose-computer",
          "default",
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    assert.notEqual(run.result.exitCode, 0);
    assert.match(run.stderr, /--compose-\* flags need --compose-host/);
    assert.equal(fixture.composeBodies.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval run rejects --compose-host together with --environment", async () => {
  // Refused by the op, which owns the rule for every surface. Composing has a
  // persistent side effect, so silently ignoring it would edit the suite for a
  // run that did not use the result.
  const fixture = await startEvalFixture({
    suiteDetail: { environmentIds: ["env-staging"] },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--compose-host",
          "Claude Code",
          "--environment",
          "staging",
        ),
        { telemetry: telemetryDisabled },
      ),
    );
    assert.notEqual(run.result.exitCode, 0);
    assert.match(run.stderr, /compose/);
    assert.equal(fixture.composeBodies.length, 0);
    assert.equal(fixture.runBodies.length, 0);
  } finally {
    await fixture.close();
  }
});

test("eval gate exits 3 on an INCONCLUSIVE run, not 1", async () => {
  // Verdict policy 2 lets the platform decline to decide. The fixture's
  // summary for it is fully PASSING, so gating the numbers would exit 0 —
  // and a partial one would exit 1 and read as a regression. Neither is a
  // verdict this run established.
  const fixture = await startEvalFixture({ runOneResult: "inconclusive" });
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "gate",
          "--project",
          "proj-alpha",
          "--run",
          "run-1",
          "--min-pass-rate-percent",
          "100",
          "--format",
          "json",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 3);
    const payload = JSON.parse(run.stdout.trim());
    assert.equal(payload.gate.outcome, "incomplete");
    assert.equal(payload.gate.verdicts[0].status, "non_gateable");
    assert.match(payload.gate.verdicts[0].message, /inconclusive/);
  } finally {
    await fixture.close();
  }
});

// Same INCONCLUSIVE-run gate outcome as above, but through the run-fetched
// (not fetch-failed) branch of `runEvalGate`, which builds its structured
// report separately — both branches must render the same neutral color.
test("eval gate --reporter html renders an INCOMPLETE outcome from an inconclusive run as neutral", async () => {
  const fixture = await startEvalFixture({ runOneResult: "inconclusive" });
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "gate",
          "--project",
          "proj-alpha",
          "--run",
          "run-1",
          "--min-pass-rate-percent",
          "100",
          "--reporter",
          "html",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 3);
    assert.match(run.stdout, /^<!doctype html>/i);
    assert.match(run.stdout, /badge-neutral">inconclusive/);
    assert.equal(run.stdout.includes('badge-fail">'), false);
  } finally {
    await fixture.close();
  }
});

// A cancelled run's `result` is `null` — not "failed", not "inconclusive" —
// so the verdict this would compute BY DEFAULT from the run's own result
// (were the override absent) falls through to "failed". The gate outcome is
// "incomplete" (an execution state, not a verdict), and that must win.
test("eval gate --reporter html renders a cancelled run's INCOMPLETE outcome as neutral, not failed", async () => {
  const fixture = await startEvalFixture({ runOneStatus: "cancelled" });
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "gate",
          "--project",
          "proj-alpha",
          "--run",
          "run-1",
          "--min-pass-rate-percent",
          "100",
          "--reporter",
          "html",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 3);
    assert.match(run.stdout, /^<!doctype html>/i);
    assert.match(run.stdout, /badge-neutral">inconclusive/);
    assert.equal(run.stdout.includes('badge-fail">'), false);
  } finally {
    await fixture.close();
  }
});

test("eval run --wait adopts the six-code contract under verdict policy 2 (E1)", async () => {
  // Inverse of the old sentinel: `eval run --wait` now DOES report a
  // verdict-shaped exit code. A completed "failed" run is the sole producer
  // of 1; an "inconclusive" run — the platform declining to decide — is
  // "no valid verdict" (5), never 1 and never the pre-E1 0.
  for (const [result, expectedExitCode] of [
    ["failed", 1],
    ["inconclusive", 5],
  ] as const) {
    const fixture = await startEvalFixture({
      runCaseResult: result,
      runCasePolicyVersion2: true,
    });
    try {
      const run = await captureProcessOutput(() =>
        main(
          evalArgv(
            fixture.baseUrl,
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--wait",
            "--format",
            "json",
          ),
          { telemetry: telemetryDisabled },
        ),
      );

      assert.equal(run.result.exitCode, expectedExitCode);
      const receipt = JSON.parse(run.stdout.trim());
      assert.equal(receipt.runs[0].result, result);
    } finally {
      process.exitCode = 0;
      await fixture.close();
    }
  }
});

// ---------------------------------------------------------------------------
// E1 — `eval run --wait`'s six-code exit contract.
//
// Auth -> 3 is scoped to `--wait`: the guard tests below prove the no-wait
// path is untouched, then every table row and merge consequence from the E1
// charter gets its own case. `classifyLaunchErrorExitCode` and
// `classifyWaitErrorExitCode` are unit-tested in isolation in
// eval-run-exit-code.test.ts; these are the end-to-end wiring proof.
// ---------------------------------------------------------------------------

test("no-wait guard: a missing credential still exits 1, untouched", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await withNoCredential(() =>
      captureProcessOutput(() =>
        main(
          evalArgvNoKey(
            fixture.baseUrl,
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
          ),
          { telemetry: telemetryDisabled },
        ),
      ),
    );

    assert.equal(run.result.exitCode, 1);
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("no-wait guard: a launch-phase 401 still exits 1 with code UNAUTHORIZED", async () => {
  const fixture = await startEvalFixture({ authFailure: "launch" });
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--format",
          "json",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 1);
    const stderrLines = run.stderr.trim().split("\n");
    const failure = JSON.parse(stderrLines[stderrLines.length - 1]);
    assert.equal(failure.error.code, "UNAUTHORIZED");
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval run --wait exits 3 on a missing credential, before any network call", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await withNoCredential(() =>
      captureProcessOutput(() =>
        main(
          evalArgvNoKey(
            fixture.baseUrl,
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--wait",
            "--format",
            "json",
          ),
          { telemetry: telemetryDisabled },
        ),
      ),
    );

    assert.equal(run.result.exitCode, 3);
    // Zero-credit guarantee: the fixture never saw a request at all.
    assert.equal(fixture.runBodies.length, 0);
    assert.equal(fixture.groupBodies.length, 0);
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval run --wait exits 3 when the credential dies between launch and the wait phase, receipt preserved", async () => {
  // The launch preflight passes (credential present), the launch itself
  // succeeds, and only THEN does the credential disappear — simulating the
  // narrow window between the explicit launch-phase preflight and the wait
  // phase's own internal recheck. That recheck must still land on exit 3
  // (not whatever a bare CliError defaults to), and the launch receipt —
  // the only record of the run id already paid for — must still reach
  // stdout before the process exits.
  const fixture = await startEvalFixture({
    deleteCredentialAfterLaunch: true,
  });
  try {
    const run = await withDyingCredential(() =>
      captureProcessOutput(() =>
        main(
          evalArgvNoKey(
            fixture.baseUrl,
            "run",
            "--project",
            "proj-alpha",
            "--suite",
            "suite-1",
            "--wait",
            "--format",
            "json",
          ),
          { telemetry: telemetryDisabled },
        ),
      ),
    );

    assert.equal(run.result.exitCode, 3);
    const receipt = JSON.parse(run.stdout.trim());
    assert.equal(receipt.launch.targets[0].runId, "run-case");
    assert.deepEqual(receipt.runs, []);
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval run --wait exits 2 on a malformed --api-url, not the auth code", async () => {
  const fixture = await startEvalFixture();
  try {
    const run = await captureProcessOutput(() =>
      main(
        [
          "node",
          "mcpjam",
          "cloud",
          "eval",
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--wait",
          "--api-key",
          "sk_test",
          "--api-url",
          "not-a-url",
          "--format",
          "json",
        ],
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 2);
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval run --wait exits 3 on a launch-phase UNAUTHORIZED", async () => {
  const fixture = await startEvalFixture({ authFailure: "launch" });
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--wait",
          "--format",
          "json",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 3);
    const stderrLines = run.stderr.trim().split("\n");
    const failure = JSON.parse(stderrLines[stderrLines.length - 1]);
    assert.equal(failure.error.code, "UNAUTHORIZED");
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval run --wait exits 2 on a launch-phase VALIDATION_ERROR", async () => {
  const fixture = await startEvalFixture({
    singleRunLaunchError: {
      code: "VALIDATION_ERROR",
      message: "no servers configured",
      status: 400,
    },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--wait",
          "--format",
          "json",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 2);
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval run --wait exits 4 on a launch-phase INTERNAL_ERROR (fails toward infra)", async () => {
  const fixture = await startEvalFixture({
    singleRunLaunchError: {
      code: "INTERNAL_ERROR",
      message: "backend blew up",
      status: 500,
    },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--wait",
          "--format",
          "json",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 4);
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval run --wait exits 4 on billing_limit_reached — a setup failure, not auth", async () => {
  const fixture = await startEvalFixture({
    singleRunLaunchError: {
      code: "billing_limit_reached",
      message: "out of credits",
      status: 402,
    },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--wait",
          "--format",
          "json",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 4);
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval run --wait exits 4 on a billing failure the API disguised as FORBIDDEN", async () => {
  // The v1 API's public error union has no billing member, so
  // BILLING_LIMIT_REACHED collapses onto the wire code FORBIDDEN
  // (routes/v1/envelope.ts's mapInternalCode) — the same code a real
  // credential rejection carries. Only details.code tells them apart, and
  // getting this wrong would tell CI to fix its API key when the key is
  // fine and the org is out of runway.
  const fixture = await startEvalFixture({
    singleRunLaunchError: {
      code: "FORBIDDEN",
      message: "Your plan limit was reached.",
      status: 403,
      details: { code: "billing_limit_reached", plan: "starter" },
    },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--wait",
          "--format",
          "json",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 4);
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval run --wait exits 3 on a real FORBIDDEN with no billing detail", async () => {
  const fixture = await startEvalFixture({
    singleRunLaunchError: {
      code: "FORBIDDEN",
      message: "Not authorized for this project.",
      status: 403,
    },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--wait",
          "--format",
          "json",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 3);
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval run --wait exits 4 on a total fan-out failure (zero started)", async () => {
  const fixture = await startEvalFixture({
    suiteDetail: {
      hosts: [
        { id: "host-claude", name: "Claude Code" },
        { id: "host-chatgpt", name: "ChatGPT" },
      ],
    },
    groupFailures: {
      "host-claude": { code: "HOST_OFFLINE", message: "host unavailable" },
      "host-chatgpt": { code: "HOST_OFFLINE", message: "host unavailable" },
    },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--all-targets",
          "--wait",
          "--format",
          "json",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 4);
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("merge: a partial fan-out with one failing run exits 1, not 4", async () => {
  // The started sibling's real verdict failure outranks the OTHER sibling's
  // launch failure — 1 beats 4 in the severity order.
  const fixture = await startEvalFixture({
    suiteDetail: {
      hosts: [
        { id: "host-claude", name: "Claude Code" },
        { id: "host-chatgpt", name: "ChatGPT" },
      ],
    },
    groupFailures: {
      "host-chatgpt": { code: "HOST_OFFLINE", message: "host unavailable" },
    },
    groupRunOverrides: {
      "run-group-1": { result: "failed" },
    },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--all-targets",
          "--wait",
          "--format",
          "json",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 1);
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("merge: all started runs passed but one sibling's wait timed out exits 5", async () => {
  const fixture = await startEvalFixture({
    suiteDetail: {
      hosts: [
        { id: "host-claude", name: "Claude Code" },
        { id: "host-chatgpt", name: "ChatGPT" },
      ],
    },
    groupRunOverrides: {
      "run-group-2": { status: "running" },
    },
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--all-targets",
          "--wait",
          "--wait-timeout",
          "1",
          "--format",
          "json",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 5);
    const stderrLines = run.stderr.trim().split("\n");
    const failure = JSON.parse(stderrLines[stderrLines.length - 1]);
    assert.equal(failure.error.code, "OPERATIONAL_ERROR");
    assert.deepEqual(failure.error.details.runIds, ["run-group-2"]);
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval run --wait exits 3 on a mid-poll 401, with the real wire errorCode", async () => {
  // A token that expires mid-wait: the first poll observes "running", the
  // second observes 401. Real SCREAMING_SNAKE wire vocabulary, not the
  // lowercase `code` key the telemetry redactor would eat.
  const fixture = await startEvalFixture({ authFailure: "poll" });
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--wait",
          "--format",
          "json",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 3);
    const stderrLines = run.stderr.trim().split("\n");
    const failure = JSON.parse(stderrLines[stderrLines.length - 1]);
    assert.equal(failure.error.code, "OPERATIONAL_ERROR");
    assert.equal(failure.error.details.waitErrors[0].errorCode, "UNAUTHORIZED");
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval run --wait exits 5 on a mid-wait network failure, not 4", async () => {
  // The evaluation had already started when the CLI lost the connection —
  // an absence of observation, not a setup defect it can point at.
  const fixture = await startEvalFixture({
    runCaseStatus: "running",
    closeAfterLaunch: true,
  });
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--wait",
          "--format",
          "json",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 5);
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("eval run --wait exits 4 on a local --out write failure", async () => {
  const fixture = await startEvalFixture();
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-eval-run-"));
  // A FILE where `--out` needs a directory segment: every write under it
  // fails with ENOTDIR, regardless of `createParents`.
  const blockerFile = path.join(directory, "blocker");
  await writeFile(blockerFile, "not a directory");
  const outPath = path.join(blockerFile, "report.json");
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--wait",
          "--out",
          outPath,
          "--format",
          "json",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 4);
    // The receipt is the only place the launched run id survives; a local
    // disk error must not cost the caller that id the way an early throw
    // would.
    const receipt = JSON.parse(run.stdout.trim());
    assert.equal(receipt.launch.targets[0].runId, "run-case");
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});

test("merge: a local --out write failure never masks a real verdict failure", async () => {
  // The write failure is discovered AFTER the run's own outcome is known.
  // Per the documented severity order (1 > 3 > 4 > 5 > 0), the verdict
  // failure must still win the exit code, even though the write failure is
  // what actually threw.
  const fixture = await startEvalFixture({ runCaseResult: "failed" });
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcpjam-eval-run-"));
  const blockerFile = path.join(directory, "blocker");
  await writeFile(blockerFile, "not a directory");
  const outPath = path.join(blockerFile, "report.json");
  try {
    const run = await captureProcessOutput(() =>
      main(
        evalArgv(
          fixture.baseUrl,
          "run",
          "--project",
          "proj-alpha",
          "--suite",
          "suite-1",
          "--wait",
          "--out",
          outPath,
          "--format",
          "json",
        ),
        { telemetry: telemetryDisabled },
      ),
    );

    assert.equal(run.result.exitCode, 1);
    // The receipt still reaches stdout even though --out failed.
    const receipt = JSON.parse(run.stdout.trim());
    assert.equal(receipt.launch.targets[0].runId, "run-case");
    const stderrLines = run.stderr.trim().split("\n");
    const failure = JSON.parse(stderrLines[stderrLines.length - 1]);
    assert.equal(failure.error.code, "OUT_WRITE_FAILED");
  } finally {
    process.exitCode = 0;
    await fixture.close();
  }
});
