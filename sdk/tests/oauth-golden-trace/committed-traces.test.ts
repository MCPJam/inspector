/**
 * HP-44 — the CI gate over every committed golden trace.
 *
 * This is the mechanical half of "trace diffs run in CI; a drift or parity break
 * fails the build", and the thing HP-38's daily re-capture re-runs.
 *
 * It discovers traces from the filesystem rather than listing them, so a trace
 * added later is validated with no edit here. That property is the point: a
 * harness whose CI coverage has to be remembered is a harness that quietly stops
 * covering things.
 *
 * Every committed artifact must satisfy four invariants:
 *
 *  1. it is a v1 golden trace;
 *  2. it contains no live secret (re-checked, not trusted — redaction happens at
 *     capture time, and this catches a capture path that regressed);
 *  3. its `observations` still follow from its own `wire` (catches a hand-edited
 *     or half-migrated artifact);
 *  4. it asserts `redaction.applied`.
 *
 * And any two traces of the same host + scenario captured from DIFFERENT sides —
 * one `real-host`, one `emulator` — are automatically parity-diffed. Today no such
 * pair exists (see the coverage doc), so that assertion is vacuous by design and
 * will start biting the moment HP-43 produces a per-host emulator to compare.
 */

import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  diffGoldenTraces,
  findObservationDrift,
  findRedactionViolations,
  formatTraceDiffHuman,
  formatTraceSummaryHuman,
} from "../../src/oauth-golden-trace/index.js";
import type { GoldenTrace } from "../../src/oauth-golden-trace/index.js";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "golden-traces",
);

/**
 * Scenario files live alongside traces so a capture is reproducible from the
 * repo alone; they are inputs, not artifacts, so they are excluded here.
 */
function traceFiles(): string[] {
  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith(".json") && !name.startsWith("scenario-"))
    .sort();
}

function load(name: string): GoldenTrace {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as GoldenTrace;
}

describe("HP-44 committed golden traces", () => {
  const files = traceFiles();

  it("finds at least one committed trace", () => {
    // Guards against the discovery glob silently matching nothing, which would
    // make every assertion below pass while checking no artifact at all.
    expect(files.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(
      `HP-44 committed traces:\n${files
        .map((name) => `  ${formatTraceSummaryHuman(load(name))}`)
        .join("\n")}`,
    );
  });

  for (const name of files) {
    describe(name, () => {
      it("is a v1 golden trace that asserts redaction", () => {
        const trace = load(name);
        expect(trace.traceVersion).toBe(1);
        expect(trace.capture.redaction.applied).toBe(true);
        expect(trace.subject.hostId).toBeTruthy();
        expect(trace.scenario.scenarioId).toBeTruthy();
        // A trace that cannot say when it was captured is not dated evidence.
        expect(trace.capture.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      });

      it("contains no live secret", () => {
        expect(findRedactionViolations(load(name))).toEqual([]);
      });

      it("has observations derivable from its own wire", () => {
        expect(findObservationDrift(load(name))).toEqual([]);
      });
    });
  }

  it("parity-diffs every real-host / emulator pair of the same host and scenario", () => {
    const traces = files.map((name) => ({ name, trace: load(name) }));
    const pairs: Array<{ golden: GoldenTrace; candidate: GoldenTrace; label: string }> = [];

    for (const left of traces) {
      for (const right of traces) {
        if (left.name >= right.name) continue;
        const a = left.trace;
        const b = right.trace;
        if (a.subject.hostId !== b.subject.hostId) continue;
        if (a.scenario.scenarioId !== b.scenario.scenarioId) continue;
        if (a.subject.kind === b.subject.kind) continue;

        const golden = a.subject.kind === "real-host" ? a : b;
        const candidate = a.subject.kind === "real-host" ? b : a;
        pairs.push({
          golden,
          candidate,
          label: `${basename(left.name)} vs ${basename(right.name)}`,
        });
      }
    }

    // eslint-disable-next-line no-console
    console.log(`HP-44 comparable real-host/emulator pairs: ${pairs.length}`);

    for (const pair of pairs) {
      const diff = diffGoldenTraces(pair.golden, pair.candidate, { mode: "parity" });
      if (!diff.parity) {
        // eslint-disable-next-line no-console
        console.error(`PARITY BREAK — ${pair.label}\n${formatTraceDiffHuman(diff)}`);
      }
      expect(diff.counts.difference, `${pair.label}: ${diff.summary}`).toBe(0);
      expect(diff.counts.incomparable, `${pair.label}: ${diff.summary}`).toBe(0);
    }
  });
});
