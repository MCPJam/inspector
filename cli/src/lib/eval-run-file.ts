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
  declareEvalSuiteFileValidity,
  formatSuiteFileFindings,
  loadEvalSuiteFile,
  type ResolvedEvalSuiteFileCase,
  type SuiteFileLoadFailure,
} from "@mcpjam/sdk";
import {
  MAX_BATCH_CREATE_CASES,
  MAX_IMPORT_NOTE_CHARS,
} from "@mcpjam/sdk/contract";
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
import {
  findingsByCaseId,
  validateImportToolReferences,
  type ImportToolFinding,
} from "./eval-import-live-validation.js";
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
  testCase: ResolvedEvalSuiteFileCase
): Record<string, unknown> {
  return {
    id: testCase.id,
    title: testCase.title,
    ...(testCase.intent !== undefined ? { intent: testCase.intent } : {}),
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
    // The converter's CLAIM, carried through to the hosted row.
    //
    // Omitted for a native case rather than sent as an empty block: "authored
    // here" and "imported, claim unknown" are different facts, and once a case
    // is persisted nothing downstream can tell them apart again.
    ...(testCase.import ? { import: testCase.import } : {}),
  };
}

/**
 * Replacement-style PATCH body. Create omits false/empty fields; PATCH
 * treats omit as "leave the stored value", so a later file that drops
 * `isNegativeTest` or assertions must send an explicit clear.
 */
export function fileCaseToUpdateBody(
  testCase: ResolvedEvalSuiteFileCase
): Record<string, unknown> {
  return {
    title: testCase.title,
    // A file re-sync is authoritative: unlike an ordinary PATCH, a missing
    // label must clear the old one rather than preserve stale attribution.
    intent: testCase.intent ?? null,
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
    // Explicit `null` when the file dropped the block, for the same reason
    // every other field above is restated: PATCH reads omission as "leave the
    // stored value", so a re-sync of a file whose author deleted the import
    // block would otherwise leave a stale claim describing a conversion that
    // is no longer being asserted.
    import: testCase.import ?? null,
  };
}

function refuseEmptyEnabledSet(loaded: {
  resolved: { enabledCases: ResolvedEvalSuiteFileCase[] };
}): void {
  if (loaded.resolved.enabledCases.length === 0) {
    throw cliError(
      "NO_ENABLED_CASES",
      "This suite file has no enabled cases. Hosted launch without a case filter runs every persisted case, including rows the file marked disabled. Enable at least one case — the file is refused rather than executed unscoped.",
      SUITE_FILE_RUN_INVALID_EXIT_CODE
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
      SUITE_FILE_RUN_INVALID_EXIT_CODE
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
      SUITE_FILE_RUN_INVALID_EXIT_CODE
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
        SUITE_FILE_RUN_INVALID_EXIT_CODE
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
    }
  );
}

/**
 * The authored ids the launch will actually EXECUTE.
 *
 * Selection, not declaration: a disabled case is never selected, and with
 * `--case` in play neither is an enabled case nobody named. This set is what
 * separates "refuse the launch" from "write the corrected claim and move on",
 * so a case it calls selected but the launcher leaves out would refuse a run
 * that was never going to touch it.
 *
 * IT CANNOT ALWAYS TELL. {@link selectEnabledRunCases} resolves a `--case`
 * selector against the authored id, the HOSTED ROW ID, and the title — and the
 * row ids do not exist yet at this point in the launch, which is the whole
 * reason this check runs before any write. So a selector matching no authored
 * id or title is not "selects nothing": it is a row id naming one enabled case
 * whose identity is not knowable here.
 *
 * That case fails CLOSED. Treating it as "nothing selected" would sail past the
 * refusal, sync the suite, and bill a run whose deterministic call is already
 * known not to resolve — exactly the outcome the pre-write refusal exists to
 * prevent — so an unresolvable selector widens the set to every enabled case
 * instead. `indeterminate` reports that widening, because it is a weaker claim
 * than an exact selection and one caller must read it as such.
 */
