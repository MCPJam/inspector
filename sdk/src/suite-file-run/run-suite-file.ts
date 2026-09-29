/**
 * `runSuiteFile` — execute a suite file locally and decide it with the v2
 * verdict policy.
 *
 * The order is the contract (see `./preflight.ts` for steps 1–3):
 *
 *   4. resolve the credentials the planned rails need, then connect the
 *      target servers under the emulated host's connection profile and
 *      freeze their complete tool catalog and the policy snapshot;
 *   5. pre-mint one platform lease per distinct MCPJam model, in a run-scoped
 *      lease scope bound to the caller's auth context;
 *   6. execute cases sequentially in authored order, each case's iterations
 *      with bounded concurrency, a fresh executor and policy gate per
 *      iteration, and reporting explicitly disabled;
 *   7. aggregate the planned population with the canonical aggregator and
 *      build the validated local report;
 *   8. clean up — disconnect every owned client, release every run-scoped
 *      lease, remove every listener — in `finally`, bounded.
 *
 * No model generation and no `tools/call` happens before every selected case
 * has passed preflight, and nothing is ever uploaded.
 */

import type { ToolSet } from "ai";
import { HostRunner } from "../HostRunner.js";
import type { HostExecutor } from "../HostExecutor.js";
import type { IterationResult } from "../EvalTest.js";
import type { PromptResult } from "../PromptResult.js";
import { MCPClientManager } from "../mcp-client-manager/index.js";
import type { MCPServerConfig } from "../mcp-client-manager/types.js";
import {
  McpjamLeaseError,
  McpjamModelLeaseScope,
  classifyMcpjamLeaseError,
  resolveMcpjamBaseUrl,
} from "../mcpjam-model-lease.js";
import {
  createModelFromString,
  type CreateModelOptions,
} from "../model-factory.js";
import { applyHostConnectionProfile } from "../host-config/host-connection.js";
import {
  UnmatchedToolPolicyNameError,
  buildToolPolicySnapshot,
  validateToolPolicyNames,
  type ToolPolicySnapshot,
} from "../contract/tool-policy.js";
import {
  aggregateEvalRunVerdict,
  type EvalCaseVerdictInput,
  type EvalTrialObservation,
} from "../contract/verdict-aggregate.js";
import type { EvalVerdictDecision } from "../contract/verdict-policy.js";
import { PREDICATES_VERSION } from "../contract/types.js";
import { deriveIterationStageMetadata } from "../eval-result-mapping.js";
import { readSdkVersion } from "../sdk-version.js";
import { redactTelemetryString } from "../telemetry-redaction.js";
import {
  SuiteFileRunError,
  refusal,
  type SuiteFileRunProblem,
} from "./errors.js";
import { assertImportedToolReferences } from "./import-gate.js";
import {
  attributingModelFactory,
  resolveInferenceCredentials,
  type ResolvedInferenceCredentials,
} from "./inference.js";
import {
  preflightSuiteFile,
  type PlannedCase,
  type SuiteFilePlan,
} from "./preflight.js";
import {
  LocalEvalRunReportError,
  buildLocalEvalRunReport,
  type LocalEvalRunMetadata,
} from "./report.js";
import {
  addServerConfigSecrets,
  createSecretScrubber,
  scrubErrorDetails,
  scrubIssue,
  scrubIterationEvidence,
} from "./secrets.js";
import {
  createLocalToolPolicyGate,
  type LocalToolPolicyGate,
} from "./tool-policy-gate.js";
import { observeIteration, unstartedIteration } from "./trial-observation.js";
import type {
  RunSuiteFileOptions,
  SuiteFileCaseRun,
  SuiteFileIterationEvidence,
  SuiteFileRefusalAttribution,
  SuiteFileRunIssue,
  SuiteFileRunProgressEvent,
  SuiteFileRunResult,
  SuiteFileRunTermination,
  SuiteFileRunVerdict,
  SuiteFileToolPolicyBlock,
} from "./types.js";

/** Upper bound on each cleanup step, so a hung server cannot hang the caller. */
const CLEANUP_TIMEOUT_MS = 10_000;

type LanguageModelFactory = (
  model: string,
  options: CreateModelOptions
) => ReturnType<typeof createModelFromString>;

/**
 * The runner's injectable seams.
 *
 * @internal For the SDK's and the CLI's own tests: a deterministic model
 * double, a manager factory. There is no production switch, flag or
 * environment variable that reaches these — `runSuiteFile` always uses the
 * real model factory and a fresh manager.
 */
export type SuiteFileRunnerRuntime = {
  createLanguageModel?: LanguageModelFactory;
  createClientManager?: () => MCPClientManager;
  now?: () => number;
};

/**
 * Build a runner over explicit seams.
 *
 * @internal See {@link SuiteFileRunnerRuntime}.
 */
export function createSuiteFileRunner(runtime: SuiteFileRunnerRuntime = {}): {
  run: (
    sourceText: string,
    options: RunSuiteFileOptions
  ) => Promise<SuiteFileRunResult>;
} {
  return {
    run: (sourceText, options) =>
      executeSuiteFile(sourceText, options, runtime),
  };
}

