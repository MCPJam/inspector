/**
 * Everything a local run checks before it starts a process, opens a
 * connection or asks a model anything.
 *
 * Ordered, and each stage refuses with EVERY problem it found rather than the
 * first:
 *
 *   1. parse and select — the whole file must be valid; `caseIds` must name
 *      enabled cases exactly;
 *   2. validate every selected case — materialize its `EvalTest` through the
 *      hosted corpus conversion, refuse what a local run cannot execute
 *      (direct tool calls, widgets, discovery checks, suite-standard
 *      suppressions, gating judges), and check import claims and approvals;
 *   3. resolve execution inputs — target servers, host template, one model and
 *      rail per case, and the bindings the caller supplied.
 *
 * Nothing here has side effects, so a valid first case followed by an
 * unsupported second one costs zero model and tool calls: every `EvalTest` is
 * constructed before any runs.
 */

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { EvalTest } from "../EvalTest.js";
import { HostedOnlyCaseError, evalTestFromPlatformCase } from "../corpus.js";
import type { EvalExpectedToolCall } from "../eval-reporting-types.js";
import type { HostJson } from "../host-config/public-types.js";
import { canonicalizeHostConfigV2 } from "../host-config/canonicalize.js";
import { canonicalToPublic } from "../host-config/host.js";
import {
  hostConnectionProfile,
  type HostConnectionProfile,
} from "../host-config/host-connection.js";
import {
  HOST_TEMPLATE_IDS,
  seedHostTemplate,
  type HostTemplateId,
} from "../host-config/templates/index.js";
import type { HostConfigInputV2 } from "../host-config/types.js";
import { checkRole } from "../predicates/index.js";
import type { Predicate } from "../predicates/types.js";
import { requiresRenderObservations } from "../predicates/types.js";
import {
  isDiscoveryPredicateKind,
  type StageAuthoredCase,
} from "../contract/stage-derivation.js";
import { buildStageAuthoredCase } from "../contract/stage-authored-case.js";
import type { TestStep } from "../contract/steps.js";
import type { SuiteJudgeSettings } from "../contract/judge-settings.js";
import type { EvalSuiteFileToolPolicy } from "../contract/suite-file.js";
import type { ResolvedEvalValidityPolicy } from "../contract/verdict-policy.js";
import {
  loadEvalSuiteFile,
  type ResolvedEvalSuiteFileCase,
  type SuiteFileLoadSuccess,
} from "../suite-file-loader.js";
import { refusal, type SuiteFileRunProblem } from "./errors.js";
import {
  assertLocalImportEligibility,
  type ImportDecision,
} from "./import-gate.js";
import { planModel, type PlannedModel } from "./inference.js";
import { platformCaseFromSuiteFileCase } from "./platform-case.js";
import type {
  RunSuiteFileOptions,
  SuiteFileJudgeState,
  SuiteFileServerBinding,
} from "./types.js";

export const DEFAULT_CONCURRENCY = 1;
export const DEFAULT_ITERATION_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_STEPS = 10;
export const DEFAULT_SETUP_TIMEOUT_MS = 30_000;

/**
 * The judge defaults a hosted run resolves an unconfigured judge to —
 * mirrored from `mcpjam-backend` `GOAL_COMPLETION_DEFAULTS` (and its
 * inspector mirror, `shared/judge-defaults.ts`). Only the fields that decide
 * whether a judge would run and whether it gates are needed here.
 */
export const HOSTED_JUDGE_DEFAULTS = Object.freeze({
  enabled: true,
  autoRun: true,
  role: "advisory" as const,
});

/** The command a hosted-only capability is sent to. */
const HOSTED_REMEDIATION =
  "Run it hosted (`mcpjam cloud eval run --file <file>`), or remove it from this local run.";

export type PlannedCase = {
  testCase: ResolvedEvalSuiteFileCase;
  test: EvalTest;
  model: PlannedModel;
  judge: SuiteFileJudgeState;
  importDecision?: ImportDecision;
  /** Tool names the case expects deterministically (for the import check). */
  expectedToolNames: string[];
  expectedToolCalls?: EvalExpectedToolCall[];
  predicates?: Predicate[];
  /**
   * What the case asserts, for the stage analyzer — built by
   * `buildStageAuthoredCase`, the function the hosted runner builds it with,
   * so a local iteration's stage chain is derived as a hosted one would be.
   */
  stageCase: StageAuthoredCase;
};