export function selectedAuthoredCaseIds(
  cases: readonly ResolvedEvalSuiteFileCase[],
  selectors: readonly string[] | undefined
): { ids: Set<string>; indeterminate: boolean } {
  const enabled = cases.filter((testCase) => !testCase.disabled);
  const everyEnabled = () => new Set(enabled.map((testCase) => testCase.id));
  if (!selectors?.length) {
    return { ids: everyEnabled(), indeterminate: false };
  }
  // ID BEFORE TITLE, across the whole set — the precedence
  // {@link selectEnabledRunCases} uses. A per-case `id === s || title === s`
  // scan takes whichever case comes FIRST IN THE FILE instead, so a selector
  // matching an early case's title and a late case's id would resolve to a
  // different case here than at launch: this stage would leave the case the run
  // actually executes untouched, and refuse (or spare) one it never runs.
  const byId = new Map(enabled.map((testCase) => [testCase.id, testCase]));
  // Only case IDS are unique in the suite contract, so two enabled cases may
  // share a title. A `Map` would silently keep the last of them IN AUTHORED
  // ORDER, but the launcher resolves the same title against rows the sync
  // reordered — `[...toUpdate, ...created]`, so every already-hosted case
  // precedes every new one. Authored order and launch order therefore pick
  // DIFFERENT cases whenever a shared title spans a create and an update, and
  // this stage would vouch for one while the run executed the other.
  const byTitle = new Map<string, ResolvedEvalSuiteFileCase>();
  const ambiguousTitles = new Set<string>();
  for (const testCase of enabled) {
    if (byTitle.has(testCase.title)) ambiguousTitles.add(testCase.title);
    else byTitle.set(testCase.title, testCase);
  }
  const chosen = new Set<string>();
  for (const selector of selectors) {
    // ID first, so a string that is one case's id and another's shared title
    // still resolves by id — the precedence the launcher uses.
    const byIdHit = byId.get(selector);
    if (byIdHit) {
      chosen.add(byIdHit.id);
      continue;
    }
    // An ambiguous title cannot name one case HERE, and guessing which one the
    // launcher will pick is exactly the fail-open reading: guess wrong and the
    // case that actually executes is never checked. Widen instead.
    if (ambiguousTitles.has(selector)) {
      return { ids: everyEnabled(), indeterminate: true };
    }
    // A selector that resolves to no authored case is either a hosted row id
    // (which the launcher accepts and this stage cannot map) or a typo the
    // launcher will reject later by name. Neither is "selects nothing", and
    // guessing that it is would be the fail-open reading.
    const hit = byTitle.get(selector);
    if (!hit) return { ids: everyEnabled(), indeterminate: true };
    chosen.add(hit.id);
  }
  return { ids: chosen, indeterminate: false };
}

/**
 * Apply a completed live reference check to the cases the run is about to
 * write, and refuse before any write when a case that WILL EXECUTE cannot.
 *
 * Three outcomes, and the difference between them is the whole point:
 *
 *   - **Selected and unresolved → refuse.** Before the suite write, before the
 *     case writes, before the launch. Half a synced suite plus a run that was
 *     going to fail anyway is worse than a clean refusal, and the caller has
 *     paid for nothing.
 *   - **Imported, not selected, reference CONFIRMED missing → rewrite and
 *     persist.** The claim becomes `unresolved` with a note saying what did not
 *     resolve. The case is still written — a disabled row keeps its hosted
 *     history — and the hosted record now says what MCPJam actually found,
 *     rather than still asserting the converter's original claim about a tool
 *     that is not there.
 *   - **Native, not selected → untouched.** A case authored here never acquires
 *     an `import` block. Manufacturing provenance for it would turn "somebody
 *     wrote this by hand" into "something converted this", permanently, on the
 *     strength of a missing tool.
 *
 * A `TOOL_DISCOVERY_UNAVAILABLE` finding still REFUSES a selected case — not
 * being able to look is a reason to stop, not a reason to proceed — but it
 * never rewrites a claim. "We could not enumerate the targets" is not evidence
 * that a tool is missing, and recording `unresolved` on the strength of it
 * would destroy the converter's provenance to assert something MCPJam never
 * checked. That is the exact failure this whole feature exists to prevent, in
 * the one place where MCPJam is the one making the false claim.
 */