/**
 * Run a suite file locally.
 *
 * Throws {@link SuiteFileRunError} for input that cannot run and environments
 * that cannot be set up — before any model or tool call — and, after the
 * cases ran, for a report that fails its own contract (`REPORT_INVALID`).
 * Returns evidence for everything else after execution began, including an
 * interrupted run (with an explicit `termination`). Never uploads anything.
 */
export function runSuiteFile(
  sourceText: string,
  options: RunSuiteFileOptions
): Promise<SuiteFileRunResult> {
  return executeSuiteFile(sourceText, options, {});
}

// ── helpers ──────────────────────────────────────────────────────────────────

function cancelledError(phase: "validation" | "setup"): SuiteFileRunError {
  return new SuiteFileRunError({
    code: "CANCELLED",
    phase,
    category: "cancelled",
    message:
      "The run was cancelled before execution began; nothing was measured.",
  });
}

/** Run a setup operation under a deadline and the run's abort signal. */
async function setupStep<T>(
  what: string,
  timeoutMs: number,
  runSignal: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  runSignal.throwIfAborted();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new SuiteFileRunError({
        code: "SETUP_TIMEOUT",
        phase: "setup",
        category: "setup",
        message: `${what} did not finish within ${timeoutMs}ms.`,
      });
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    onAbort = () => {
      controller.abort(runSignal.reason);
      reject(runSignal.reason ?? new Error("aborted"));
    };
    runSignal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation(controller.signal), stopped]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) runSignal.removeEventListener("abort", onAbort);
  }
}

