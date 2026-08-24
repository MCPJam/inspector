/**
 * Read, write and diff `mcpjam-evals.lock.json`.
 *
 * The file half of the hosted corpus. Materialization, hashing and drift
 * detection are pure and live in `@mcpjam/sdk` (`corpus.ts`); everything that
 * touches a disk lives here.
 *
 * --- Why not `writeJsonArtifact` ---
 *
 * `reporting.ts:writeJsonArtifact` is the right tool for a report: a report is
 * written once, read by a human or a CI step, and a truncated one is obvious.
 * A lock file is different. It is READ BACK by `--frozen` on every subsequent
 * run, and a truncated one does not look broken — it looks like a corpus that
 * lost cases, which `--frozen` then reports as drift against a corpus nobody
 * edited. A plain `writeFile` that dies mid-flight (disk full, SIGINT between
 * two `write` syscalls) leaves exactly that.
 *
 * So: write a temp file in the DESTINATION DIRECTORY, fsync it, then `rename`.
 * `rename` within one filesystem is atomic, so a reader sees either the old
 * lock or the new one and never a half of either. The temp file must be a
 * sibling — `os.tmpdir()` is frequently a different filesystem, where `rename`
 * degrades to copy-then-unlink and loses the atomicity that is the entire
 * point.
 *
 * A lock is not a secret (it holds the same case content the dashboard shows
 * to anyone who can open the suite), so no `0600` — that would only make the
 * file awkward to commit and read in CI.
 *
 * --- Exit codes ---
 *
 * Drift is exit 1: a real, decided verdict — the corpus moved out from under
 * the lock. Everything else here is exit 3. A missing lock, an unreadable
 * lock, a lock from a future `lockVersion` and a failed fetch all mean "no
 * comparison was performed", which must never be reported as "the corpus
 * changed".
 */

import { open } from "node:fs/promises";
import path from "node:path";
import {
  CORPUS_LOCK_VERSION,
  type CorpusDrift,
  type CorpusLock,
} from "@mcpjam/sdk";
import { writeFileAtomic } from "./atomic-write.js";
import { CliError, cliError, normalizeCliError } from "./output.js";

/** The conventional lock filename, resolved against the working directory. */
export const DEFAULT_CORPUS_LOCK_PATH = "mcpjam-evals.lock.json";

/** The corpus drifted from the lock. A verdict, not an infrastructure fault. */
export const CORPUS_DRIFT_EXIT_CODE = 1;

/**
 * Nothing was established: no lock, an unreadable one, or a failed fetch.
 *
 * Deliberately NOT `operationalError`, which is exit 1. A `--frozen` check
 * that reports "your corpus changed" because the lock file was missing is
 * worse than one that fails loudly — it sends someone looking for an edit that
 * never happened.
 */
export const CORPUS_INCOMPLETE_EXIT_CODE = 3;

/** A malformed flag or an unresolvable selector. */
export const CORPUS_USAGE_EXIT_CODE = 2;

function incomplete(
  code: string,
  message: string,
  details?: unknown
): CliError {
  return cliError(code, message, CORPUS_INCOMPLETE_EXIT_CODE, details);
}

/**
 * Re-code a failed corpus fetch as incomplete.
 *
 * `runPlatformCommand` funnels every transport failure through `toCliError`,
 * whose default exit code is 1 — the code reserved for "the corpus drifted".
 * A DNS failure that reports itself as a corpus change is precisely the
 * confusion the exit contract exists to prevent, so anything that is not
 * already a usage error becomes exit 3 here.
 *
 * The original code and message survive; only the exit code moves.
 */
export function corpusFetchFailure(error: unknown): CliError {
  const normalized =
    error instanceof CliError ? error : normalizeCliError(error);
  // A malformed flag is the user's to fix and stays exit 2. It is also the one
  // failure that did not involve the network at all.
  if (normalized.exitCode === CORPUS_USAGE_EXIT_CODE) {
    return normalized;
  }
  return cliError(
    normalized.code,
    normalized.message,
    CORPUS_INCOMPLETE_EXIT_CODE,
    normalized.details
  );
}

