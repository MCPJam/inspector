/**
 * `eval run --file` — after auth, validate a repo suite file, snapshot it as
 * a file-owned suite, sync its cases, and launch a run.
 *
 * Auth happens first on purpose: an invalid file on this command exits 2
 * (1 is reserved for a real verdict), and the caller must have been a
 * credentialed request when that verdict is reached. `eval validate` stays
 * offline and still exits 1 for a contract-invalid file.
 */

import { createHash } from "node:crypto";
import {
  canonicalDigest,
  formatSuiteFileFindings,
  loadEvalSuiteFile,
  type ResolvedEvalSuiteFileCase,
  type SuiteFileLoadFailure,
} from "@mcpjam/sdk";
import { MAX_BATCH_CREATE_CASES } from "@mcpjam/sdk/contract";
import {
  projectResolutionError,
  resolveProject,
  runEvalSuiteOperation,
  setEvalSuiteEnvironmentsOperation,
  updateEvalSuiteOperation,
  type PlatformApiClient,
  type PlatformEvalCase,
  type PlatformEvalRunDisclosure,
  type RunEvalSuiteInput,
  type RunEvalSuiteResult,
} from "@mcpjam/sdk/platform";
import { cliError, usageError } from "./output.js";

/** Hosted runs refuse more than this many iterations — named, not clamped. */
export const HOSTED_ITERATIONS_CAP = 10;

/** Invalid file on `eval run --file`. Distinct from validate's exit 1. */
export const SUITE_FILE_RUN_INVALID_EXIT_CODE = 2;

export function sha256HexOfBuffer(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * True when the text is a versioned suite file — JSON with `schemaVersion`,
 * or YAML whose first non-empty line (or any line) declares `schemaVersion:`.
 */
export function looksLikeVersionedSuiteFile(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "schemaVersion" in parsed
    ) {
      return true;
    }
  } catch {
    // YAML, or not JSON. Fall through to the text sniff.
  }
  return /^\s*schemaVersion\s*:/m.test(text);
}

/**
 * True when the text is JSON that looks like `eval create --file` API JSON
 * (a `tests` or `cases` array, no `schemaVersion`, no `suite` object).
 */
export function looksLikeCreateEvalApiJson(text: string): boolean {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const rec = parsed as Record<string, unknown>;
    if (rec.schemaVersion !== undefined) return false;
    if (rec.suite !== undefined && typeof rec.suite === "object") return false;
    return Array.isArray(rec.tests) || Array.isArray(rec.cases);
  } catch {
    return false;
  }
}

function fileCaseModels(testCase: ResolvedEvalSuiteFileCase) {
  return [
    {
      model: testCase.model,
      ...(testCase.provider ? { provider: testCase.provider } : {}),
    },
  ];
}

export function fileCaseToCreateBody(
  testCase: ResolvedEvalSuiteFileCase,
): Record<string, unknown> {
  return {
    id: testCase.id,
    title: testCase.title,
    steps: testCase.steps,
    iterations: testCase.repetitions,
    repetitions: testCase.repetitions,
    passThreshold: testCase.passThreshold,
    ...(testCase.expectedOutput !== undefined
      ? { expectedOutput: testCase.expectedOutput }
      : {}),
    ...(testCase.isNegativeTest ? { isNegative: true } : {}),
    models: fileCaseModels(testCase),
    ...(testCase.assertions.length > 0
      ? { checks: { mode: "replace", list: testCase.assertions } }
      : {}),
  };
}

/**
 * Replacement-style PATCH body. Create omits false/empty fields; PATCH
 * treats omit as "leave the stored value", so a later file that drops
 * `isNegativeTest` or assertions must send an explicit clear.
 */