export function applyUnresolvedReferences(params: {
  cases: ResolvedEvalSuiteFileCase[];
  findings: readonly ImportToolFinding[];
  /** The authored ids the run will actually execute. */
  selectedCaseIds: ReadonlySet<string>;
}): ResolvedEvalSuiteFileCase[] {
  const byCase = findingsByCaseId(params.findings);
  if (byCase.size === 0) return params.cases;

  const blocked = params.cases.filter(
    (testCase) =>
      byCase.has(testCase.id) && params.selectedCaseIds.has(testCase.id)
  );
  if (blocked.length > 0) {
    const detail = blocked.map((testCase) => ({
      caseId: testCase.id,
      title: testCase.title,
      imported: testCase.import !== undefined,
      findings: byCase.get(testCase.id) ?? [],
    }));
    // A case blocked ONLY because discovery was unavailable is refused with the
    // reason it was actually refused for. Telling someone their tool does not
    // exist when the truth is "we could not look" sends them to rewrite a file
    // that is fine.
    const onlyUnavailable = detail.every((entry) =>
      entry.findings.every(
        (found) => found.code === "TOOL_DISCOVERY_UNAVAILABLE"
      )
    );
    throw cliError(
      "IMPORT_REFERENCE_UNRESOLVED",
      (onlyUnavailable
        ? `${blocked.length} selected case(s) make a deterministic tool call that could not be checked, because this run's targets cannot be enumerated before the suite is written. Nothing was written and no run was started.\n`
        : `${blocked.length} selected case(s) name a deterministic tool that does not resolve against this run's target. Nothing was written and no run was started.\n`) +
        detail
          .flatMap((entry) =>
            entry.findings.map(
              (found) => `  ${found.pointer}: ${found.message}`
            )
          )
          .join("\n"),
      SUITE_FILE_RUN_INVALID_EXIT_CODE,
      { unresolved: detail }
    );
  }

  return params.cases.map((testCase) => {
    // Only CONFIRMED missing references rewrite a claim. A case whose findings
    // are all `TOOL_DISCOVERY_UNAVAILABLE` was never actually checked against
    // an inventory, so its claim stands as authored.
    const found = byCase
      .get(testCase.id)
      ?.filter((entry) => entry.code === "TOOL_REFERENCE_UNRESOLVED");
    // Native cases are left exactly as authored — see the docblock.
    if (!found?.length || testCase.import === undefined) return testCase;
    return {
      ...testCase,
      import: {
        status: "unresolved" as const,
        // Lineage survives the rewrite: which source case this came from is a
        // fact about the import, not about the claim being made for it.
        ...(testCase.import.sourceCaseKey !== undefined
          ? { sourceCaseKey: testCase.import.sourceCaseKey }
          : {}),
        note: unresolvedNote(testCase.import, found),
      },
    };
  });
}

/**
 * The note a rewritten claim carries, bounded at the contract's cap.
 *
 * Bounded by SLICING rather than by refusing: this note is generated, not
 * authored, so an over-long one is MCPJam's problem to truncate and never a
 * reason to fail a launch that is otherwise fine. The previous claim is quoted
 * last so the truncation eats history rather than the finding that caused it.
 */