async function bounded(
  what: string,
  work: (() => Promise<unknown>) | undefined
): Promise<string | undefined> {
  if (!work) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`${what} timed out after ${CLEANUP_TIMEOUT_MS}ms`)
            ),
          CLEANUP_TIMEOUT_MS
        );
      }),
    ]);
    return undefined;
  } catch (error) {
    return `${what} failed: ${redactTelemetryString(error instanceof Error ? error.message : String(error))}`;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function messageOf(error: unknown): string {
  return redactTelemetryString(
    error instanceof Error ? error.message : String(error)
  );
}

function transportOf(config: MCPServerConfig): "stdio" | "http" {
  return "command" in config &&
    typeof (config as { command?: unknown }).command === "string"
    ? "stdio"
    : "http";
}

type IterationContext = {
  gate?: LocalToolPolicyGate;
  refusals: SuiteFileRefusalAttribution[];
};

type CaseOutcome = {
  run: SuiteFileCaseRun;
  observations: EvalTrialObservation[];
  blocks: SuiteFileToolPolicyBlock[];
  refusals: SuiteFileRefusalAttribution[];
  issues: SuiteFileRunIssue[];
};

// ── the run ──────────────────────────────────────────────────────────────────

async function executeSuiteFile(
  sourceText: string,
  options: RunSuiteFileOptions,
  runtime: SuiteFileRunnerRuntime
): Promise<SuiteFileRunResult> {
  const now = runtime.now ?? Date.now;
  const startedAt = now();
  if (options.signal?.aborted) throw cancelledError("validation");

  // Steps 1–3. Throws before anything starts.
  const plan = preflightSuiteFile(sourceText, options);

  // Every secret value this run was handed, scrubbed from everything it
  // returns or throws — see `./secrets.ts`.
  const secrets = createSecretScrubber();
  for (const key of Object.values(options.inference?.providerKeys ?? {})) {
    secrets.add(key);
  }
  for (const binding of Object.values(plan.bindings)) {
    addServerConfigSecrets(secrets, binding.config);
  }

  const warnings = [...plan.warnings];
  let observerFailed = false;
  const progress = (event: SuiteFileRunProgressEvent) => {
    if (!options.onProgress) return;
    try {
      const returned = options.onProgress(event) as unknown;
      if (
        returned &&
        typeof (returned as { then?: unknown }).then === "function"
      ) {
        (returned as Promise<unknown>).catch(() => {
          if (!observerFailed)
            warnings.push(
              "An onProgress observer failed; its failure was ignored."
            );
          observerFailed = true;
        });
      }
    } catch {
      if (!observerFailed)
        warnings.push(
          "An onProgress observer failed; its failure was ignored."
        );
      observerFailed = true;
    }
  };

  const runController = new AbortController();
  const forwardAbort = () => runController.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  if (options.signal?.aborted) forwardAbort();

  let manager: MCPClientManager | undefined;
  let leaseScope: McpjamModelLeaseScope | undefined;
  let executed: Awaited<ReturnType<typeof executeCases>> | undefined;
  let failure: unknown;
  let snapshot: ToolPolicySnapshot | undefined;
  try {
    // ── 4. credentials, then connect and discover ────────────────────────────
    progress({ type: "setup", stage: "credentials" });
    let credentials: ResolvedInferenceCredentials;
    try {
      credentials = await resolveInferenceCredentials({
        plans: plan.cases.map((entry) => entry.model),
        inference: options.inference,
        timeoutMs: plan.settings.setupTimeoutMs,
        signal: runController.signal,
      });
    } catch (error) {
      if (runController.signal.aborted) throw cancelledError("setup");
      throw error;
    }
    if (credentials.mcpjam) {
      // Every bearer the platform callback hands out is a known secret from
      // then on; the scope and every model share this one wrapped callback.
      const readAuth = credentials.mcpjam.getAuth;
      credentials = {
        ...credentials,
        mcpjam: {
          ...credentials.mcpjam,
          getAuth: async () => {
            const token = await readAuth();
            secrets.add(token);
            return token;
          },
        },
      };
    }

    manager = runtime.createClientManager
      ? runtime.createClientManager()
      : new MCPClientManager({}, { lazyConnect: true });
    const activeManager = manager;
    const connectFailures: SuiteFileRunProblem[] = [];
    await Promise.all(
      plan.targetServers.map(async (name) => {
        progress({ type: "setup", stage: "connect", server: name });
        const binding = plan.bindings[name]!;
        const config = plan.host
          ? applyHostConnectionProfile(binding.config, plan.host.connection)
          : binding.config;
        try {
          await setupStep(
            `Connecting to MCP server "${name}"`,
            plan.settings.setupTimeoutMs,
            runController.signal,
            (signal) => activeManager.connectToServer(name, config, { signal })
          );
        } catch (error) {
          if (runController.signal.aborted) return;
          connectFailures.push({ server: name, message: messageOf(error) });
        }
      })
    );
    if (runController.signal.aborted) throw cancelledError("setup");
    if (connectFailures.length > 0) {
      throw refusal({
        code: "SERVER_CONNECT_FAILED",
        phase: "setup",
        category: "setup",
        summary: "Could not connect to every target server; nothing was run.",
        problems: connectFailures,
      });
    }

    progress({ type: "setup", stage: "discover" });
    let byServer: Record<string, ToolSet>;
    try {
      byServer = (await setupStep(
        "Listing the target servers' tools",
        plan.settings.setupTimeoutMs,
        runController.signal,
        () =>
          activeManager.getToolsForAiSdkByServer(plan.targetServers, {
            includeAppOnly: plan.host?.json.respectToolVisibility === false,
            ...(plan.host?.json.modelVisibleMcpToolResults !== undefined
              ? {
                  modelVisibleMcpToolResults:
                    plan.host.json.modelVisibleMcpToolResults,
                }
              : {}),
          })
      )) as unknown as Record<string, ToolSet>;
    } catch (error) {
      if (runController.signal.aborted) throw cancelledError("setup");
      if (error instanceof SuiteFileRunError) throw error;
      throw new SuiteFileRunError({
        code: "TOOL_CATALOG_FAILED",
        phase: "setup",
        category: "setup",
        message: `Could not read the target servers' tool catalogs: ${messageOf(error)}`,
      });
    }

    // The catalog every iteration sees — merged once, refusing collisions the
    // `Object.assign` merge would otherwise resolve silently, then frozen.
    const merged: ToolSet = {};
    const ownerOf = new Map<string, string>();
    const annotations = new Map<string, Record<string, unknown> | undefined>();
    const collisions: SuiteFileRunProblem[] = [];
    for (const name of plan.targetServers) {
      if (!activeManager.hasCachedToolAnnotations(name)) {
        throw new SuiteFileRunError({
          code: "TOOL_CATALOG_FAILED",
          phase: "setup",
          category: "setup",
          message: `The tool catalog for server "${name}" was not captured completely; tool policy cannot be enforced against it.`,
        });
      }
      const serverAnnotations = activeManager.getAllToolAnnotations(name);
      for (const [toolName, tool] of Object.entries(byServer[name] ?? {})) {
        const existing = ownerOf.get(toolName);
        if (existing !== undefined) {
          collisions.push({
            toolName,
            server: name,
            message: `exposes "${toolName}", which server "${existing}" also exposes. A model-visible tool name must be unique across the suite's servers.`,
          });
          continue;
        }
        ownerOf.set(toolName, name);
        merged[toolName] = tool;
        annotations.set(toolName, serverAnnotations[toolName]);
      }
    }
    if (collisions.length > 0) {
      throw refusal({
        code: "TOOL_NAME_CONFLICT",
        phase: "setup",
        category: "setup",
        summary:
          "Target servers expose conflicting tool names; nothing was run.",
        problems: collisions,
      });
    }
    const frozenTools = Object.freeze({ ...merged }) as ToolSet;
    const toolNames = Object.keys(frozenTools);

    if (plan.toolPolicy) {
      try {
        warnings.push(
          ...validateToolPolicyNames({
            policy: plan.toolPolicy,
            availableToolNames: toolNames,
          })
        );
      } catch (error) {
        if (error instanceof UnmatchedToolPolicyNameError) {
          throw new SuiteFileRunError({
            code: "TOOL_POLICY_INVALID",
            phase: "setup",
            category: "policy",
            message: `${error.message}. Fix the deny list: a name that matches nothing fences off nothing.`,
            details: {
              problems: error.names.map((toolName) => ({
                toolName,
                message: "does not match any tool the target servers expose.",
              })),
            },
          });
        }
        throw error;
      }
      snapshot = buildToolPolicySnapshot({
        policy: plan.toolPolicy,
        tools: toolNames.map((name) => ({
          name,
          ...(annotations.get(name)
            ? { annotations: annotations.get(name) }
            : {}),
        })),
      });
    }

    assertImportedToolReferences({
      cases: plan.cases.map((entry) => ({
        caseId: entry.testCase.id,
        imported: entry.testCase.import !== undefined,
        toolNames: entry.expectedToolNames,
      })),
      availableToolNames: new Set(toolNames),
    });

    // ── 5. pre-mint platform leases ──────────────────────────────────────────
    const connection = credentials.mcpjam;
    if (connection) {
      leaseScope = new McpjamModelLeaseScope({
        auth: {
          getAuth: connection.getAuth,
          ...(connection.headers ? { headers: connection.headers } : {}),
        },
      });
      const scope = leaseScope;
      const models = [
        ...new Set(
          plan.cases
            .filter((entry) => entry.model.rail === "mcpjam")
            .map((entry) => entry.model.canonicalModel!)
        ),
      ];
      for (const model of models) {
        progress({ type: "setup", stage: "lease", model });
        try {
          const client = scope.getClient({
            baseUrl: resolveMcpjamBaseUrl(connection.baseUrl),
            getAuth: scope.auth!.getAuth,
            ...(scope.auth!.headers ? { headers: scope.auth!.headers } : {}),
            project: connection.projectId,
            model,
          });
          await setupStep(
            `Minting an MCPJam lease for ${model}`,
            plan.settings.setupTimeoutMs,
            runController.signal,
            (signal) => client.getLease(signal)
          );
        } catch (error) {
          if (runController.signal.aborted) throw cancelledError("setup");
          if (error instanceof SuiteFileRunError) throw error;
          if (error instanceof McpjamLeaseError) {
            const kind = classifyMcpjamLeaseError(error);
            throw new SuiteFileRunError({
              code:
                kind === "billing"
                  ? "BILLING_REFUSED"
                  : kind === "auth"
                    ? "CREDENTIALS_REJECTED"
                    : "PLATFORM_UNAVAILABLE",
              phase: "setup",
              category:
                kind === "billing"
                  ? "billing"
                  : kind === "auth"
                    ? "credentials"
                    : "setup",
              message: `MCPJam refused inference for ${model}: ${messageOf(error)}`,
            });
          }
          throw new SuiteFileRunError({
            code: "PLATFORM_UNAVAILABLE",
            phase: "setup",
            category: "setup",
            message: `Could not mint an MCPJam lease for ${model}: ${messageOf(error)}`,
          });
        }
      }
    }
    if (runController.signal.aborted) throw cancelledError("setup");

    // ── 6. execute ───────────────────────────────────────────────────────────
    executed = await executeCases({
      plan,
      tools: frozenTools,
      snapshot,
      credentials,
      leaseScope,
      manager: activeManager,
      runtime,
      runSignal: runController.signal,
      userSignal: options.signal,
      providerBaseUrls: options.inference.baseUrls,
      progress,
      startedAt,
    });
  } catch (error) {
    failure = error;
  } finally {
    // ── 8. cleanup ───────────────────────────────────────────────────────────
    const activeManager = manager;
    const scope = leaseScope;
    const cleanupProblems = [
      await bounded(
        "Disconnecting MCP servers",
        activeManager ? () => activeManager.disconnectAllServers() : undefined
      ),
      await bounded(
        "Releasing MCPJam leases",
        scope ? () => scope.release() : undefined
      ),
    ].filter((problem): problem is string => problem !== undefined);
    options.signal?.removeEventListener("abort", forwardAbort);
    if (executed) {
      executed.issues.push(
        ...cleanupProblems.map((message) => ({
          code: "CLEANUP_FAILED",
          phase: "execution" as const,
          category: "cleanup" as const,
          message,
        }))
      );
    }
  }
  if (failure !== undefined) {
    if (failure instanceof SuiteFileRunError) {
      throw new SuiteFileRunError({
        code: failure.code,
        phase: failure.phase,
        category: failure.category,
        message: secrets.scrub(failure.message),
        details: scrubErrorDetails(secrets, failure.details),
      });
    }
    if (runController.signal.aborted) throw cancelledError("setup");
    throw new SuiteFileRunError({
      code: "SETUP_FAILED",
      phase: "setup",
      category: "setup",
      message: secrets.scrub(`Local run setup failed: ${messageOf(failure)}`),
    });
  }

  // ── 7. aggregate and report ────────────────────────────────────────────────
  // The observed text is scrubbed BEFORE the report is built, so its contract
  // validates exactly what is emitted, and nothing else is: identity and
  // closed vocabularies cannot carry a secret (see `./secrets.ts`).
  const observed = executed!;
  try {
    return finalize({
      plan,
      executed: {
        ...observed,
        issues: observed.issues.map((issue) => scrubIssue(secrets, issue)),
        outcomes: observed.outcomes.map((outcome) => ({
          ...outcome,
          run: {
            ...outcome.run,
            iterations: outcome.run.iterations.map((iteration) =>
              scrubIterationEvidence(secrets, iteration)
            ),
          },
          issues: outcome.issues.map((issue) => scrubIssue(secrets, issue)),
        })),
      },
      snapshot,
      warnings: warnings.map((warning) => secrets.scrub(warning)),
      startedAt,
      now,
    });
  } catch (error) {
    if (!(error instanceof SuiteFileRunError)) throw error;
    throw new SuiteFileRunError({
      code: error.code,
      phase: error.phase,
      category: error.category,
      message: secrets.scrub(error.message),
      details: scrubErrorDetails(secrets, error.details),
    });
  }
}

async function executeCases(args: {
  plan: SuiteFilePlan;
  tools: ToolSet;
  snapshot: ToolPolicySnapshot | undefined;
  credentials: ResolvedInferenceCredentials;
  leaseScope: McpjamModelLeaseScope | undefined;
  manager: MCPClientManager;
  runtime: SuiteFileRunnerRuntime;
  runSignal: AbortSignal;
  userSignal: AbortSignal | undefined;
  providerBaseUrls: CreateModelOptions["baseUrls"] | undefined;
  progress: (event: SuiteFileRunProgressEvent) => void;
  startedAt: number;
}): Promise<{
  outcomes: CaseOutcome[];
  termination: SuiteFileRunTermination;
  issues: SuiteFileRunIssue[];
}> {
  const outcomes: CaseOutcome[] = [];
  const issues: SuiteFileRunIssue[] = [];
  let stoppedBy: SuiteFileRefusalAttribution | undefined;
  const total = args.plan.cases.length;
  for (const [index, planned] of args.plan.cases.entries()) {
    if (args.runSignal.aborted || stoppedBy) {
      outcomes.push(
        notStartedCase(
          planned,
          args.runSignal.aborted ? "cancelled" : "skipped",
          args.startedAt
        )
      );
      args.progress({
        type: "caseFinish",
        caseId: planned.testCase.id,
        state: "notStarted",
      });
      continue;
    }
    args.progress({
      type: "caseStart",
      caseId: planned.testCase.id,
      index,
      total,
      iterations: planned.testCase.iterations,
    });
    const outcome = await executeCase({
      ...args,
      planned,
      onStop: (kind) => (stoppedBy ??= kind),
    });
    outcomes.push(outcome);
    issues.push(...outcome.issues);
  }
  const termination: SuiteFileRunTermination = args.userSignal?.aborted
    ? "aborted"
    : stoppedBy
      ? "stopped"
      : outcomes.every((outcome) => outcome.run.state === "completed")
        ? "completed"
        : "aborted";
  return { outcomes, termination, issues };
}

function importEvidence(
  planned: PlannedCase,
  startedAt: number
): SuiteFileCaseRun["import"] {
  const claim = planned.testCase.import;
  if (!claim || (claim.status !== "exact" && claim.status !== "approximated"))
    return undefined;
  const decision = planned.importDecision;
  return {
    status: claim.status,
    ...(claim.sourceCaseKey !== undefined
      ? { sourceCaseKey: claim.sourceCaseKey }
      : {}),
    ...(decision?.status === "approved_approximation"
      ? {
          approval: {
            reason: decision.reason,
            approvedAt: new Date(startedAt).toISOString(),
            actor: "local-invocation" as const,
          },
        }
      : {}),
  };
}

function baseCaseRun(
  planned: PlannedCase,
  startedAt: number
): Omit<
  SuiteFileCaseRun,
  "state" | "iterations" | "evaluationConfigHash" | "scorerIds"
> {
  const { testCase, model } = planned;
  const imported = importEvidence(planned, startedAt);
  return {
    caseId: testCase.id,
    title: testCase.title,
    ...(testCase.intent !== undefined ? { intent: testCase.intent } : {}),
    ...(testCase.kind !== undefined ? { kind: testCase.kind } : {}),
    isNegativeTest: testCase.isNegativeTest,
    declaredModel: model.declaredModel,
    ...(model.declaredProvider !== undefined
      ? { declaredProvider: model.declaredProvider }
      : {}),
    effectiveModel: model.effectiveModel,
    rail: model.rail,
    provider: model.provider,
    configuredIterations: testCase.iterations,
    passThreshold: testCase.passThreshold,
    judge: planned.judge,
    ...(imported ? { import: imported } : {}),
  };
}

function notStartedCase(
  planned: PlannedCase,
  status: "cancelled" | "skipped",
  startedAt: number
): CaseOutcome {
  const snapshot = planned.test.getEvaluationConfigSnapshot();
  const iterations = Array.from(
    { length: planned.testCase.iterations },
    (_, index) => unstartedIteration(index + 1, status)
  );
  return {
    run: {
      ...baseCaseRun(planned, startedAt),
      evaluationConfigHash: snapshot.hash,
      scorerIds: snapshot.definitions.map((definition) => definition.scorerId),
      state: "notStarted",
      iterations: iterations.map((entry) => entry.evidence),
    },
    observations: iterations.map((entry) => entry.observation),
    blocks: [],
    refusals: [],
    issues: [],
  };
}

async function executeCase(args: {
  plan: SuiteFilePlan;
  planned: PlannedCase;
  tools: ToolSet;
  snapshot: ToolPolicySnapshot | undefined;
  credentials: ResolvedInferenceCredentials;
  leaseScope: McpjamModelLeaseScope | undefined;
  manager: MCPClientManager;
  runtime: SuiteFileRunnerRuntime;
  runSignal: AbortSignal;
  providerBaseUrls: CreateModelOptions["baseUrls"] | undefined;
  startedAt: number;
  progress: (event: SuiteFileRunProgressEvent) => void;
  onStop: (kind: SuiteFileRefusalAttribution) => void;
}): Promise<CaseOutcome> {
  const { plan, planned } = args;
  const caseId = planned.testCase.id;
  const model = planned.model;
  const caseController = new AbortController();
  const forward = () => caseController.abort(args.runSignal.reason);
  args.runSignal.addEventListener("abort", forward, { once: true });
  if (args.runSignal.aborted) forward();

  // Contexts in the order EvalTest cloned executors, and by the prompt results
  // each clone returned — the link from an `IterationResult` back to the gate
  // and refusals that belong to it.
  const contexts: IterationContext[] = [];
  const ownerOf = new WeakMap<PromptResult, IterationContext>();
  const baseFactory = args.runtime.createLanguageModel ?? createModelFromString;
  const connection = args.credentials.mcpjam;
  const root = new HostRunner({
    ...(plan.host ? { host: plan.host.json } : {}),
    model: model.effectiveModel,
    tools: args.tools,
    apiKey:
      model.rail === "byok"
        ? (args.credentials.providerKeys[model.provider] ?? "")
        : "",
    ...(model.rail === "mcpjam" && args.leaseScope && connection
      ? {
          mcpjamLeaseScope: args.leaseScope,
          mcpjamProject: connection.projectId,
        }
      : {}),
    baseUrls: {
      ...(args.providerBaseUrls ?? {}),
      ...(connection ? { mcpjam: connection.baseUrl } : {}),
    },
    ...(plan.settings.systemPrompt !== undefined
      ? { systemPrompt: plan.settings.systemPrompt }
      : {}),
    ...(plan.settings.temperature !== undefined
      ? { temperature: plan.settings.temperature }
      : {}),
    maxSteps: plan.settings.maxSteps,
    mcpClientManager: args.manager,
  } as ConstructorParameters<typeof HostRunner>[0]);

  const cloneFor = (overrides: Record<string, unknown>): HostExecutor => {
    const context: IterationContext = { refusals: [] };
    if (args.snapshot) {
      context.gate = createLocalToolPolicyGate({
        snapshot: args.snapshot,
        caseId,
        // Rewritten once the iteration's number is known (see below).
        iterationNumber: 0,
      });
    }
    contexts.push(context);
    const clone = root.withOptions({
      ...overrides,
      ...(context.gate
        ? {
            tools: context.gate.wrap(args.tools),
            policyBlockedToolCallIds: context.gate.blockedToolCallIds,
          }
        : {}),
      createLanguageModel: attributingModelFactory(
        baseFactory,
        model.rail,
        (kind) => {
          context.refusals.push(kind);
          if (kind === "credentials" || kind === "billing") {
            args.onStop(kind);
            caseController.abort(
              new Error(
                kind === "credentials"
                  ? "stopped: the model credentials were rejected"
                  : "stopped: MCPJam refused inference for a billing reason"
              )
            );
          }
        }
      ),
    });
    return {
      run: async (message, runOptions) => {
        const result = await clone.run(message, runOptions);
        ownerOf.set(result, context);
        return result;
      },
      withOptions: (next) => cloneFor({ ...overrides, ...next }),
      getPromptHistory: () => clone.getPromptHistory(),
      resetPromptHistory: () => clone.resetPromptHistory(),
      getHostSnapshot: () => clone.getHostSnapshot(),
      getServerReplayConfigs: () => clone.getServerReplayConfigs?.(),
    };
  };
  const executor: HostExecutor = {
    run: () =>
      Promise.reject(
        new Error("internal: the local runner never runs its root executor")
      ),
    withOptions: (overrides) => cloneFor(overrides ?? {}),
    getPromptHistory: () => [],
    resetPromptHistory: () => {},
    getHostSnapshot: () => root.getHostSnapshot(),
  };

  const issues: SuiteFileRunIssue[] = [];
  let details: IterationResult[] = [];
  let evaluationConfig = planned.test.getEvaluationConfigSnapshot();
  try {
    const result = await planned.test.run(executor, {
      iterations: planned.testCase.iterations,
      concurrency: plan.settings.concurrency,
      retries: 0,
      timeoutMs: plan.settings.iterationTimeoutMs,
      // Explicit: a local run never reports, whatever MCPJAM_API_KEY says.
      mcpjam: { enabled: false },
      // Nor phones home: telemetry belongs to the caller, and the CLI's
      // opt-outs (`--no-telemetry`, a persisted choice) are invisible here.
      __suppressTelemetry: true,
      signal: caseController.signal,
      onProgress: (completed, total) =>
        args.progress({ type: "iteration", caseId, completed, total }),
    });
    details = result.iterationDetails;
    if (result.evaluationConfig) evaluationConfig = result.evaluationConfig;
    for (const observerError of result.observerErrors ?? []) {
      issues.push({
        code: "OBSERVER_FAILED",
        phase: "execution",
        category: "observer",
        message: observerError.message,
        caseId,
      });
    }
  } catch (error) {
    issues.push({
      code: "INTERNAL_ERROR",
      phase: "execution",
      category: "internal",
      message: `The case could not be executed: ${messageOf(error)}`,
      caseId,
    });
  } finally {
    args.runSignal.removeEventListener("abort", forward);
  }

  const observations: EvalTrialObservation[] = [];
  const evidence: SuiteFileIterationEvidence[] = [];
  const blocks: SuiteFileToolPolicyBlock[] = [];
  const refusals: SuiteFileRefusalAttribution[] = [];
  for (let index = 0; index < planned.testCase.iterations; index += 1) {
    const iterationNumber = index + 1;
    const iteration = details[index];
    if (!iteration) {
      // EvalTest itself failed: nothing about this iteration was observed.
      const unstarted = unstartedIteration(iterationNumber, "skipped");
      observations.push({ status: "failed" });
      evidence.push({
        ...unstarted.evidence,
        status: "failed",
        error: "the case could not be executed",
      });
      continue;
    }
    const firstPrompt = iteration.prompts?.[0];
    const context =
      (firstPrompt ? ownerOf.get(firstPrompt) : undefined) ?? contexts[index];
    const iterationBlocks = (context?.gate?.blocks ?? []).map((block) => ({
      ...block,
      iterationNumber,
    }));
    const refusal =
      context?.refusals.find(
        (kind) => kind === "credentials" || kind === "billing"
      ) ?? context?.refusals[0];
    let stage: Record<string, unknown> | undefined;
    try {
      stage = deriveIterationStageMetadata({
        iteration,
        ...(planned.expectedToolCalls
          ? { expectedToolCalls: planned.expectedToolCalls }
          : {}),
        ...(planned.predicates ? { predicates: planned.predicates } : {}),
        caseIdentity: {
          caseId,
          isNegativeTest: planned.testCase.isNegativeTest,
          ...(planned.testCase.expectedOutput !== undefined
            ? { expectedOutput: planned.testCase.expectedOutput }
            : {}),
        },
        policyBlocks: iterationBlocks,
      });
    } catch {
      stage = undefined;
    }
    let observed: ReturnType<typeof observeIteration>;
    try {
      observed = observeIteration({
        iteration,
        iterationNumber,
        evaluationConfig,
        ...(refusal !== undefined && iteration.status !== "completed"
          ? { refusal }
          : {}),
        policyBlocks: iterationBlocks,
        ...(stage ? { stage } : {}),
      });
    } catch (error) {
      issues.push({
        code: "EVIDENCE_INVALID",
        phase: "execution",
        category: "integrity",
        message: `Iteration ${iterationNumber} produced evidence the verdict policy cannot read: ${messageOf(error)}`,
        caseId,
        iterationNumber,
      });
      observations.push({ status: "failed" });
      evidence.push({
        ...unstartedIteration(iterationNumber, "skipped").evidence,
        status: "failed",
        error: "evidence could not be read",
      });
      continue;
    }
    if (iteration.captureError) {
      issues.push({
        code: "CAPTURE_LIMIT_EXCEEDED",
        phase: "execution",
        category: "integrity",
        message: `Iteration ${iterationNumber} exceeded the evidence capture limit; its transcript was not retained.`,
        caseId,
        iterationNumber,
      });
    }
    observations.push(observed.observation);
    evidence.push(observed.evidence);
    blocks.push(...iterationBlocks);
    if (refusal !== undefined && iteration.status !== "completed")
      refusals.push(refusal);
  }

  for (const kind of new Set(refusals)) {
    if (kind === "credentials") {
      issues.push({
        code: "CREDENTIALS_REJECTED",
        phase: "execution",
        category: "credentials",
        message: `The ${model.rail === "mcpjam" ? "MCPJam platform" : `${model.provider} provider`} rejected the credentials for ${model.effectiveModel}; the remaining work was not started.`,
        caseId,
      });
    } else if (kind === "billing") {
      issues.push({
        code: "BILLING_REFUSED",
        phase: "execution",
        category: "billing",
        message: `MCPJam refused inference for ${model.effectiveModel} for a billing reason; the remaining work was not started.`,
        caseId,
      });
    }
  }

  const interrupted = evidence.some(
    (entry) =>
      entry.status === "cancelled" ||
      entry.status === "skipped" ||
      entry.status === "pending"
  );
  const run: SuiteFileCaseRun = {
    ...baseCaseRun(planned, args.startedAt),
    evaluationConfigHash: evaluationConfig.hash,
    scorerIds: evaluationConfig.definitions.map(
      (definition) => definition.scorerId
    ),
    state: interrupted ? "interrupted" : "completed",
    iterations: evidence,
  };
  args.progress({ type: "caseFinish", caseId, state: run.state });
  return { run, observations, blocks, refusals, issues };
}

function finalize(args: {
  plan: SuiteFilePlan;
  executed: Awaited<ReturnType<typeof executeCases>>;
  snapshot: ToolPolicySnapshot | undefined;
  warnings: string[];
  startedAt: number;
  now: () => number;
}): SuiteFileRunResult {
  const { plan, executed } = args;
  const issues = [...executed.issues];
  const inputs: EvalCaseVerdictInput[] = executed.outcomes.map((outcome) => ({
    caseId: outcome.run.caseId,
    configuredTrials: outcome.run.configuredIterations,
    effectivePassThreshold: outcome.run.passThreshold,
    trials: outcome.observations,
  }));
  let decision: EvalVerdictDecision | null = null;
  try {
    decision = aggregateEvalRunVerdict({
      policy: plan.validity,
      cases: inputs,
    });
  } catch (error) {
    issues.push({
      code: "DECISION_INVALID",
      phase: "reporting",
      category: "integrity",
      message: `The run's evidence could not be aggregated: ${messageOf(error)}`,
    });
  }
  const byCase = new Map(
    (decision?.cases ?? []).map((entry) => [entry.caseId, entry])
  );
  const cases = executed.outcomes.map((outcome) => {
    const aggregation = byCase.get(outcome.run.caseId);
    return {
      ...outcome.run,
      ...(aggregation && outcome.run.state !== "notStarted"
        ? { aggregation }
        : {}),
    };
  });
  const complete =
    executed.termination === "completed" &&
    cases.every((entry) => entry.state === "completed");
  const verdict: SuiteFileRunVerdict =
    !complete || decision === null ? "notEstablished" : decision.verdict;
  const blocks = executed.outcomes.flatMap((outcome) => outcome.blocks);
  const configuredIterations = cases.reduce(
    (sum, entry) => sum + entry.configuredIterations,
    0
  );
  const executedIterations = cases.reduce(
    (sum, entry) =>
      sum +
      entry.iterations.filter(
        (iteration) =>
          !["cancelled", "skipped", "pending"].includes(iteration.status)
      ).length,
    0
  );
  const systemPromptSource: LocalEvalRunMetadata["execution"]["settings"]["systemPrompt"] =
    plan.settings.systemPrompt !== undefined
      ? "authored"
      : plan.host?.json.systemPrompt
        ? "host"
        : "default";
  const temperature =
    plan.settings.temperature ??
    (plan.host ? (plan.host.json.temperature ?? null) : null);
  const clientInfo = plan.host?.connection.clientInfo as
    { name?: unknown; version?: unknown } | undefined;
  const reportInput = {
    execution: {
      mode: "local" as const,
      engine: "emulated" as const,
      host: {
        templateId: plan.host?.id ?? null,
        ...(clientInfo && typeof clientInfo.name === "string"
          ? {
              clientInfo: {
                name: clientInfo.name,
                ...(typeof clientInfo.version === "string"
                  ? { version: clientInfo.version }
                  : {}),
              },
            }
          : {}),
        ...(plan.host?.connection.supportedProtocolVersions
          ? {
              supportedProtocolVersions: [
                ...plan.host.connection.supportedProtocolVersions,
              ],
            }
          : {}),
      },
      sdkVersion: readSdkVersion(),
      evaluatorVersion: `predicates-v${PREDICATES_VERSION}`,
      declaredHosts: plan.declaredHosts.map((entry) => ({
        ...entry,
        executed: false as const,
      })),
      declaredEnvironment: plan.declaredEnvironment
        ? { name: plan.declaredEnvironment, resolved: false as const }
        : null,
      servers: plan.targetServers.map((name) => ({
        name,
        source: plan.bindings[name]?.source ?? null,
        transport: transportOf(plan.bindings[name]!.config),
      })),
      settings: {
        concurrency: plan.settings.concurrency,
        iterationTimeoutMs: plan.settings.iterationTimeoutMs,
        maxSteps: plan.settings.maxSteps,
        setupTimeoutMs: plan.settings.setupTimeoutMs,
        systemPrompt: systemPromptSource,
        temperature,
      },
    },
    verdict,
    decision,
    termination: executed.termination,
    complete,
    population: {
      unit: "case" as const,
      cases: cases.length,
      configuredIterations,
      executedIterations,
      notStartedIterations: configuredIterations - executedIterations,
    },
    issues,
    suite: {
      id: plan.loaded.resolved.suite.id,
      ...(plan.loaded.resolved.suite.name !== undefined
        ? { name: plan.loaded.resolved.suite.name }
        : {}),
      schemaVersion: plan.loaded.resolved.schemaVersion,
      sourceHash: plan.sourceHash,
    },
    selection: {
      requested: plan.selection.requested,
      selected: plan.selection.selectedIds,
      skipped: plan.selection.skipped,
    },
    cases,
    toolPolicy: {
      declared: plan.toolPolicy ?? null,
      snapshot: args.snapshot ?? null,
      blocks,
    },
    declaredReportingMode: plan.loaded.resolved.reportingMode,
    warnings: args.warnings,
    durationMs: args.now() - args.startedAt,
  };
  let report;
  try {
    report = buildLocalEvalRunReport(reportInput);
  } catch (error) {
    const message =
      error instanceof LocalEvalRunReportError
        ? error.message
        : messageOf(error);
    throw new SuiteFileRunError({
      code: "REPORT_INVALID",
      phase: "reporting",
      category: "integrity",
      message: `The local run report could not be produced: ${message}`,
    });
  }
  return {
    verdict,
    passed: verdict === "passed",
    termination: executed.termination,
    complete,
    decision,
    cases,
    skippedCases: plan.selection.skipped,
    toolPolicy: {
      ...(plan.toolPolicy ? { declared: plan.toolPolicy } : {}),
      ...(args.snapshot ? { snapshot: args.snapshot } : {}),
      blocks,
    },
    warnings: args.warnings,
    issues,
    report,
  };
}