/** Resolve the lock path against the working directory. */
export function resolveCorpusLockPath(value: string | undefined): string {
  return path.resolve(process.cwd(), value ?? DEFAULT_CORPUS_LOCK_PATH);
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The first structural defect in a lock, or `undefined` when it is sound.
 *
 * Returns a DESCRIPTION rather than a boolean, and names the offending row, so
 * the error tells a human which line of a hand-edited lock to look at instead
 * of just declaring the file bad.
 *
 * Scope is deliberate: the fields `verifyCorpusLock` joins on and the summary
 * prints. `normalizedContent` is checked only for being an object — its
 * contents are the server's wire shape, which `buildCorpus` re-validates far
 * more thoroughly than a duplicate schema here ever would.
 */
function describeLockDefect(lock: CorpusLock): string | undefined {
  if (!isRecord(lock.suite) || typeof lock.suite.id !== "string") {
    return `"suite.id" is missing or not a string`;
  }
  if (typeof lock.evaluationConfigHash !== "string") {
    return `"evaluationConfigHash" is missing or not a string`;
  }
  if (typeof lock.fetchedAt !== "string") {
    return `"fetchedAt" is missing or not a string`;
  }

  const REQUIRED_STRINGS = [
    "scenarioKey",
    "caseId",
    "title",
    "scenarioContentHash",
    "evaluationConfigHash",
  ] as const;

  for (const [index, row] of lock.cases.entries()) {
    if (!isRecord(row)) {
      return `case ${index} is not an object`;
    }
    for (const field of REQUIRED_STRINGS) {
      if (typeof row[field] !== "string") {
        return `case ${index} is missing "${field}"`;
      }
    }
    // The key is DERIVED, not stored twice: `buildCorpus` sets
    // `external:<caseId>` and `loadCorpusFromLock` slices the prefix back off
    // with a non-null assertion. A row where the two disagree crashes that
    // lookup, and before it does, the drift join reports the corruption as a
    // removed case plus an added one — exit 1 for a corrupt file.
    if (row.scenarioKey !== `external:${row.caseId}`) {
      return (
        `case ${index} ("${String(row.scenarioKey)}") has a scenarioKey that ` +
        `does not match its caseId`
      );
    }
    // Integer and at least 1. NaN, Infinity, 0, -1 and 1.5 are all corruption.
    //
    // No UPPER bound, though the API caps writes at 10 today: a client that
    // hard-codes a server constant starts rejecting valid locks the day the
    // server raises it, and an out-of-range count is a value nobody can act on
    // rather than a shape that breaks anything here.
    if (!Number.isInteger(row.iterations) || (row.iterations as number) < 1) {
      return (
        `case ${index} ("${String(row.scenarioKey)}") has an invalid ` +
        `"iterations" (${String(row.iterations)})`
      );
    }
    if (!isRecord(row.normalizedContent)) {
      return `case ${index} ("${String(
        row.scenarioKey
      )}") is missing "normalizedContent"`;
    }
  }

  // Two rows under one key make the drift join lossy: `new Map` keeps the last
  // and the earlier one silently vanishes from the comparison.
  const keys = new Set<string>();
  for (const row of lock.cases) {
    const key = (row as { scenarioKey: string }).scenarioKey;
    if (keys.has(key)) {
      return `"${key}" appears twice`;
    }
    keys.add(key);
  }

  return undefined;
}

/**
 * Parse a lock file, or fail with a message that says what to run.
 *
 * Every failure here is exit 3. The distinction that matters to a human is
 * "you have never pulled" vs "the file on disk is not a lock", so the two
 * carry different messages rather than one generic read error.
 */
export async function readCorpusLock(lockPath: string): Promise<CorpusLock> {
  let raw: string;
  try {
    const handle = await open(lockPath, "r");
    try {
      raw = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissingFileError(error)) {
      throw incomplete(
        "CORPUS_LOCK_MISSING",
        `No corpus lock at "${lockPath}". Run \`mcpjam cloud eval pull\` to create ` +
          `one before checking it with --frozen.`
      );
    }
    throw incomplete(
      "CORPUS_LOCK_UNREADABLE",
      `Could not read the corpus lock at "${lockPath}".`,
      { source: error instanceof Error ? error.message : String(error) }
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw incomplete(
      "CORPUS_LOCK_MALFORMED",
      `The corpus lock at "${lockPath}" is not valid JSON. Re-create it with ` +
        `\`mcpjam cloud eval pull\`.`,
      { source: error instanceof Error ? error.message : String(error) }
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw incomplete(
      "CORPUS_LOCK_MALFORMED",
      `The corpus lock at "${lockPath}" is not a lock object.`
    );
  }

  const lock = parsed as Partial<CorpusLock>;
  if (typeof lock.lockVersion !== "number" || !Array.isArray(lock.cases)) {
    throw incomplete(
      "CORPUS_LOCK_MALFORMED",
      `The corpus lock at "${lockPath}" is missing "lockVersion" or "cases". ` +
        `Re-create it with \`mcpjam cloud eval pull\`.`
    );
  }

  // Validate the fields `verifyCorpusLock` actually joins on, and validate
  // them HERE.
  //
  // Not defensive noise: a `null` or half-written row makes `verifyCorpusLock`
  // throw a bare TypeError reading `.scenarioKey`, which escapes as
  // INTERNAL_ERROR and normalizes to exit 1 — a malformed lock reported as
  // "your corpus drifted". Every structural problem must land on exit 3, and
  // the only way to guarantee that is to reject the shape before the pure code
  // ever sees it.
  const structural = describeLockDefect(lock as CorpusLock);
  if (structural) {
    throw incomplete(
      "CORPUS_LOCK_MALFORMED",
      `The corpus lock at "${lockPath}" is malformed: ${structural}. ` +
        `Re-create it with \`mcpjam cloud eval pull\`.`
    );
  }

  // A version check, not a hash check. The content hash is over a versioned
  // allowlist, so a lock written by a different SDK can disagree field-for-
  // field about hashes that describe identical cases — comparing across
  // versions would report drift on every case in the file.
  if (lock.lockVersion !== CORPUS_LOCK_VERSION) {
    throw incomplete(
      "CORPUS_LOCK_VERSION_MISMATCH",
      `The corpus lock at "${lockPath}" is version ${lock.lockVersion}, but ` +
        `this CLI writes version ${CORPUS_LOCK_VERSION}. Hashes are not ` +
        `comparable across lock versions. Re-create it with ` +
        `\`mcpjam cloud eval pull\`.`
    );
  }

  return lock as CorpusLock;
}

/**
 * Write the lock through a sibling temp file and a rename.
 *
 * On ANY failure the temp file is removed and the destination is left exactly
 * as it was. A partially-written lock is the one outcome this must never
 * produce — see the module comment. The temp-file dance itself is
 * `writeFileAtomic`; what stays here is the lock's own reading of a failed
 * write, which is exit 3 ("no comparison happened") and nobody else's.
 */
export async function writeCorpusLockAtomic(
  lockPath: string,
  lock: CorpusLock
): Promise<string> {
  const resolved = path.resolve(process.cwd(), lockPath);

  try {
    // Serialized INSIDE the try. `JSON.stringify` throws on a value it cannot
    // represent, and from the caller's side that is a failed write like any
    // other — it must land on exit 3 with the destination untouched, not
    // escape as a raw TypeError that normalizes to exit 1.
    const body = `${JSON.stringify(lock, null, 2)}\n`;
    return await writeFileAtomic(resolved, body);
  } catch (error) {
    throw incomplete(
      "CORPUS_LOCK_WRITE_FAILED",
      `Failed to write the corpus lock to "${resolved}". The previous lock, ` +
        `if any, is unchanged.`,
      { source: error instanceof Error ? error.message : String(error) }
    );
  }
}

const DRIFT_LABELS: Record<CorpusDrift["kind"], string> = {
  caseAdded: "added   ",
  caseRemoved: "removed ",
  contentChanged: "content ",
  evaluationConfigChanged: "grading ",
};

const DRIFT_MARKS: Record<CorpusDrift["kind"], string> = {
  caseAdded: "+",
  caseRemoved: "-",
  contentChanged: "~",
  evaluationConfigChanged: "~",
};

/**
 * Render drift for a human reading CI output.
 *
 * `contentChanged` and `evaluationConfigChanged` are rendered as distinct
 * kinds because they have different fixes: the first means someone edited the
 * case, the second means someone changed how it is graded. Collapsing them
 * into "changed" would hide which happened, and the second is the one that
 * silently moves a pass rate.
 */
export function renderCorpusDrift(drift: CorpusDrift[]): string {
  if (drift.length === 0) {
    return "Corpus matches the lock.";
  }

  const lines = drift.map(
    (entry) =>
      `  ${DRIFT_MARKS[entry.kind]} ${DRIFT_LABELS[entry.kind]} ` +
      `${entry.scenarioKey}  ${JSON.stringify(entry.title)}`
  );

  return [
    `Corpus drifted from the lock (${drift.length} ${
      drift.length === 1 ? "change" : "changes"
    }):`,
    ...lines,
    "",
    "Run `mcpjam cloud eval pull` to accept these changes, or restore the cases in " +
      "the dashboard.",
  ].join("\n");
}
