/**
 * The backend/SDK wire boundary, checked against a value the BACKEND produced.
 *
 * `wire-parity-envelope.json` is written to
 * `tests/fixtures/eval-findings-wire/` by
 * `tests/convex/evalFindingsWireParity.test.ts` in the mcpjam-backend
 * checkout, from the real envelope query after a real build and a real
 * enrichment attach. This side commits a byte-identical copy and:
 *
 *   1. VALIDATES it against the SDK's `InsightsEnvelope` at runtime, so a
 *      field the backend sends that the SDK does not declare fails here
 *      rather than being silently dropped in a transport projection;
 *   2. runs the shipped selector and helpers over it, so a consumer reading
 *      through them gets what the producer meant.
 *
 * The check has to be a RUNTIME one. `client/tsconfig.typecheck.json`
 * excludes `src/**\/__tests__/**`, so nothing in this file is ever compiled
 * by `npm run typecheck:client`; a `const envelope: InsightsEnvelope = ... as
 * InsightsEnvelope` here would be an unchecked cast in a file no compiler
 * reads — a guarantee in the comment and nothing behind it. `npm test` runs
 * this, so what `validateEnvelope` asserts is what actually holds.
 *
 * Matching TypeScript names would prove nothing. The fixture is the proof.
 */
import { USER_VALUE_STAGES, STAGE_REASONS } from "@mcpjam/sdk/contract";
import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isServerReady,
  provenanceFor,
  selectCurrentFindings,
  sortFindingsForDisplay,
  unifiedFindingsOf,
  type InsightsEnvelope,
} from "@/lib/insights-envelope-api";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "wire-parity-envelope.json",
);

/**
 * Every top-level key `PlatformInsightsEnvelope` declares.
 *
 * Pinned by hand because that is the point: a backend that starts sending a
 * key the SDK never declared is a field the client will silently drop, and
 * the only way to notice is to be told. Adding a key here is a deliberate
 * act that should come with the SDK type change in the same commit.
 */