export type ResolvedLocalHost = {
  id: HostTemplateId;
  connection: HostConnectionProfile;
  json: HostJson;
};

export type SuiteFilePlan = {
  loaded: SuiteFileLoadSuccess;
  sourceHash: string;
  selection: {
    requested: string[] | null;
    selectedIds: string[];
    skipped: Array<{ caseId: string; reason: "disabled" | "notSelected" }>;
  };
  cases: PlannedCase[];
  targetServers: string[];
  bindings: Record<string, SuiteFileServerBinding>;
  declaredHosts: Array<{ name: string; id?: string; servers?: string[] }>;
  declaredEnvironment?: string;
  host?: ResolvedLocalHost;
  toolPolicy?: EvalSuiteFileToolPolicy;
  validity: ResolvedEvalValidityPolicy;
  settings: {
    concurrency: number;
    iterationTimeoutMs: number;
    maxSteps: number;
    setupTimeoutMs: number;
    systemPrompt?: string;
    temperature?: number;
  };
  warnings: string[];
};

/** sha256 over the file's UTF-8 bytes — the digest hosted file launch records. */
export function suiteFileSourceHash(sourceText: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(sourceText)));
}

function positiveInteger(
  name: string,
  value: number | undefined,
  fallback: number,
  problems: SuiteFileRunProblem[]
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    problems.push({
      message: `${name} must be a positive integer (received ${String(value)}).`,
    });
    return fallback;
  }
  return value;
}

/**
 * Effective judge state, on the hosted layering: suite settings over the
 * hosted defaults, then the case's `enabled` override.
 */
