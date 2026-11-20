/**
 * Test helpers for catalog rules and the evaluator. A surface built here is
 * fully captured unless a test says otherwise, so a negative fixture has to
 * opt into incomplete coverage explicitly.
 */

import {
  COVERAGE_KEYS,
  type CoverageKey,
  type CoverageState,
  type DeclaredSurface,
  type ProbeSummary,
  type ServerProbeId,
} from "../types.js";

export function fullCoverage(
  overrides: Partial<Record<CoverageKey, CoverageState>> = {},
): Record<CoverageKey, CoverageState> {
  const coverage = Object.fromEntries(
    COVERAGE_KEYS.map((key) => [key, "complete" as CoverageState]),
  ) as Record<CoverageKey, CoverageState>;
  return { ...coverage, ...overrides };
}

export function makeSurface(
  overrides: Partial<DeclaredSurface> = {},
): DeclaredSurface {
  return {
    envelopeVersion: 3,
    protocolVersion: "2025-11-25",
    serverInfo: { name: "fixture", version: "1.0.0" },
    capabilities: {},
    tools: [],
    resources: [],
    resourceTemplates: [],
    prompts: [],
    skills: [],
    listHints: {},
    transport: "streamable-http",
    ...overrides,
    coverage: fullCoverage(overrides.coverage),
  };
}

export function makeProbe<P extends ServerProbeId>(
  probeId: P,
  values: ProbeSummary<P>["values"],
  overrides: Partial<Omit<ProbeSummary<P>, "probeId" | "values">> = {},
): ProbeSummary<P> {
  return {
    probeId,
    status: "ok",
    coverage: "complete",
    at: 1_700_000_000_000,
    values,
    ...overrides,
  };
}