export function fileCaseToUpdateBody(
  testCase: ResolvedEvalSuiteFileCase,
): Record<string, unknown> {
  return {
    title: testCase.title,
    steps: testCase.steps,
    iterations: testCase.repetitions,
    repetitions: testCase.repetitions,
    passThreshold: testCase.passThreshold,
    expectedOutput: testCase.expectedOutput ?? "",
    isNegative: testCase.isNegativeTest,
    models: fileCaseModels(testCase),
    checks:
      testCase.assertions.length > 0
        ? { mode: "replace", list: testCase.assertions }
        : null,
  };
}

function refuseEmptyEnabledSet(loaded: {
  resolved: { enabledCases: ResolvedEvalSuiteFileCase[] };
}): void {
  if (loaded.resolved.enabledCases.length === 0) {
    throw cliError(
      "NO_ENABLED_CASES",
      "This suite file has no enabled cases. Hosted launch without a case filter runs every persisted case, including rows the file marked disabled. Enable at least one case — the file is refused rather than executed unscoped.",
      SUITE_FILE_RUN_INVALID_EXIT_CODE,
    );
  }
}

function refuseUnsupportedHostedSemantics(loaded: {
  authored: {
    defaults: {
      toolPolicy?: unknown;
      validity?: {
        minEligibleTrials?: number;
        minCompletionRate?: number;
        maxEvaluatorErrorRate?: number;
      };
    };
  };
}): void {
  if (loaded.authored.defaults.toolPolicy !== undefined) {
    throw cliError(
      "TOOL_POLICY_UNSUPPORTED",
      "defaults.toolPolicy is not representable on a hosted run. The platform would execute the unrestricted tool set while stamping this file's hash. Remove toolPolicy, or run the suite locally.",
      SUITE_FILE_RUN_INVALID_EXIT_CODE,
    );
  }
}

function refuseRepetitions(loaded: {
  resolved: {
    defaults: { repetitions: number };
    cases: ResolvedEvalSuiteFileCase[];
  };
}): void {
  const suiteReps = loaded.resolved.defaults.repetitions;
  if (suiteReps > HOSTED_ITERATIONS_CAP) {
    throw cliError(
      "REPETITIONS_CAP",
      `Hosted runs accept at most ${HOSTED_ITERATIONS_CAP} iterations; the file's repetitions (${suiteReps}) exceed that cap. Reduce repetitions to ${HOSTED_ITERATIONS_CAP} or fewer — the value is not clamped.`,
      SUITE_FILE_RUN_INVALID_EXIT_CODE,
    );
  }
  // Every declared case is persisted, including disabled ones, so the cap
  // applies to parked rows too — otherwise a later enable would host 11+
  // iterations the file already named.
  for (const testCase of loaded.resolved.cases) {
    if (testCase.repetitions > HOSTED_ITERATIONS_CAP) {
      throw cliError(
        "REPETITIONS_CAP",
        `Hosted runs accept at most ${HOSTED_ITERATIONS_CAP} iterations; case "${testCase.id}" sets repetitions ${testCase.repetitions}. Reduce repetitions to ${HOSTED_ITERATIONS_CAP} or fewer — the value is not clamped.`,
        SUITE_FILE_RUN_INVALID_EXIT_CODE,
      );
    }
  }
}

function suiteFileLoadError(label: string, loaded: SuiteFileLoadFailure) {
  const summary =
    loaded.findings.length === 1
      ? `${label}: invalid (1 finding)`
      : `${label}: invalid (${loaded.findings.length} findings)`;
  return cliError(
    "SUITE_FILE_INVALID",
    `${summary}\n${formatSuiteFileFindings(loaded.findings)}`,
    SUITE_FILE_RUN_INVALID_EXIT_CODE,
    {
      valid: false,
      file: label,
      stage: loaded.stage,
      findings: [...loaded.findings],
    },
  );
}

