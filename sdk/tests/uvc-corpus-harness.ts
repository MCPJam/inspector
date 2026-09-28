/**
 * Loader and scorer for the UVC acceptance corpus
 * (`tests/fixtures/uvc-corpus/`, plan step C0).
 *
 * Kept beside the corpus rather than inside the test file because two
 * different suites read it: `uvc-corpus.test.ts` asserts every labeled
 * outcome, and the recommended-seed test asserts that nothing enters the seed
 * above the corpus bar. One reader, so the bar cannot be stated twice and
 * drift.
 *
 * The corpus is authored AHEAD of the detectors on purpose. An expectation
 * naming a kind this SDK does not implement yet is reported as
 * `notImplemented` coverage instead of failing, so each kind's step turns its
 * own skips into assertions without anybody rewriting the corpus.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluatePredicate } from "../src/predicates/evaluate.js";
import { predicateSchema } from "../src/predicates/types.js";
import type {
  IterationTranscript,
  Predicate,
} from "../src/predicates/types.js";
import { PREDICATE_KINDS } from "../src/contract/grader-stage.js";

const CORPUS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "uvc-corpus",
);

/** Did the detector fire correctly, against what is literally in the transcript? */
export type CorpusObservation = "pass" | "fail" | "error";

/** Is a firing here a finding a server developer should see? */
export type CorpusRelevance = "useful" | "neutral" | "misleading";

export interface CorpusExpectation {
  predicate: Predicate;
  observation: CorpusObservation;
  relevance: CorpusRelevance;
  note?: string;
}

export interface CorpusItem {
  id: string;
  title: string;
  rationale: string;
  transcript: IterationTranscript;
  expect: CorpusExpectation[];
}

export function loadUvcCorpus(): CorpusItem[] {
  return readdirSync(CORPUS_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const item = JSON.parse(
        readFileSync(join(CORPUS_DIR, name), "utf8"),
      ) as CorpusItem;
      const stem = name.slice(0, -".json".length);
      if (item.id !== stem) {
        throw new Error(
          `uvc-corpus: ${name} declares id "${item.id}"; the id must equal the filename stem`,
        );
      }
      // Every expectation is parsed through the REAL schema, not cast into
      // shape. The corpus is the acceptance gate for these kinds, and a
      // fixture authoring a predicate the validator would refuse — an
      // observation without `role: "advisory"`, say — would report coverage
      // for a check nobody could actually save.
      for (const expectation of item.expect) {
        const parsed = predicateSchema.safeParse(expectation.predicate);
        if (!parsed.success) {
          throw new Error(
            `uvc-corpus: ${name} authors a predicate the validator refuses: ` +
              `${parsed.error.issues[0]?.message ?? "invalid"}`,
          );
        }
      }
      return item;
    });
}

/** The observed outcome of one expectation, in the corpus's own vocabulary. */
export function observe(
  transcript: IterationTranscript,
  predicate: Predicate,
): { observation: CorpusObservation; reason: string } {
  const result = evaluatePredicate(transcript, predicate);
  const status = (result as { status?: string }).status;
  return {
    observation:
      status === "error" ? "error" : result.passed ? "pass" : "fail",
    reason: result.reason,
  };
}

export interface KindReport {
  kind: string;
  /** False ⇒ the corpus labels it but this SDK has no such kind yet. */
  implemented: boolean;
  /** Expectations actually evaluated (0 while `implemented` is false). */
  evaluated: number;
  /** Labeled outcome ≠ observed outcome. Each entry is `itemId: expected→got`. */
  detectorErrors: string[];
  /** Firings the corpus labels `misleading`. Each entry is an item id. */
  misleadingFirings: string[];
  /** Firings the corpus labels `useful`. */
  usefulFirings: number;
}

export interface CorpusReport {
  items: number;
  expectations: number;
  byKind: Map<string, KindReport>;
}

function kindOf(predicate: Predicate): string {
  return predicate.type as unknown as string;
}

/**
 * Run every labeled expectation and tally, per kind, detector errors and
 * misleading firings. Pure: takes no bar and enforces none — callers decide
 * what to do with the numbers.
 */
export function summarizeUvcCorpus(
  corpus: CorpusItem[] = loadUvcCorpus(),
): CorpusReport {
  const known = new Set<string>(PREDICATE_KINDS as readonly string[]);
  const byKind = new Map<string, KindReport>();
  let expectations = 0;

  for (const item of corpus) {
    for (const expectation of item.expect) {
      expectations += 1;
      const kind = kindOf(expectation.predicate);
      let report = byKind.get(kind);
      if (!report) {
        report = {
          kind,
          implemented: known.has(kind),
          evaluated: 0,
          detectorErrors: [],
          misleadingFirings: [],
          usefulFirings: 0,
        };
        byKind.set(kind, report);
      }
      if (!report.implemented) continue;

      report.evaluated += 1;
      const { observation } = observe(item.transcript, expectation.predicate);
      if (observation !== expectation.observation) {
        report.detectorErrors.push(
          `${item.id}: expected ${expectation.observation}, got ${observation}`,
        );
        continue;
      }
      // A "firing" is a detector that reported something — `fail`. Only a
      // firing can be misleading; a pass has nothing to mislead about, which
      // is why the corpus contract pins non-firing rows to `neutral`.
      if (observation === "fail") {
        if (expectation.relevance === "misleading") {
          report.misleadingFirings.push(item.id);
        } else if (expectation.relevance === "useful") {
          report.usefulFirings += 1;
        }
      }
    }
  }

  return { items: corpus.length, expectations, byKind };
}

/**
 * The seed bar (plan step C7): zero detector errors AND zero misleading
 * firings across the corpus, on a kind the corpus actually covers.
 *
 * Zero here is a REGRESSION bar, not proof of general accuracy — the corpus
 * grows with every counterexample found in use, and a kind that starts firing
 * misleadingly on a newly added item leaves the seed.
 */
export function meetsCorpusSeedBar(
  kind: string,
  report: CorpusReport = summarizeUvcCorpus(),
): boolean {
  const entry = report.byKind.get(kind);
  if (!entry || !entry.implemented || entry.evaluated === 0) return false;
  return (
    entry.detectorErrors.length === 0 && entry.misleadingFirings.length === 0
  );
}

/** One line per kind, for a PR body. */
export function formatCorpusReport(
  report: CorpusReport = summarizeUvcCorpus(),
): string {
  const lines = [...report.byKind.values()]
    .sort((a, b) => a.kind.localeCompare(b.kind))
    .map((entry) =>
      entry.implemented
        ? `${entry.kind}: ${entry.evaluated} evaluated, ` +
          `${entry.detectorErrors.length} detector error(s), ` +
          `${entry.misleadingFirings.length} misleading firing(s), ` +
          `${entry.usefulFirings} useful firing(s)`
        : `${entry.kind}: not implemented yet (corpus labels present)`,
    );
  return [
    `uvc-corpus: ${report.items} items, ${report.expectations} expectations`,
    ...lines,
  ].join("\n");
}