export function resolveLocalJudgeState(
  suite: SuiteJudgeSettings | undefined,
  testCase: ResolvedEvalSuiteFileCase
): SuiteFileJudgeState {
  const enabled =
    testCase.judge?.enabled ?? suite?.enabled ?? HOSTED_JUDGE_DEFAULTS.enabled;
  const autoRun = suite?.autoRun ?? HOSTED_JUDGE_DEFAULTS.autoRun;
  const role = suite?.role ?? HOSTED_JUDGE_DEFAULTS.role;
  return {
    configured: suite !== undefined || testCase.judge !== undefined,
    effective: {
      enabled,
      autoRun,
      role,
      ...(suite?.threshold !== undefined ? { threshold: suite.threshold } : {}),
      ...(suite?.model !== undefined ? { model: suite.model } : {}),
    },
    run: false,
    skipReason: !enabled
      ? "disabled"
      : !autoRun
        ? "notAutomatic"
        : "localJudgeUnsupported",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks that read what a tool RETURNED, or how long each call took. A local
 * run's transcript carries tool calls and usage only — no tool results and no
 * per-call timings — so a GATING one would grade as an evaluator error on
 * every iteration and leave the run inconclusive, where a hosted run measures
 * it. An advisory one never gates, and is reported as not measured.
 * (`fullPageHasContinuation` reads results too, but can only be advisory.)
 */
const TOOL_RESULT_OR_TIMING_KINDS: ReadonlySet<string> = new Set([
  "toolResultContains",
  "toolResultMatches",
  "toolResultMatchesSchema",
  "toolResultSizeUnder",
  "toolLatencyUnder",
]);

/** What a local run cannot execute in one case, found without materializing it. */
function unsupportedInCase(
  testCase: ResolvedEvalSuiteFileCase
): SuiteFileRunProblem[] {
  const problems: SuiteFileRunProblem[] = [];
  if ((testCase.suppressedSuiteStandardCheckIds?.length ?? 0) > 0) {
    problems.push({
      caseId: testCase.id,
      reason: "suppressedSuiteStandardChecks",
      message:
        "suppresses suite-standard checks, which only a hosted suite has; a local run has " +
        "no suite-standard registry to suppress. Remove suppressedSuiteStandardCheckIds, or " +
        HOSTED_REMEDIATION.charAt(0).toLowerCase() +
        HOSTED_REMEDIATION.slice(1),
    });
  }
  const assertionProblem = (
    assertion: unknown,
    where: Pick<SuiteFileRunProblem, "stepId" | "stepIndex" | "pointer">
  ): SuiteFileRunProblem | undefined => {
    if (!isRecord(assertion)) return undefined;
    if (typeof assertion.kind === "string") {
      return {
        caseId: testCase.id,
        ...where,
        reason: "widgetAssertion",
        message: `uses a widget assertion, which needs hosted render observations. ${HOSTED_REMEDIATION}`,
      };
    }
    const type =
      typeof assertion.type === "string" ? assertion.type : undefined;
    if (type !== undefined && requiresRenderObservations(type)) {
      return {
        caseId: testCase.id,
        ...where,
        reason: "renderAssertion",
        message: `asserts ${type}, which needs widget render observations only a hosted run captures. ${HOSTED_REMEDIATION}`,
      };
    }
    if (type !== undefined && isDiscoveryPredicateKind(type)) {
      return {
        caseId: testCase.id,
        ...where,
        reason: "discoveryAssertion",
        message: `asserts ${type}, which reads the raw tool declarations a hosted run captures. ${HOSTED_REMEDIATION}`,
      };
    }
    if (
      type !== undefined &&
      TOOL_RESULT_OR_TIMING_KINDS.has(type) &&
      checkRole(assertion) === "gating"
    ) {
      return {
        caseId: testCase.id,
        ...where,
        reason: "toolResultAssertion",
        message: `gates on ${type}, which reads tool results or per-call timings a local run does not capture yet. ${HOSTED_REMEDIATION}`,
      };
    }
    return undefined;
  };
  testCase.steps.forEach((step, index) => {
    const record = step as unknown as Record<string, unknown>;
    const stepId = typeof record.id === "string" ? record.id : undefined;
    const where = { ...(stepId ? { stepId } : {}), stepIndex: index };
    if (record.kind === "toolCall") {
      problems.push({
        caseId: testCase.id,
        ...where,
        reason: "toolCallStep",
        message:
          "is a direct toolCall step; local runs execute prompt steps only in this release. " +
          "Replace it with a prompt that leads the agent to call the tool, or run the case " +
          "hosted (`mcpjam cloud eval run --file <file>`).",
      });
      return;
    }
    if (record.kind === "interact") {
      problems.push({
        caseId: testCase.id,
        ...where,
        reason: "interactStep",
        message: `is a widget interact step, which needs the hosted headless browser. ${HOSTED_REMEDIATION}`,
      });
      return;
    }
    if (record.kind === "assert") {
      const problem = assertionProblem(record.assertion, where);
      if (problem) problems.push(problem);
    }
  });
  testCase.assertions.forEach((assertion, index) => {
    const problem = assertionProblem(assertion, {
      pointer: `assertions[${index}]`,
    });
    if (problem) problems.push(problem);
  });
  return problems;
}

function resolveHost(hostTemplateId: string): ResolvedLocalHost {
  const id = hostTemplateId as HostTemplateId;
  const seeded = seedHostTemplate(id);
  const connection = hostConnectionProfile(
    seeded as unknown as Record<string, unknown>
  );
  const json = canonicalToPublic(
    canonicalizeHostConfigV2({
      ...(seeded as unknown as HostConfigInputV2),
      // Servers are the suite's targets; the emulated host attaches none of
      // its own and saves no connection overrides.
      serverIds: [],
      optionalServerIds: [],
      serverConnectionOverrides: undefined,
    } as unknown as HostConfigInputV2)
  );
  return { id, connection, json };
}

export function preflightSuiteFile(
  sourceText: string,
  options: RunSuiteFileOptions
): SuiteFilePlan {
  // ── options ────────────────────────────────────────────────────────────────
  const optionProblems: SuiteFileRunProblem[] = [];
  const concurrency = positiveInteger(
    "concurrency",
    options.concurrency,
    DEFAULT_CONCURRENCY,
    optionProblems
  );
  const iterationTimeoutMs = positiveInteger(
    "iterationTimeoutMs",
    options.iterationTimeoutMs,
    DEFAULT_ITERATION_TIMEOUT_MS,
    optionProblems
  );
  const maxSteps = positiveInteger(
    "maxSteps",
    options.maxSteps,
    DEFAULT_MAX_STEPS,
    optionProblems
  );
  const setupTimeoutMs = positiveInteger(
    "setupTimeoutMs",
    options.setupTimeoutMs,
    DEFAULT_SETUP_TIMEOUT_MS,
    optionProblems
  );
  const mode = options.inference?.mode ?? "auto";
  if (!["auto", "byok", "mcpjam"].includes(mode)) {
    optionProblems.push({
      message: `inference.mode must be auto, byok or mcpjam (received ${String(mode)}).`,
    });
  }
  if (!isRecord(options.servers)) {
    optionProblems.push({
      message: "servers must be an object of name-keyed bindings.",
    });
  }
  if (optionProblems.length > 0) {
    throw refusal({
      code: "OPTIONS_INVALID",
      phase: "validation",
      category: "usage",
      summary: "Invalid runSuiteFile options.",
      problems: optionProblems,
    });
  }

  // ── 1. parse and select ────────────────────────────────────────────────────
  const loaded = loadEvalSuiteFile(sourceText);
  if (!loaded.ok) {
    throw refusal({
      code: "SUITE_FILE_INVALID",
      phase: "validation",
      category: "usage",
      summary: "The suite file is invalid; nothing was run.",
      problems: loaded.findings.map((finding) => ({
        message: finding.message,
        ...(finding.pointer ? { pointer: finding.pointer } : {}),
        reason: finding.code,
      })),
    });
  }
  const resolved = loaded.resolved;
  const byId = new Map(resolved.cases.map((entry) => [entry.id, entry]));
  const selectionProblems: SuiteFileRunProblem[] = [];
  let selected: ResolvedEvalSuiteFileCase[];
  const requested = options.caseIds ? [...options.caseIds] : null;
  if (requested) {
    const seen = new Set<string>();
    selected = [];
    const wanted = new Set<string>();
    for (const caseId of requested) {
      if (seen.has(caseId)) {
        selectionProblems.push({
          caseId,
          message: "is selected more than once.",
        });
        continue;
      }
      seen.add(caseId);
      const testCase = byId.get(caseId);
      if (!testCase) {
        selectionProblems.push({
          caseId,
          message:
            "is not a case id declared by this suite file (selection matches cases[].id exactly).",
        });
        continue;
      }
      if (testCase.disabled) {
        selectionProblems.push({
          caseId,
          message: "is disabled in the suite file; enable it to run it.",
        });
        continue;
      }
      wanted.add(caseId);
    }
    if (requested.length === 0) {
      selectionProblems.push({ message: "the case selection is empty." });
    }
    // Authored order, whatever order the selection named them in.
    selected = resolved.cases.filter((entry) => wanted.has(entry.id));
  } else {
    selected = resolved.enabledCases;
    if (selected.length === 0) {
      selectionProblems.push({
        message: "the suite file has no enabled cases.",
      });
    }
  }
  if (selectionProblems.length > 0) {
    throw refusal({
      code: "CASE_SELECTION_INVALID",
      phase: "validation",
      category: "usage",
      summary: "The case selection is invalid; nothing was run.",
      problems: selectionProblems,
    });
  }
  const selectedIds = new Set(selected.map((entry) => entry.id));
  const skipped = resolved.cases
    .filter((entry) => !selectedIds.has(entry.id))
    .map((entry) => ({
      caseId: entry.id,
      reason: entry.disabled ? ("disabled" as const) : ("notSelected" as const),
    }));

  // ── 2. validate every selected case ────────────────────────────────────────
  const unsupported: SuiteFileRunProblem[] = [];
  const invalid: SuiteFileRunProblem[] = [];
  const materialized = new Map<string, EvalTest>();
  const judges = new Map<string, SuiteFileJudgeState>();
  for (const testCase of selected) {
    const found = unsupportedInCase(testCase);
    const judge = resolveLocalJudgeState(resolved.defaults.judge, testCase);
    judges.set(testCase.id, judge);
    if (judge.effective.enabled && judge.effective.role !== "advisory") {
      found.push({
        caseId: testCase.id,
        reason: "gatingJudge",
        message:
          `has an effective ${judge.effective.role} LLM judge. A local run does not run judges, ` +
          "so it cannot produce the verdict a gating judge decides. Make the judge advisory or " +
          "disable it for this case, or run the suite hosted.",
      });
    }
    if (found.length > 0) {
      unsupported.push(...found);
      continue;
    }
    try {
      materialized.set(
        testCase.id,
        evalTestFromPlatformCase(platformCaseFromSuiteFileCase(testCase))
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof HostedOnlyCaseError) {
        unsupported.push({
          caseId: testCase.id,
          ...(error.stepId !== undefined ? { stepId: error.stepId } : {}),
          ...(error.stepIndex !== undefined
            ? { stepIndex: error.stepIndex }
            : {}),
          reason: "hostedOnly",
          message,
        });
      } else {
        invalid.push({ caseId: testCase.id, reason: "invalidCase", message });
      }
    }
  }
  if (unsupported.length > 0 || invalid.length > 0) {
    const onlyJudge =
      invalid.length === 0 &&
      unsupported.every((problem) => problem.reason === "gatingJudge");
    throw refusal({
      code:
        invalid.length > 0 && unsupported.length === 0
          ? "CASE_INVALID"
          : onlyJudge
            ? "JUDGE_UNSUPPORTED"
            : "CASE_UNSUPPORTED",
      phase: "validation",
      category:
        invalid.length > 0 && unsupported.length === 0
          ? "usage"
          : "unsupported",
      summary: "Selected cases cannot run locally; nothing was run.",
      problems: [...unsupported, ...invalid],
    });
  }
  const importDecisions = assertLocalImportEligibility({
    cases: resolved.cases,
    selected,
    approvals: options.importApprovals ?? [],
  });

  // ── 3. execution inputs ────────────────────────────────────────────────────
  const targetProblems: SuiteFileRunProblem[] = [];
  const target = resolved.target;
  const targetServers: string[] = [];
  if (!target.servers || target.servers.length === 0) {
    targetProblems.push({
      message:
        `the target names only environment "${target.environment}". A local run does not ` +
        "resolve environments; list the servers under target.servers and bind them locally.",
    });
  } else {
    const names = new Set<string>();
    for (const server of target.servers) {
      const name = server.name?.trim();
      if (!name) {
        targetProblems.push({
          message:
            "a target server has no usable name; local bindings are matched by name, never by hosted id.",
        });
        continue;
      }
      if (names.has(name)) {
        targetProblems.push({
          server: name,
          message: "is listed more than once in target.servers.",
        });
        continue;
      }
      names.add(name);
      targetServers.push(name);
    }
  }
  if (targetProblems.length > 0) {
    throw refusal({
      code: "TARGET_UNSUPPORTED",
      phase: "validation",
      category: "usage",
      summary: "The suite's target cannot be run locally.",
      problems: targetProblems,
    });
  }

  let host: ResolvedLocalHost | undefined;
  if (options.hostTemplateId !== undefined) {
    if (
      !(HOST_TEMPLATE_IDS as readonly string[]).includes(options.hostTemplateId)
    ) {
      throw refusal({
        code: "HOST_TEMPLATE_UNKNOWN",
        phase: "validation",
        category: "usage",
        summary: `Unknown host template "${options.hostTemplateId}". Valid hosts: ${HOST_TEMPLATE_IDS.join(", ")}.`,
        problems: [],
      });
    }
    host = resolveHost(options.hostTemplateId);
  }

  const modelProblems: SuiteFileRunProblem[] = [];
  const conflictProblems: SuiteFileRunProblem[] = [];
  const cases: PlannedCase[] = [];
  const providerKeys = options.inference?.providerKeys ?? {};
  for (const testCase of selected) {
    const planned = planModel({
      model: testCase.model,
      ...(testCase.provider !== undefined
        ? { provider: testCase.provider }
        : {}),
      mode,
      providerKeys,
    });
    if (!planned.ok) {
      (planned.code === "INFERENCE_CONFLICT"
        ? conflictProblems
        : modelProblems
      ).push({
        caseId: testCase.id,
        model: testCase.model,
        message: planned.message,
      });
      continue;
    }
    const test = materialized.get(testCase.id)!;
    const config = test.getConfig();
    const expectedToolCalls = config.expectedToolCalls;
    const predicates = config.predicates;
    const decision = importDecisions.get(testCase.id);
    cases.push({
      testCase,
      test,
      model: planned.plan,
      judge: judges.get(testCase.id)!,
      ...(decision ? { importDecision: decision } : {}),
      // Direct `toolCall` steps were refused above, so the expected calls are
      // the only tools a case names deterministically.
      expectedToolNames: [
        ...new Set((expectedToolCalls ?? []).map((call) => call.toolName)),
      ],
      ...(expectedToolCalls ? { expectedToolCalls } : {}),
      ...(predicates ? { predicates } : {}),
      stageCase: buildStageAuthoredCase({
        test: {
          isNegativeTest: testCase.isNegativeTest,
          ...(testCase.expectedOutput !== undefined
            ? { expectedOutput: testCase.expectedOutput }
            : {}),
          ...(expectedToolCalls ? { expectedToolCalls } : {}),
          // What the hosted record stores the case-level assertions as.
          successPredicates: testCase.assertions,
        },
        steps: testCase.steps as unknown as TestStep[],
        // A local run drives prompt steps only: a model always takes a turn.
        caseNeedsModel: true,
      }),
    });
  }
  if (conflictProblems.length > 0 || modelProblems.length > 0) {
    throw refusal({
      code:
        conflictProblems.length > 0
          ? "INFERENCE_CONFLICT"
          : "MODEL_UNSUPPORTED",
      phase: "validation",
      category: "usage",
      summary:
        "Selected cases name models this local run cannot use; nothing was run.",
      problems: [...conflictProblems, ...modelProblems],
    });
  }

  const bindings: Record<string, SuiteFileServerBinding> = {};
  const unknownBindings = Object.keys(options.servers).filter(
    (name) => !targetServers.includes(name)
  );
  if (unknownBindings.length > 0) {
    throw refusal({
      code: "SERVER_BINDING_INVALID",
      phase: "validation",
      category: "usage",
      summary: "Server bindings name servers the suite does not target.",
      problems: unknownBindings.map((name) => ({
        server: name,
        message: `is not in target.servers (${targetServers.join(", ")}).`,
      })),
    });
  }
  const missing: SuiteFileRunProblem[] = [];
  for (const name of targetServers) {
    const binding = options.servers[name];
    if (!binding || !isRecord(binding) || !isRecord(binding.config)) {
      missing.push({ server: name, message: "has no binding." });
      continue;
    }
    bindings[name] = binding;
  }
  if (missing.length > 0) {
    throw refusal({
      code: "SERVER_BINDING_MISSING",
      phase: "setup",
      category: "setup",
      summary:
        "Target servers are not bound to a local configuration; nothing was run.",
      problems: missing,
    });
  }

  // ── warnings ───────────────────────────────────────────────────────────────
  const warnings: string[] = [];
  const unrunJudges = cases.filter(
    (entry) => entry.judge.skipReason === "localJudgeUnsupported"
  );
  if (unrunJudges.length > 0) {
    warnings.push(
      `${unrunJudges.length} of ${cases.length} case(s) have an advisory LLM judge ` +
        `${resolved.defaults.judge === undefined ? "(the hosted default) " : ""}that a ` +
        "hosted run would grade with. Local runs do not run judges; the report records it " +
        "as configured but not run. Set defaults.judge.enabled: false to state that in the file."
    );
  }
  if (target.environment !== undefined) {
    warnings.push(
      `target.environment "${target.environment}" is recorded but not resolved; the explicit ` +
        "servers run with their local bindings."
    );
  }
  if (target.hosts !== undefined) {
    warnings.push(
      `${target.hosts.length} target host(s) are recorded but not launched; a local run ` +
        "executes the target servers once" +
        (host ? ` under the emulated "${host.id}" host.` : ".")
    );
  }

  return {
    loaded,
    sourceHash: suiteFileSourceHash(sourceText),
    selection: {
      requested,
      selectedIds: selected.map((entry) => entry.id),
      skipped,
    },
    cases,
    targetServers,
    bindings,
    declaredHosts: (target.hosts ?? []).map((entry) => ({
      name: entry.name,
      ...(entry.id !== undefined ? { id: entry.id } : {}),
      ...(entry.servers !== undefined
        ? { servers: entry.servers.map((server) => server.name) }
        : {}),
    })),
    ...(target.environment !== undefined
      ? { declaredEnvironment: target.environment }
      : {}),
    ...(host ? { host } : {}),
    ...(resolved.defaults.toolPolicy !== undefined
      ? { toolPolicy: resolved.defaults.toolPolicy }
      : {}),
    validity: resolved.defaults.validity,
    settings: {
      concurrency,
      iterationTimeoutMs,
      maxSteps,
      setupTimeoutMs,
      ...(resolved.defaults.systemPrompt !== undefined
        ? { systemPrompt: resolved.defaults.systemPrompt }
        : {}),
      ...(resolved.defaults.temperature !== undefined
        ? { temperature: resolved.defaults.temperature }
        : {}),
    },
    warnings,
  };
}
