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
  type PlatformApiClient,
  type PlatformEvalCase,
  type RunEvalSuiteInput,
  type RunEvalSuiteResult,
} from "@mcpjam/sdk/platform";
import { cliError, usageError } from "./output.js";
import { fractionToPercent } from "./eval-suite-export.js";

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

export function fileCaseToCreateBody(
  testCase: ResolvedEvalSuiteFileCase,
): Record<string, unknown> {
  const models = [
    {
      model: testCase.model,
      ...(testCase.provider ? { provider: testCase.provider } : {}),
    },
  ];
  return {
    id: testCase.id,
    title: testCase.title,
    steps: testCase.steps,
    iterations: testCase.repetitions,
    ...(testCase.expectedOutput !== undefined
      ? { expectedOutput: testCase.expectedOutput }
      : {}),
    ...(testCase.isNegativeTest ? { isNegative: true } : {}),
    models,
    ...(testCase.assertions.length > 0
      ? { checks: { mode: "replace", list: testCase.assertions } }
      : {}),
  };
}

function fileCaseToUpdateBody(
  testCase: ResolvedEvalSuiteFileCase,
): Record<string, unknown> {
  const body = fileCaseToCreateBody(testCase);
  delete body.id;
  return body;
}

function refuseRepetitions(loaded: {
  resolved: {
    defaults: { repetitions: number };
    enabledCases: ResolvedEvalSuiteFileCase[];
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
  for (const testCase of loaded.resolved.enabledCases) {
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
    signal?: AbortSignal;
  },
): Promise<{ created: number; updated: number; batches: number }> {
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
  for (const testCase of params.cases) {
    const row = byDeclaredId.get(testCase.id);
    if (row) toUpdate.push({ row, file: testCase });
    else toCreate.push(testCase);
  }

  let batches = 0;
  const failed: Array<{
    index: number;
    declaredId?: string;
    code: string;
    message: string;
  }> = [];
  for (
    let offset = 0;
    offset < toCreate.length;
    offset += MAX_BATCH_CREATE_CASES
  ) {
    const chunk = toCreate.slice(offset, offset + MAX_BATCH_CREATE_CASES);
    batches += 1;
    const result = await client.createEvalCases(
      {
        projectId: params.projectId,
        suiteId: params.suiteId,
        body: { cases: chunk.map(fileCaseToCreateBody) },
      },
      { signal: params.signal },
    );
    for (const entry of result.failed ?? []) {
      failed.push({
        index: offset + entry.index,
        ...(entry.declaredId ? { declaredId: entry.declaredId } : {}),
        code: entry.code,
        message: entry.message,
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
        created: toCreate.length,
        updated: toUpdate.length,
        batches,
      },
    );
  }

  return { created: toCreate.length, updated: toUpdate.length, batches };
}

export type EvalRunFileKnobs = {
  server?: string[];
  environment?: string[];
  host?: string[];
  allTargets?: boolean;
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
 * Auth has already happened: the caller invoked this inside
 * `runPlatformCommand` so the first network request is project resolution.
 */
export async function executeEvalRunFromFile(
  context: {
    client: PlatformApiClient;
    signal: AbortSignal;
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

  const passPercent = fractionToPercent(loaded.resolved.defaults.passThreshold);
  if (passPercent === null) {
    throw cliError(
      "PASS_THRESHOLD",
      `defaults.passThreshold ${loaded.resolved.defaults.passThreshold} cannot be converted to a hosted percent without losing a digit.`,
      SUITE_FILE_RUN_INVALID_EXIT_CODE,
    );
  }

  const sourceHash = sha256HexOfBuffer(params.source.buffer);
  const authored = loaded.authored;
  const servers = authored.target.servers;
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
          systemPrompt: "",
          temperature: 0,
        },
        minIterations: authored.defaults.repetitions,
        defaultPassCriteria: { minimumPassRate: passPercent },
      },
    },
    { signal: context.signal },
  );

  await syncFileOwnedCases(context.client, {
    projectId: project.id,
    suiteId: synced.suite.id,
    cases: loaded.resolved.enabledCases,
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

  const idempotencyKey =
    knobs.idempotencyKey ??
    canonicalDigest({
      sourceHash,
      declaredSuiteId: authored.suite.id,
      project: project.id,
      target: authored.target,
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
          : {}),
      ...(knobs.allTargets ? { allAttached: true } : {}),
      ...(knobs.iterations !== undefined
        ? { iterations: knobs.iterations }
        : {}),
      ...(knobs.case?.length ? { cases: knobs.case } : {}),
      ...(knobs.excludeSkills ? { excludeSkills: true } : {}),
      ...(knobs.refreshSnapshot ? { refreshSnapshot: true } : {}),
      ...(knobs.notes !== undefined ? { notes: knobs.notes } : {}),
      ...(knobs.minPassRate !== undefined
        ? { minPassRate: knobs.minPassRate }
        : {}),
      ...(knobs.matchOptions ? { matchOptions: knobs.matchOptions } : {}),
      ...(knobs.compose ? { compose: knobs.compose } : {}),
    },
    { client: context.client, signal: context.signal },
  );
}