function unresolvedNote(
  previous: NonNullable<ResolvedEvalSuiteFileCase["import"]>,
  findings: readonly ImportToolFinding[]
): string {
  const reasons = findings
    .map((entry) => `${entry.pointer} (${entry.toolName})`)
    .join(", ");
  const preamble =
    `Marked unresolved by MCPJam at launch: the deterministic tool ` +
    `reference(s) ${reasons} did not resolve against this run's target. ` +
    `Re-state the claim once the reference resolves.`;
  const before = previous.note?.trim();
  const suffix =
    before === undefined || before.length === 0
      ? ` Previous claim: ${previous.status}.`
      : ` Previous claim: ${previous.status} — ${before}`;
  return `${preamble}${suffix}`.slice(0, MAX_IMPORT_NOTE_CHARS);
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
  }
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
    { signal: params.signal }
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
        { signal: params.signal }
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
        { signal: params.signal }
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
      }
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
        { signal: params.signal }
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
      }
    );
  }

  const enabledDeclaredIds = new Set(
    params.cases
      .filter((testCase) => !testCase.disabled)
      .map((testCase) => testCase.id)
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

/**
 * Check every `--allow-approximated` selector against the cases this run will
 * actually execute, BEFORE anything is written or billed.
 *
 * The backend re-checks all of this and remains authoritative — an approval it
 * does not accept is refused there whatever this says. That is not a reason to
 * skip it: a caller who mistyped a case id should hear about it before the
 * suite is synced, not after a round trip that already wrote cases.
 *
 * Every rejection below names a DIFFERENT mistake on purpose. "Approval
 * rejected" would be true of all six and useful for none:
 *
 *   - a native case has no claim to approve, so approving it is a
 *     misunderstanding of what the flag does;
 *   - a `exact` case needs no approval, and a receipt for a decision nobody
 *     had to make is worse than no receipt;
 *   - `unsupported` and `unresolved` cannot be approved into running at all —
 *     approval is for a case whose behaviour was approximated, not for one
 *     whose behaviour is missing;
 *   - a disabled or unselected case is not in this run, so approving it grants
 *     nothing;
 *   - an unknown selector is a typo, and guessing which case was meant is how
 *     an approval lands on the wrong one.
 */
export function assertApprovalsApplyToRun(params: {
  cases: readonly ResolvedEvalSuiteFileCase[];
  selectedCaseIds: ReadonlySet<string>;
  /**
   * False when `--case` carried a selector this stage could not map (see
   * {@link selectedAuthoredCaseIds}), so `selectedCaseIds` is every enabled
   * case rather than the exact set.
   *
   * Only the NOT-SELECTED refusal reads it, and reads it as "do not claim
   * this". Refusing an approval for a case that may well be in the run would
   * block a launch the caller got right; the backend re-checks every approval
   * against the cases the run actually executes and refuses it there, so the
   * cost of not guessing here is one round trip rather than a wrong answer.
   */
  selectionIsExact?: boolean;
  approvals: { cases: string[]; reason: string } | undefined;
}): void {
  if (!params.approvals) return;
  const byId = new Map(params.cases.map((entry) => [entry.id, entry]));
  const problems: Array<{ case: string; code: string; message: string }> = [];
  for (const selector of params.approvals.cases) {
    const testCase = byId.get(selector);
    if (!testCase) {
      problems.push({
        case: selector,
        code: "UNKNOWN_CASE",
        message: `"${selector}" is not a case id declared by this suite file. Approvals name the AUTHORED id (cases[].id), never a hosted row id or a title.`,
      });
      continue;
    }
    if (!testCase.import) {
      problems.push({
        case: selector,
        code: "NATIVE_CASE",
        message: `"${selector}" was authored here, not converted, so there is no import claim to approve.`,
      });
      continue;
    }
    if (testCase.import.status !== "approximated") {
      problems.push({
        case: selector,
        code:
          testCase.import.status === "exact"
            ? "EXACT_NEEDS_NO_APPROVAL"
            : "NOT_APPROVABLE",
        message:
          testCase.import.status === "exact"
            ? `"${selector}" is claimed exact and needs no approval. Remove it — an approval on a case nobody had to approve is a receipt for a decision that never happened.`
            : `"${selector}" is imported as "${testCase.import.status}", which cannot be approved into running. Approval covers a case whose behaviour was APPROXIMATED, not one whose behaviour is missing or unresolved.`,
      });
      continue;
    }
    // DISABLED is knowable from the file alone, with no selection involved, so
    // it refuses even when the selection is indeterminate. Sharing the gate
    // below would let a disabled-case approval past this stage and leave it to
    // `mapApprovalsToHostedCases` — a vaguer verdict, reached after the writes
    // this check exists to precede.
    if (testCase.disabled) {
      problems.push({
        case: selector,
        code: "CASE_DISABLED",
        message: `"${selector}" is marked disabled in the suite file, so this run will not execute it and the approval grants nothing.`,
      });
      continue;
    }
    if (
      params.selectionIsExact !== false &&
      !params.selectedCaseIds.has(selector)
    ) {
      problems.push({
        case: selector,
        code: "CASE_NOT_SELECTED",
        message: `"${selector}" is not among the cases this run executes (see --case), so the approval grants nothing.`,
      });
    }
  }
  if (problems.length === 0) return;
  throw cliError(
    "IMPORT_APPROVAL_INVALID",
    `${problems.length} approval(s) do not apply to this run. Nothing was written and no run was started.\n` +
      problems.map((entry) => `  ${entry.case}: ${entry.message}`).join("\n"),
    SUITE_FILE_RUN_INVALID_EXIT_CODE,
    { approvals: problems }
  );
}

/**
 * Map approved AUTHORED ids onto the hosted rows the sync just produced.
 *
 * The backend addresses cases by hosted id, and the caller only ever names the
 * id it authored. A selector that survived {@link assertApprovalsApplyToRun}
 * and still has no hosted row means the sync did not produce one, which is a
 * write that half-happened rather than a caller mistake — so it refuses loudly
 * rather than launching an approval short.
 */
export function mapApprovalsToHostedCases(params: {
  approvals: { cases: string[]; reason: string } | undefined;
  enabledCases: ReadonlyArray<{ id: string; declaredId: string }>;
}): Array<{ testCaseId: string; reason: string }> | undefined {
  if (!params.approvals) return undefined;
  const byDeclaredId = new Map(
    params.enabledCases.map((entry) => [entry.declaredId, entry.id] as const)
  );
  const mapped: Array<{ testCaseId: string; reason: string }> = [];
  const missing: string[] = [];
  for (const declaredId of params.approvals.cases) {
    const hosted = byDeclaredId.get(declaredId);
    if (!hosted) {
      missing.push(declaredId);
      continue;
    }
    mapped.push({ testCaseId: hosted, reason: params.approvals.reason });
  }
  if (missing.length > 0) {
    throw cliError(
      "IMPORT_APPROVAL_UNMAPPED",
      `Sync produced no hosted case for approved case(s) ${missing.join(
        ", "
      )}; the run was not started.`,
      SUITE_FILE_RUN_INVALID_EXIT_CODE,
      { missing }
    );
  }
  return mapped;
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
  /**
   * Per-run approval of `approximated` imported cases, by AUTHORED case id.
   *
   * One reason covers every approval in one invocation, because they are one
   * decision a human made once. Nothing here persists: a later run needs the
   * flags again, which is the whole point — an approximation is approved for a
   * RUN, never accepted for a case.
   */
  approvals?: { cases: string[]; reason: string };
};

/** The trimmed reason's bound, mirrored from the platform's own validator. */
export const MAX_APPROVAL_REASON_LENGTH = 500;

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
    // AUTHORED ids, sorted — not the hosted row ids the sync happened to
    // return. Two equivalent syncs of the same file can land on different
    // hosted ids, and keying on those would make the same run with the same
    // approvals look like a different run on a re-sync. Sorted so `--allow-
    // approximated a --allow-approximated b` and the reverse are one key: flag
    // ORDER is not a property of the run.
    approvals: params.knobs.approvals
      ? {
          cases: [...params.knobs.approvals.cases].sort(),
          reason: params.knobs.approvals.reason,
        }
      : null,
  });
}

