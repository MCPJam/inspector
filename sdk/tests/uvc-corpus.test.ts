/**
 * The UVC acceptance corpus, run (plan step C0).
 *
 * Two assertions, because the corpus carries two labels:
 *
 *   1. every implemented kind reproduces its labeled `observation` — the
 *      detector is right about what is in the transcript;
 *   2. no kind fires on an item labeled `misleading` — the finding is one a
 *      server developer should actually see.
 *
 * (2) is deliberately NOT a blanket assertion. A kind is allowed to have
 * misleading firings in the corpus — that is what makes it Report-only rather
 * than seedable — so the bar is enforced where it bites, in the
 * recommended-seed test, and reported here for every kind.
 */

import { describe, expect, it } from "vitest";

import {
  formatCorpusReport,
  loadUvcCorpus,
  observe,
  summarizeUvcCorpus,
} from "./uvc-corpus-harness.js";
import { PREDICATE_KINDS } from "../src/contract/grader-stage.js";

const corpus = loadUvcCorpus();
const known = new Set<string>(PREDICATE_KINDS as readonly string[]);

describe("uvc corpus — shape", () => {
  it("has items, and every item carries labeled expectations", () => {
    expect(corpus.length).toBeGreaterThan(0);
    for (const item of corpus) {
      expect(item.title, `${item.id} has no title`).toBeTruthy();
      expect(item.rationale, `${item.id} has no rationale`).toBeTruthy();
      expect(
        item.expect.length,
        `${item.id} labels nothing`,
      ).toBeGreaterThan(0);
    }
  });

  it("labels relevance only where the detector actually fires", () => {
    // A pass or an unmeasurable row has nothing to mislead about. Letting it
    // carry `useful`/`misleading` would put a quality judgement on a
    // non-event, and the seed bar counts firings.
    for (const item of corpus) {
      for (const expectation of item.expect) {
        if (expectation.observation === "fail") continue;
        expect(
          expectation.relevance,
          `${item.id}/${expectation.predicate.type}: a non-firing row must be labeled "neutral"`,
        ).toBe("neutral");
      }
    }
  });

  it("covers the counterexamples review round 1 named", () => {
    const ids = new Set(corpus.map((item) => item.id));
    for (const required of [
      "answer-ends-with-offer",
      "poll-job-status",
      "retry-after-transient-failure",
      "tool-error-rate-limited",
      "pagination-full-page-is-last",
      "arguments-schema-valid-wrong-intent",
      "recovered-tool-error",
      "capture-incomplete-narration",
      "deprecated-mentioned-not-deprecated",
    ]) {
      expect(ids.has(required), `corpus is missing "${required}"`).toBe(true);
    }
  });
});

describe("uvc corpus — detector agreement", () => {
  for (const item of corpus) {
    for (const expectation of item.expect) {
      const kind = expectation.predicate.type as unknown as string;
      const title = `${item.id} · ${kind} ⇒ ${expectation.observation}`;
      if (!known.has(kind)) {
        it.skip(`${title} (kind not implemented yet)`, () => {});
        continue;
      }
      it(title, () => {
        const { observation, reason } = observe(
          item.transcript,
          expectation.predicate,
        );
        expect(
          observation,
          `${item.id}/${kind}: ${expectation.note ?? item.rationale}\nreason: ${reason}`,
        ).toBe(expectation.observation);
      });
    }
  }
});

describe("uvc corpus — report", () => {
  it("prints the per-kind agreement and false-positive counts", () => {
    const report = summarizeUvcCorpus(corpus);
    // The numbers a C/J step's PR body quotes. Printed rather than asserted:
    // the per-expectation tests above are the assertion, and a kind is allowed
    // misleading firings — that is what keeps it out of the seed.
    console.log(formatCorpusReport(report));
    expect(report.expectations).toBeGreaterThan(0);
  });
});