const DECLARED_ENVELOPE_KEYS = new Set([
  // Legacy contract, unchanged by this experiment.
  "schemaVersion",
  "scope",
  "status",
  "reasonCode",
  "retryable",
  "error",
  "generatedAt",
  "updatedAt",
  "summary",
  "coverage",
  "findings",
  "runHealth",
  "truncation",
  // The four the experiment adds.
  "currentFindings",
  "observationState",
  "observationCoverage",
  "unifiedFindings",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function must(condition: boolean, what: string): void {
  if (!condition) {
    throw new Error(`the backend's envelope broke the contract: ${what}`);
  }
}

/**
 * Narrow the fixture to `InsightsEnvelope` by CHECKING it, not by asserting.
 *
 * Scoped to what the client actually dereferences — including the nested
 * coverage counts the panel reads without guarding, which is where a
 * version skew would otherwise surface as a TypeError mid-render.
 */
function validateEnvelope(raw: unknown): InsightsEnvelope {
  must(isRecord(raw), "the top level is not an object");
  const value = raw as Record<string, unknown>;

  for (const key of Object.keys(value)) {
    must(
      DECLARED_ENVELOPE_KEYS.has(key),
      `"${key}" is not declared by the SDK's InsightsEnvelope`,
    );
  }

  must(
    typeof value.schemaVersion === "number",
    "schemaVersion is not a number",
  );
  must(isRecord(value.scope), "scope is not an object");
  must(typeof value.status === "string", "status is not a string");
  must(Array.isArray(value.findings), "findings is not an array");
  must(isRecord(value.coverage), "coverage is not an object");
  must(
    (value.coverage as Record<string, unknown>).unit === "iterations",
    'coverage.unit is not "iterations"',
  );

  if (value.currentFindings !== undefined) {
    must(
      Array.isArray(value.currentFindings),
      "currentFindings is not an array",
    );
    for (const finding of value.currentFindings as unknown[]) {
      must(isRecord(finding), "currentFindings holds a non-object");
      const row = finding as Record<string, unknown>;
      for (const field of ["id", "observed", "recommendation", "category"]) {
        must(
          typeof row[field] === "string",
          `currentFindings[].${field} is not a string`,
        );
      }
    }
  }

  if (value.observationState !== undefined) {
    must(
      ["ready", "partial", "unavailable"].includes(
        value.observationState as string,
      ),
      `observationState "${String(value.observationState)}" is not a declared state`,
    );
  }

  if (value.observationCoverage !== undefined) {
    const coverage = value.observationCoverage;
    must(isRecord(coverage), "observationCoverage is not an object");
    const row = coverage as Record<string, unknown>;
    for (const field of ["analyzed", "total", "gradedCount"]) {
      must(
        typeof row[field] === "number",
        `observationCoverage.${field} is not a number`,
      );
    }
    // The panel calls Object.entries on this without guarding.
    must(
      isRecord(row.exclusions),
      "observationCoverage.exclusions is not an object",
    );
    for (const [reason, count] of Object.entries(
      row.exclusions as Record<string, unknown>,
    )) {
      must(
        typeof count === "number",
        `observationCoverage.exclusions.${reason} is not a number`,
      );
    }
  }

  if (value.unifiedFindings !== undefined) {
    const experiment = value.unifiedFindings;
    must(isRecord(experiment), "unifiedFindings is not an object");
    const row = experiment as Record<string, unknown>;
    must(
      row.capability === "unified_findings_v1",
      "unifiedFindings.capability is not the declared capability",
    );
    for (const field of ["canBuild", "canEnrich", "writesEnabled"]) {
      must(
        typeof row[field] === "boolean",
        `unifiedFindings.${field} is not a boolean`,
      );
    }
    if (row.analysis !== undefined) {
      must(isRecord(row.analysis), "analysis is not an object");
      const analysis = row.analysis as Record<string, unknown>;
      must(
        ["reading", "grouping", "checking", "done", "failed"].includes(
          String(analysis.phase),
        ),
        "unknown analysis phase",
      );
      must(
        isRecord(analysis.progress) && analysis.progress.unit === "iterations",
        "analysis progress has no unit",
      );
    }
    if (row.snapshot !== null && row.snapshot !== undefined) {
      must(isRecord(row.snapshot), "unifiedFindings.snapshot is not an object");
      const snapshot = row.snapshot as Record<string, unknown>;
      must(
        typeof snapshot.minerVersion === "number",
        "snapshot.minerVersion is not a number",
      );
      must(
        typeof snapshot.sourceRevision === "string",
        "snapshot.sourceRevision is not a string",
      );
      must(
        Array.isArray(snapshot.deterministicFindings),
        "snapshot.deterministicFindings is not an array",
      );
      must(
        Array.isArray(snapshot.provenance),
        "snapshot.provenance is not an array",
      );
      for (const entry of snapshot.provenance as unknown[]) {
        must(isRecord(entry), "snapshot.provenance holds a non-object");
        const provenance = entry as Record<string, unknown>;
        if (provenance.stage !== undefined)
          must(
            (USER_VALUE_STAGES as readonly string[]).includes(
              String(provenance.stage),
            ),
            "unknown provenance stage",
          );
        if (provenance.reason !== undefined)
          must(
            (STAGE_REASONS as readonly string[]).includes(
              String(provenance.reason),
            ),
            "unknown provenance reason",
          );
        const judgeCoverage = (entry as Record<string, unknown>).judgeCoverage;
        if (judgeCoverage === undefined || judgeCoverage === null) continue;
        must(
          isRecord(judgeCoverage),
          "provenance[].judgeCoverage is not an object",
        );
        // `judgeCoverageLine` reads these counts.
        must(
          isRecord((judgeCoverage as Record<string, unknown>).nonGraded),
          "provenance[].judgeCoverage.nonGraded is missing",
        );
      }
    }
  }

  return value as unknown as InsightsEnvelope;
}

const envelope: InsightsEnvelope = validateEnvelope(
  JSON.parse(readFileSync(FIXTURE, "utf8")),
);

describe("the eval envelope as the backend actually sends it", () => {
  test("carries the legacy contract unchanged", () => {
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.scope.kind).toBe("eval_run");
    expect(envelope.status).toBe("completed");
    expect(Array.isArray(envelope.findings)).toBe(true);
    expect(envelope.coverage.unit).toBe("iterations");
  });

  test("carries the additive observation view beside it", () => {
    expect(envelope.currentFindings).toBeDefined();
    expect(envelope.observationState).toBe("ready");
    expect(envelope.observationCoverage?.analyzed).toBe(8);
    expect(envelope.observationCoverage?.total).toBe(8);
  });

  test("the selector prefers the observation view without merging", () => {
    const selected = selectCurrentFindings(envelope);
    expect(selected).toBe(envelope.currentFindings);
    expect(selected).not.toBe(envelope.findings);
  });

  test("an explicit empty observation view never falls back", () => {
    const empty: InsightsEnvelope = {
      ...envelope,
      currentFindings: [],
      findings: envelope.findings,
    };
    expect(selectCurrentFindings(empty)).toEqual([]);
  });

  test("an older backend's envelope falls back to the legacy array", () => {
    const { currentFindings: _dropped, ...legacy } = envelope;
    void _dropped;
    expect(selectCurrentFindings(legacy as InsightsEnvelope)).toBe(
      envelope.findings,
    );
    expect(unifiedFindingsOf(legacy as InsightsEnvelope)).not.toBeNull();
  });

  test("the experiment payload survives the wire intact", () => {
    const experiment = unifiedFindingsOf(envelope)!;
    expect(experiment.capability).toBe("unified_findings_v1");
    expect(experiment.snapshot).not.toBeNull();
    expect(experiment.snapshot!.deterministicFindings.length).toBeGreaterThan(
      0,
    );
    expect(experiment.snapshot!.enrichment?.status).toBe("ready");
    expect(experiment.snapshot!.enrichment?.rejectedCount).toBe(1);
    expect(experiment.snapshot!.baseline?.source).toBe("serverQuality");
  });

  test("the deterministic view is still reachable after enrichment landed", () => {
    const experiment = unifiedFindingsOf(envelope)!;
    const deterministic = experiment.snapshot!.deterministicFindings[0]!;
    const current = envelope.currentFindings![0]!;
    expect(deterministic.id).toBe(current.id);
    // Same observation, different prose. That is the comparison.
    expect(deterministic.observed).toBe(current.observed);
    expect(deterministic.recommendation).not.toBe(current.recommendation);
  });

  test("per-field provenance survives the wire", () => {
    const experiment = unifiedFindingsOf(envelope);
    const finding = envelope.currentFindings![0]!;
    const provenance = provenanceFor(experiment, finding.id)!;
    expect(provenance.basis).toBe("measured");
    expect(provenance.mechanismBasis).toBe("complete");
    expect(provenance.proseOrigin?.recommendation).toBe("ai");
  });

  test("nothing in it claims an unearned server fix", () => {
    for (const finding of selectCurrentFindings(envelope)) {
      if (isServerReady(finding)) {
        // If a fixture ever DOES promote one, it must carry a resolved target.
        expect(finding.target).toBeDefined();
      }
    }
    expect(sortFindingsForDisplay(selectCurrentFindings(envelope)).length).toBe(
      envelope.currentFindings!.length,
    );
  });

  test("no credential-looking value rides on the wire", () => {
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toMatch(/sk-[a-z]+-[A-Za-z0-9]{8,}/);
    expect(serialized).not.toContain("Bearer ");
  });
});

test("trace-report golden fixture has code-owned counts and AI-owned wording", () => {
  const golden = validateEnvelope(
    JSON.parse(
      readFileSync(
        join(dirname(FIXTURE), "trace-report-envelope.json"),
        "utf8",
      ),
    ),
  );
  const finding = golden.currentFindings?.find(
    (row) => row.observed === "6 of 40 trials failed to save the server.",
  );
  expect(finding?.affected).toMatchObject({
    count: 6,
    total: 40,
    unit: "iterations",
  });
  expect(golden.unifiedFindings?.analysis?.phase).toBe("done");
  const report = JSON.parse(
    readFileSync(join(dirname(FIXTURE), "trace-report-iteration.json"), "utf8"),
  );
  expect(report.schemaVersion).toBe(1);
  expect(report.status).toBe("ready");
  for (const note of report.stageNotes ?? []) {
    expect(USER_VALUE_STAGES).toContain(note.stage);
    expect(note.citations.length).toBeGreaterThan(0);
  }
  for (const row of report.rows)
    expect(row.joinKey).toMatch(
      /^(predicate:|toolCalls:match$|judge:goalCompletion$)/,
    );
});