function selectEnabledRunCases(
  enabledCases: Array<{ id: string; declaredId: string; title: string }>,
  allCases: ResolvedEvalSuiteFileCase[],
  selectors: string[] | undefined
): string[] {
  if (!selectors?.length) {
    return enabledCases.map((entry) => entry.id);
  }
  const byDeclared = new Map(
    enabledCases.map((entry) => [entry.declaredId, entry] as const)
  );
  const byTitle = new Map(
    enabledCases.map((entry) => [entry.title, entry] as const)
  );
  const byRowId = new Map(
    enabledCases.map((entry) => [entry.id, entry] as const)
  );
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
        (testCase.id === selector || testCase.title === selector)
    );
    if (disabled) {
      throw cliError(
        "CASE_DISABLED",
        `Case "${selector}" is marked disabled in the suite file and is left out of the launch. Remove --case ${selector}, or enable the case in the file.`,
        SUITE_FILE_RUN_INVALID_EXIT_CODE
      );
    }
    throw cliError(
      "CASE_NOT_IN_FILE",
      `Case "${selector}" is not an enabled case in this suite file.`,
      SUITE_FILE_RUN_INVALID_EXIT_CODE
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
  }
): Promise<RunEvalSuiteResult> {
  const page = await context.client.listProjects(
    {},
    { signal: context.signal }
  );
  const resolution = resolveProject(page.items, params.projectSelector);
  if (!resolution.ok) {
    throw projectResolutionError(resolution.message);
  }
  const project = resolution.project;

  if (looksLikeCreateEvalApiJson(params.source.text)) {
    throw usageError(
      "That looks like an eval create API body, not a versioned suite file. Use `eval create --file` to author a suite from that JSON."
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
  const knobs = params.knobs;

  // MANDATORY, and BEFORE the first write.
  //
  // Not opt-in: a converted case whose deterministic tool does not exist fails
  // every iteration it is billed for, and the failure looks like a product bug
  // rather than a conversion that lost a name. Placed above the suite write so
  // a refusal costs nothing and leaves nothing half-synced.
  const liveCheck = await validateImportToolReferences(context.client, {
    projectId: project.id,
    resolved: loaded.resolved,
    knobs,
    signal: context.signal,
  });
  const selection = selectedAuthoredCaseIds(loaded.resolved.cases, knobs.case);
  const outgoingCases = applyUnresolvedReferences({
    cases: loaded.resolved.cases,
    findings: liveCheck.findings,
    selectedCaseIds: selection.ids,
  });
  // Against the OUTGOING cases, not the authored ones: a case whose claim the
  // live check just rewrote to `unresolved` cannot be approved as an
  // approximation, and reading the pre-rewrite claim would let it through on
  // the strength of a status that is no longer true.
  assertApprovalsApplyToRun({
    cases: outgoingCases,
    selectedCaseIds: selection.ids,
    selectionIsExact: !selection.indeterminate,
    approvals: knobs.approvals,
  });

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
          // The AUTHORED shape, never the resolved one. `resolved.validity`
          // carries a `coverage` union that exists only in memory — the route's
          // body validator is strict and refuses it, so sending it rejected
          // every upload regardless of what the file declared.
          validity: declareEvalSuiteFileValidity(
            loaded.resolved.defaults.validity
          ),
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
    { signal: context.signal }
  );

  const syncedCases = await syncFileOwnedCases(context.client, {
    projectId: project.id,
    suiteId: synced.suite.id,
    cases: outgoingCases,
    declaredCaseIds: new Set(outgoingCases.map((testCase) => testCase.id)),
    signal: context.signal,
  });

  const hasExplicitTarget = Boolean(
    knobs.environment?.length ||
      knobs.host?.length ||
      knobs.allTargets ||
      knobs.server?.length ||
      knobs.compose
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
      { client: context.client, signal: context.signal }
    );
  }
  if (fileEnvironment) {
    await setEvalSuiteEnvironmentsOperation.execute(
      {
        project: project.id,
        suite: synced.suite.id,
        environments: [fileEnvironment],
      },
      { client: context.client, signal: context.signal }
    );
  }
  const runCases = selectEnabledRunCases(
    syncedCases.enabledCases,
    outgoingCases,
    knobs.case
  );

  const importApprovals = mapApprovalsToHostedCases({
    approvals: knobs.approvals,
    enabledCases: syncedCases.enabledCases,
  });

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
      ...(importApprovals ? { importApprovals } : {}),
    },
    {
      client: context.client,
      signal: context.signal,
      onDisclosure: context.onDisclosure,
      onDisclosureUnavailable: context.onDisclosureUnavailable,
    }
  );
}
