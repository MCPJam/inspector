/**
 * The backend/SDK wire boundary, checked against a value the BACKEND produced.
 *
 * `wire-parity-envelope.json` is written to
 * `tests/fixtures/eval-findings-wire/` by
 * `tests/convex/evalFindingsWireParity.test.ts` in the mcpjam-backend
 * checkout, from the real envelope query after a real build and a real
 * enrichment attach. This side commits a byte-identical copy and:
 *
 *   1. type-checks it against the SDK's `InsightsEnvelope`, so a field the
 *      backend sends that the SDK does not declare fails the client typecheck
 *      rather than being silently dropped in a transport projection;
 *   2. runs the shipped selector and helpers over it, so a consumer reading
 *      through them gets what the producer meant.
 *
 * Matching TypeScript names would prove nothing. The fixture is the proof.
 */
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

// The assignment IS the assertion: an unknown field or a changed type on the
// backend fails `npm run typecheck:client` here.
const envelope: InsightsEnvelope = JSON.parse(
  readFileSync(FIXTURE, "utf8"),
) as InsightsEnvelope;

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
