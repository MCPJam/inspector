/**
 * Historical parity over the corpus at `tests/fixtures/parity/v1/`.
 *
 * Two questions, and they are different:
 *   1. Does the analyzer still produce, for every recorded iteration, EXACTLY
 *      the rows recorded for it? (No judge evidence in play at all.)
 *   2. When advisory judge evidence IS supplied, does it only ever fill a row
 *      deterministic evidence left silent — never overturn one?
 *
 * The recorded legacy verdict is carried alongside and never recomputed: it is
 * the thing this whole wave must not touch, so the corpus asserts it is stable
 * rather than deriving it from the code under test.
 *
 * The manifest is verified first. A corpus whose digest is not checked is a
 * corpus anyone can edit into agreement.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  deriveStageResults,
  STAGE_ANALYZER_VERSION,
  type StageAuthoredCase,
  type StageDerivation,
  type StageEvidence,
  type StageResultRow,
} from "../src/contract/stage-derivation.js";

const CORPUS = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "parity",
  "v1"
);

type ManifestFile = { path: string; sha256: string; bytes: number };
type Manifest = {
  corpusVersion: string;
  origin: string;
  bounds: { maxIterations: number; maxBytes: number };
  stageAnalyzerVersion: number;
  iterations: number;
  bytes: number;
  corpusDigest: string;
  files: ManifestFile[];
  review: Record<string, string>;
};

type CorpusRecord = {
  id: string;
  note: string;
  origin: string;
  authored: StageAuthoredCase;
  evidence: StageEvidence;
  iteration: { status: "completed" | "failed"; error?: string };
  recorded: {
    legacyPassed: boolean;
    stageResults: StageResultRow[];
    firstFailedStage?: string;
    failureCategory?: string;
    stageAnalyzerVersion: number;
  };
};

function readRaw(name: string): string {
  return readFileSync(join(CORPUS, name), "utf8");
}

const manifest = JSON.parse(readRaw("MANIFEST.json")) as Manifest;
const records: CorpusRecord[] = manifest.files.map(
  (file) => JSON.parse(readRaw(file.path)) as CorpusRecord
);

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function userValue(rows: StageResultRow[]): StageResultRow {
  const row = rows.find((candidate) => candidate.stage === "userValue");
  if (!row) throw new Error("corpus record has no userValue row");
  return row;
}

function derive(record: CorpusRecord, judge?: StageEvidence["judgeEvidence"]) {
  return deriveStageResults({
    authored: record.authored,
    evidence: judge
      ? { ...record.evidence, judgeEvidence: judge }
      : record.evidence,
    iteration: record.iteration,
  });
}

describe("parity corpus manifest", () => {
  it("lists every file in the directory and nothing else", () => {
    const onDisk = readdirSync(CORPUS)
      .filter((name) => name !== "MANIFEST.json")
      .sort();
    expect(manifest.files.map((file) => file.path)).toEqual(onDisk);
    expect(manifest.iterations).toBe(manifest.files.length);
  });

  it("every per-file sha256 matches its bytes", () => {
    for (const file of manifest.files) {
      const raw = readRaw(file.path);
      expect(sha256(raw), file.path).toBe(file.sha256);
      expect(Buffer.byteLength(raw), file.path).toBe(file.bytes);
    }
  });

  it("the corpus digest covers the file list", () => {
    const digest = sha256(
      manifest.files.map((file) => `${file.path}:${file.sha256}`).join("\n")
    );
    expect(digest).toBe(manifest.corpusDigest);
  });

  it("stays inside the declared bounds", () => {
    expect(manifest.iterations).toBeLessThanOrEqual(
      manifest.bounds.maxIterations
    );
    expect(manifest.bytes).toBeLessThanOrEqual(manifest.bounds.maxBytes);
    expect(manifest.bytes).toBe(
      manifest.files.reduce((sum, file) => sum + file.bytes, 0)
    );
  });

  it("leaves the reviewer fields EMPTY for the operator", () => {
    // A pre-filled sign-off is a forged sign-off. These are the operator's.
    expect(Object.values(manifest.review).every((v) => v === "")).toBe(true);
  });

  it("carries only allowlisted keys — an ALLOWLIST, not a blocklist", () => {
    // A blocklist of scary substrings passes the moment someone names a field
    // something new. Every key that may appear is enumerated instead, so a
    // record that starts carrying transcript text fails this test by default.
    const allowed = new Set([
      // record envelope
      "id",
      "note",
      "origin",
      "authored",
      "evidence",
      "iteration",
      "recorded",
      // authored case
      "mode",
      "isNegativeTest",
      "expectsToolCall",
      "expectsWidgetRender",
      "assertionCount",
      // evidence
      "setupSignals",
      "connection",
      "discovery",
      "outcome",
      "attribution",
      "egressVerified",
      "spanIds",
      "toolSignals",
      "toolsTotalBefore",
      "toolsExposed",
      "spans",
      "category",
      "status",
      "toolName",
      "promptIndex",
      "mcpErrorCode",
      "traceAbsent",
      "traceLacksSpanChannel",
      "prompts",
      "expectedToolCalls",
      "missing",
      "unexpected",
      "argumentMismatches",
      "passed",
      "predicateResults",
      "reason",
      "toolErrors",
      "kind",
      "renderObservations",
      "evaluatorErrored",
      // iteration + recorded
      "error",
      "legacyPassed",
      "stageResults",
      "stage",
      "state",
      "evidence",
      "predicateReasons",
      "promptIndexes",
      "firstFailedStage",
      "failureCategory",
      "stageAnalyzerVersion",
      // the one structured tool-name field inside an argument mismatch
      "path",
    ]);
    for (const file of manifest.files) {
      const raw = readRaw(file.path);
      const keys = new Set<string>();
      JSON.parse(raw, function collect(this: unknown, key: string, value) {
        if (key && !/^\d+$/.test(key)) keys.add(key);
        return value;
      });
      for (const key of keys) {
        expect(allowed.has(key), `${file.path} carries key "${key}"`).toBe(true);
      }
      // A URL anywhere would be a server identity that slipped the allowlist.
      expect(raw.toLowerCase()).not.toContain("http");
    }
  });

  it("declares the analyzer version it was recorded under", () => {
    expect(manifest.stageAnalyzerVersion).toBe(STAGE_ANALYZER_VERSION);
    expect(manifest.origin).toBe("synthetic");
  });
});

describe("historical parity: recorded rows are reproduced exactly", () => {
  it("has a corpus", () => {
    expect(records.length).toBeGreaterThan(0);
  });

  for (const record of records) {
    it(`${record.id} — ${record.note}`, () => {
      const derivation: StageDerivation = derive(record);
      expect(derivation.stageResults).toEqual(record.recorded.stageResults);
      expect(derivation.firstFailedStage).toEqual(
        record.recorded.firstFailedStage
      );
      expect(derivation.failureCategory).toEqual(
        record.recorded.failureCategory
      );
      expect(derivation.stageAnalyzerVersion).toBe(
        record.recorded.stageAnalyzerVersion
      );
    });
  }
});

describe("historical parity: judge evidence only fills silence", () => {
  /** The rows a judge is allowed to change: nothing was measured there. */
  const fillable = new Set(["noEvidenceCaptured"]);

  for (const record of records) {
    it(`${record.id} — a judge PASS never overturns deterministic evidence`, () => {
      const before = derive(record);
      const after = derive(record, { status: "scored", verdict: "pass" });
      const rowBefore = userValue(before.stageResults);
      const rowAfter = userValue(after.stageResults);

      if (fillable.has(String(rowBefore.reason))) {
        expect(rowAfter).toMatchObject({
          state: "passed",
          reason: "judgeObserved",
        });
      } else {
        expect(rowAfter).toEqual(rowBefore);
        expect(after.stageResults).toEqual(before.stageResults);
        expect(after.firstFailedStage).toEqual(before.firstFailedStage);
        expect(after.failureCategory).toEqual(before.failureCategory);
      }
    });
  }

  it("a judge FAIL only ever reaches an unmeasured row", () => {
    for (const record of records) {
      const before = userValue(derive(record).stageResults);
      const after = userValue(
        derive(record, { status: "scored", verdict: "fail" }).stageResults
      );
      if (fillable.has(String(before.reason))) {
        expect(after, record.id).toMatchObject({
          state: "failed",
          reason: "judgeFailed",
        });
      } else {
        expect(after, record.id).toEqual(before);
      }
    }
  });

  it("a pending judge is honest about which kind of pending it is", () => {
    const fillableRecords = records.filter((record) =>
      fillable.has(String(userValue(derive(record).stageResults).reason))
    );
    expect(fillableRecords.length).toBeGreaterThan(0);
    for (const record of fillableRecords) {
      expect(
        userValue(
          derive(record, { status: "pending", pendingKind: "scheduled" })
            .stageResults
        )
      ).toMatchObject({ state: "notMeasured", reason: "judgePending" });
      expect(
        userValue(
          derive(record, { status: "pending", pendingKind: "not_requested" })
            .stageResults
        )
      ).toMatchObject({ state: "notMeasured", reason: "judgeNotRequested" });
    }
  });

  it("the recorded legacy verdict is never a function of the derivation", () => {
    // The corpus carries it; nothing here recomputes it. This asserts the
    // corpus itself still describes both outcomes, so the parity above is not
    // vacuously over passing runs only.
    const verdicts = new Set(records.map((r) => r.recorded.legacyPassed));
    expect(verdicts).toEqual(new Set([true, false]));
  });
});