export async function syncFileOwnedCases(
  client: PlatformApiClient,
  params: {
    projectId: string;
    suiteId: string;
    cases: ResolvedEvalSuiteFileCase[];
    /**
     * Every case id the file DECLARES, enabled or not.
     *
     * The deletion guard reads this, never `cases`. A `disabled: true` case is
     * still declared — the contract calls it "the loader skips this case (it
     * stays in the file)" — so deleting it would destroy the case's hosted
     * history the moment somebody parks a flaky test, and re-enabling it a day
     * later would not bring the iterations back. Disabled cases are created
     * and updated with the rest of the file, then excluded from the RUN via
     * `enabledCaseIds`.
     */
    declaredCaseIds: ReadonlySet<string>;
    signal?: AbortSignal;
  },
): Promise<{
  created: number;
  updated: number;
  deleted: number;
  batches: number;
  enabledCaseIds: string[];
  enabledCases: Array<{ id: string; declaredId: string; title: string }>;
}> {
  const existing = await client.listEvalCases(
    { projectId: params.projectId, suiteId: params.suiteId },
    { signal: params.signal },
  );
  const byDeclaredId = new Map<string, PlatformEvalCase>();
  for (const row of existing.items) {
    if (row.declaredId) byDeclaredId.set(row.declaredId, row);
  }

  const toCreate: ResolvedEvalSuiteFileCase[] = [];
  const toUpdate: Array<{
    row: PlatformEvalCase;
    file: ResolvedEvalSuiteFileCase;
  }> = [];
  const toDelete: PlatformEvalCase[] = [];
  for (const testCase of params.cases) {
    const row = byDeclaredId.get(testCase.id);
    if (row) toUpdate.push({ row, file: testCase });
    else toCreate.push(testCase);
  }
  for (const row of existing.items) {
    // Stale means "the file no longer declares this case" — NOT "the file does
    // not run it right now". A row the file still declares as `disabled` is
    // kept, with its history, and simply left out of `enabledCaseIds`.
    if (!row.declaredId || !params.declaredCaseIds.has(row.declaredId)) {
      toDelete.push(row);
    }
  }

  let batches = 0;
  let updatedCount = 0;
  const failed: Array<{
    index: number;
    declaredId?: string;
    code: string;
    message: string;
  }> = [];
  const createdCases: Array<{ id: string; declaredId: string; title: string }> =
    [];
  for (
    let offset = 0;
    offset < toCreate.length;
    offset += MAX_BATCH_CREATE_CASES
  ) {
    const chunk = toCreate.slice(offset, offset + MAX_BATCH_CREATE_CASES);
    batches += 1;
    try {
      const result = await client.createEvalCases(
        {
          projectId: params.projectId,
          suiteId: params.suiteId,
          body: { cases: chunk.map(fileCaseToCreateBody) },
        },
        { signal: params.signal },
      );
      for (const entry of result.created ?? []) {
        const declaredId = entry.declaredId ?? chunk[entry.index]?.id;
        if (declaredId) {
          createdCases.push({
            id: entry.id,
            declaredId,
            title: entry.title ?? chunk[entry.index]?.title ?? "",
          });
        }
      }
      for (const entry of result.failed ?? []) {
        failed.push({
          index: offset + entry.index,
          ...(entry.declaredId ? { declaredId: entry.declaredId } : {}),
          code: entry.code,
          message: entry.message,
        });
      }
    } catch (error) {
      failed.push({
        index: offset,
        ...(chunk[0] ? { declaredId: chunk[0].id } : {}),
        code: "CREATE_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const { row, file } of toUpdate) {
    try {
      await client.updateEvalCase(
        {
          projectId: params.projectId,
          suiteId: params.suiteId,
          caseId: row.id,
          body: fileCaseToUpdateBody(file),
        },
        { signal: params.signal },
      );
      updatedCount += 1;
    } catch (error) {
      failed.push({
        index: -1,
        declaredId: file.id,
        code: "UPDATE_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failed.length > 0) {
    throw cliError(
      "CASE_SYNC_FAILED",
      `Failed to sync ${failed.length} case(s) from the suite file; the run was not started.`,
      SUITE_FILE_RUN_INVALID_EXIT_CODE,
      {
        failed,
        created: createdCases.length,
        updated: updatedCount,
        deleted: 0,
        batches,
      },
    );
  }

  for (const row of toDelete) {
    try {
      await client.deleteEvalCase(
        {
          projectId: params.projectId,
          suiteId: params.suiteId,
          caseId: row.id,
        },
        { signal: params.signal },
      );
    } catch (error) {
      failed.push({
        index: -1,
        ...(row.declaredId ? { declaredId: row.declaredId } : {}),
        code: "DELETE_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failed.length > 0) {
    throw cliError(
      "CASE_SYNC_FAILED",
      `Failed to remove ${failed.length} stale case(s) from the suite file; the run was not started.`,
      SUITE_FILE_RUN_INVALID_EXIT_CODE,
      {
        failed,
        created: createdCases.length,
        updated: updatedCount,
        deleted: toDelete.length - failed.length,
        batches,
      },
    );
  }

  const enabledDeclaredIds = new Set(
    params.cases
      .filter((testCase) => !testCase.disabled)
      .map((testCase) => testCase.id),
  );
  const enabledCases = [
    ...toUpdate.map(({ row, file }) => ({
      id: row.id,
      declaredId: file.id,
      title: file.title,
    })),
    ...createdCases,
  ].filter((entry) => enabledDeclaredIds.has(entry.declaredId));
  return {
    created: toCreate.length,
    updated: toUpdate.length,
    deleted: toDelete.length,
    batches,
    enabledCaseIds: enabledCases.map((entry) => entry.id),
    enabledCases,
  };
}

export type EvalRunFileKnobs = {
  server?: string[];
  environment?: string[];
  host?: string[];
  allTargets?: boolean;
  repetitions?: number;
  /** Deprecated alias for repetitions. */
  iterations?: number;
  case?: string[];
  excludeSkills?: boolean;
  refreshSnapshot?: boolean;
  notes?: string;
  minPassRate?: number;
  matchOptions?: RunEvalSuiteInput["matchOptions"];
  idempotencyKey?: string;
  compose?: RunEvalSuiteInput["compose"];
};

/**
 * File-run idempotency covers the bytes AND every knob that changes what
 * launches. Same file + `--repetitions 1` vs `--repetitions 10` must not
 * collapse onto one run.
 */
export function deriveFileRunIdempotencyKey(params: {
  sourceHash: string;
  declaredSuiteId: string;
  projectId: string;
  target: unknown;
  knobs: EvalRunFileKnobs;
  fileEnvironment?: string;
}): string {
  if (params.knobs.idempotencyKey) return params.knobs.idempotencyKey;
  return canonicalDigest({
    sourceHash: params.sourceHash,
    declaredSuiteId: params.declaredSuiteId,
    project: params.projectId,
    target: params.target,
    servers: params.knobs.server ?? null,
    environments:
      params.knobs.environment ??
      (params.fileEnvironment ? [params.fileEnvironment] : null),
    hosts: params.knobs.host ?? null,
    allTargets: params.knobs.allTargets === true,
    repetitions: params.knobs.repetitions ?? params.knobs.iterations ?? null,
    cases: params.knobs.case ?? null,
    excludeSkills: params.knobs.excludeSkills === true,
    refreshSnapshot: params.knobs.refreshSnapshot === true,
    minPassRate: params.knobs.minPassRate ?? null,
    matchOptions: params.knobs.matchOptions ?? null,
    compose: params.knobs.compose ?? null,
  });
}

function selectEnabledRunCases(
  enabledCases: Array<{ id: string; declaredId: string; title: string }>,
  allCases: ResolvedEvalSuiteFileCase[],
  selectors: string[] | undefined,
): string[] {
  if (!selectors?.length) {
    return enabledCases.map((entry) => entry.id);
  }
  const byDeclared = new Map(
    enabledCases.map((entry) => [entry.declaredId, entry] as const),
  );
  const byTitle = new Map(
    enabledCases.map((entry) => [entry.title, entry] as const),
  );
  const byRowId = new Map(enabledCases.map((entry) => [entry.id, entry] as const));
  const selected: string[] = [];
  for (const selector of selectors) {
    const hit =
      byDeclared.get(selector) ??
      byRowId.get(selector) ??
      byTitle.get(selector);
    if (hit) {
      selected.push(hit.id);
      continue;
    }
    const disabled = allCases.find(
      (testCase) =>
        testCase.disabled &&
        (testCase.id === selector || testCase.title === selector),
    );
    if (disabled) {
      throw cliError(
        "CASE_DISABLED",
        `Case "${selector}" is marked disabled in the suite file and is left out of the launch. Remove --case ${selector}, or enable the case in the file.`,
        SUITE_FILE_RUN_INVALID_EXIT_CODE,
      );
    }
    throw cliError(
      "CASE_NOT_IN_FILE",
      `Case "${selector}" is not an enabled case in this suite file.`,
      SUITE_FILE_RUN_INVALID_EXIT_CODE,
    );
  }
  return selected;
}

/**
 * Auth has already happened: the caller invoked this inside
 * `runPlatformCommand` so the first network request is project resolution.
 */
export async function executeEvalRunFromFile(
  context: {
    client: PlatformApiClient;
    signal: AbortSignal;
    onDisclosure?: (disclosure: PlatformEvalRunDisclosure) => void;
    onDisclosureUnavailable?: (reason: string) => void;
  },
  params: {
    source: { text: string; bytes: number; buffer: Uint8Array };
    label: string;
    knobs: EvalRunFileKnobs;
    projectSelector?: string;
  },
): Promise<RunEvalSuiteResult> {
  const page = await context.client.listProjects({}, { signal: context.signal });
  const resolution = resolveProject(page.items, params.projectSelector);
  if (!resolution.ok) {
    throw projectResolutionError(resolution.message);
  }
  const project = resolution.project;

  if (looksLikeCreateEvalApiJson(params.source.text)) {
    throw usageError(
      "That looks like an eval create API body, not a versioned suite file. Use `eval create --file` to author a suite from that JSON.",
    );
  }

  const loaded = loadEvalSuiteFile(params.source.text, {
    byteLength: params.source.bytes,
  });
  if (!loaded.ok) {
    throw suiteFileLoadError(params.label, loaded);
  }

  refuseRepetitions(loaded);
  refuseEmptyEnabledSet(loaded);
  refuseUnsupportedHostedSemantics(loaded);

  const sourceHash = sha256HexOfBuffer(params.source.buffer);
  const authored = loaded.authored;
  const servers = authored.target.servers ?? [];
  const synced = await context.client.syncFileOwnedEvalSuite(
    {
      projectId: project.id,
      body: {
        declaredSuiteId: authored.suite.id,
        name: authored.suite.name,
        ...(authored.suite.description !== undefined
          ? { description: authored.suite.description }
          : {}),
        sourceHash,
        ...(authored.provenance ? { provenance: authored.provenance } : {}),
        verdictPolicyVersion: 2,
        verdictPolicyDefaults: {
          repetitions: loaded.resolved.defaults.repetitions,
          passThreshold: loaded.resolved.defaults.passThreshold,
          validity: loaded.resolved.defaults.validity,
        },
        environment: {
          servers: servers.map((server) => server.name),
          ...(servers.some((server) => server.id)
            ? {
                serverBindings: servers
                  .filter((server) => server.id)
                  .map((server) => ({
                    serverName: server.name,
                    projectServerId: server.id,
                  })),
              }
            : {}),
        },
        defaultConfig: {
          modelId: authored.defaults.model,
          ...(authored.defaults.systemPrompt !== undefined
            ? { systemPrompt: authored.defaults.systemPrompt }
            : {}),
          ...(authored.defaults.temperature !== undefined
            ? { temperature: authored.defaults.temperature }
            : {}),
        },
      },
    },
    { signal: context.signal },
  );

  const syncedCases = await syncFileOwnedCases(context.client, {
    projectId: project.id,
    suiteId: synced.suite.id,
    cases: loaded.resolved.cases,
    declaredCaseIds: new Set(
      loaded.resolved.cases.map((testCase) => testCase.id),
    ),
    signal: context.signal,
  });

  const knobs = params.knobs;
  const hasExplicitTarget = Boolean(
    knobs.environment?.length ||
      knobs.host?.length ||
      knobs.allTargets ||
      knobs.server?.length ||
      knobs.compose,
  );
  const fileEnvironment =
    !hasExplicitTarget && authored.target.environment
      ? authored.target.environment
      : undefined;
  const fileHosts =
    !hasExplicitTarget && !fileEnvironment
      ? authored.target.hosts?.map((host) => host.id ?? host.name)
      : undefined;
  if (!hasExplicitTarget && authored.target.hosts) {
    await updateEvalSuiteOperation.execute(
      {
        project: project.id,
        suite: synced.suite.id,
        hosts: authored.target.hosts.map((host) => ({
          host: host.id ?? host.name,
          ...(host.servers
            ? {
                servers: host.servers.map((server) => server.id ?? server.name),
              }
            : {}),
        })),
      },
      { client: context.client, signal: context.signal },
    );
  }
  if (fileEnvironment) {
    await setEvalSuiteEnvironmentsOperation.execute(
      {
        project: project.id,
        suite: synced.suite.id,
        environments: [fileEnvironment],
      },
      { client: context.client, signal: context.signal },
    );
  }
  const runCases = selectEnabledRunCases(
    syncedCases.enabledCases,
    loaded.resolved.cases,
    knobs.case,
  );

  const idempotencyKey = deriveFileRunIdempotencyKey({
    sourceHash,
    declaredSuiteId: authored.suite.id,
    projectId: project.id,
    target: authored.target,
    knobs,
    fileEnvironment,
  });

  return runEvalSuiteOperation.execute(
    {
      project: project.id,
      suite: synced.suite.id,
      sourceHash,
      idempotencyKey,
      ...(knobs.server ? { servers: knobs.server } : {}),
      ...(knobs.environment?.length === 1
        ? { environment: knobs.environment[0] }
        : knobs.environment?.length
          ? { environments: knobs.environment }
          : fileEnvironment
            ? { environment: fileEnvironment }
            : {}),
      ...(knobs.host?.length === 1
        ? { host: knobs.host[0] }
        : knobs.host?.length
          ? { hosts: knobs.host }
          : fileHosts?.length === 1
            ? { host: fileHosts[0] }
            : fileHosts?.length
              ? { hosts: fileHosts }
          : {}),
      ...(knobs.allTargets ? { allAttached: true } : {}),
      ...(knobs.repetitions !== undefined || knobs.iterations !== undefined
        ? { repetitions: knobs.repetitions ?? knobs.iterations }
        : {}),
      cases: runCases,
      ...(knobs.excludeSkills ? { excludeSkills: true } : {}),
      ...(knobs.refreshSnapshot ? { refreshSnapshot: true } : {}),
      ...(knobs.notes !== undefined ? { notes: knobs.notes } : {}),
      ...(knobs.minPassRate !== undefined
        ? { minPassRate: knobs.minPassRate }
        : {}),
      ...(knobs.matchOptions ? { matchOptions: knobs.matchOptions } : {}),
      ...(knobs.compose ? { compose: knobs.compose } : {}),
    },
    {
      client: context.client,
      signal: context.signal,
      onDisclosure: context.onDisclosure,
      onDisclosureUnavailable: context.onDisclosureUnavailable,
    },
  );
}
