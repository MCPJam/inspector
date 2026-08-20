import { describe, expect, it } from "vitest";

import {
  DIRECTORY_EVIDENCE_PROVENANCE,
  decideLaneStatus,
} from "../../src/directory-readiness/types.js";
import {
  DIRECTORY_OBSERVATION_LIMITS,
  NOT_REQUESTED_OBSERVATIONS,
  mapObservationsToFindings,
  observationFailure,
  parseDirectoryObservationEnvelope,
  type DirectoryObservationCatalog,
  type DirectoryObservationSchema,
} from "../../src/directory-readiness/observations.js";

type Lane = "experience-insights" | "directory-policy";
type Id = "demo.copy" | "demo.overlap";

const SCHEMA: DirectoryObservationSchema<"experience", Id> = {
  readinessKind: "demo-readiness",
  observationKinds: ["experience"],
  knownIds: ["demo.copy", "demo.overlap"],
  schemaVersion: "1",
};

const CATALOG: DirectoryObservationCatalog<Lane, { page: string }, Id> = {
  experienceLane: "experience-insights",
  engineVersion: "7",
  mappings: [
    {
      id: "demo.copy",
      title: "Copy may be placeholder",
      lane: "experience-insights",
      class: "manual-review",
      source: { page: "guidelines" },
    },
    {
      id: "demo.overlap",
      title: "Tools may overlap",
      lane: "experience-insights",
      class: "heuristic",
      source: { page: "tools" },
    },
  ],
};

const STAMP = { evaluatedAt: "2026-08-20T00:00:00.000Z" };

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    readinessKind: "demo-readiness",
    observationKind: "experience",
    observationSchemaVersion: "1",
    promptVersion: "p1",
    modelId: "anthropic/claude-sonnet-4",
    observedAt: "2026-08-20T00:00:00.000Z",
    observations: [
      {
        id: "demo.copy",
        summary: "Two listing fields still read like template text.",
        confidence: "medium",
        evidenceRefs: ["listing.description"],
      },
    ],
    ...overrides,
  };
}

describe("observation envelope validation", () => {
  it("accepts a well-formed envelope and normalizes it", () => {
    const parsed = parseDirectoryObservationEnvelope(envelope(), SCHEMA);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope.observations).toHaveLength(1);
    expect(parsed.envelope.observations[0]!.id).toBe("demo.copy");
    expect(parsed.envelope.modelId).toBe("anthropic/claude-sonnet-4");
  });

  it("refuses an id outside the published catalogue", () => {
    // The whole security boundary: a model that could name an id could name a
    // requirement, and this is where that is refused.
    const parsed = parseDirectoryObservationEnvelope(
      envelope({
        observations: [
          {
            id: "openai.tools.annotations",
            summary: "every tool is missing hints",
            confidence: "high",
            evidenceRefs: [],
          },
        ],
      }),
      SCHEMA,
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("schema_invalid");
    expect(parsed.detail).toContain("not a published observation id");
  });

  it("refuses another publisher's envelope before looking at ids", () => {
    const parsed = parseDirectoryObservationEnvelope(
      envelope({ readinessKind: "other-readiness" }),
      SCHEMA,
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.detail).toContain("readinessKind");
  });

  it("refuses a schema version this build does not understand", () => {
    const parsed = parseDirectoryObservationEnvelope(
      envelope({ observationSchemaVersion: "2" }),
      SCHEMA,
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.detail).toContain("observationSchemaVersion");
  });

  it.each([
    ["not an object", 42],
    ["a null", null],
    ["an array", []],
  ])("refuses %s", (_label, value) => {
    expect(parseDirectoryObservationEnvelope(value, SCHEMA).ok).toBe(false);
  });

  it("refuses an unbounded observation list rather than truncating it", () => {
    // Ids ALTERNATE so only the cap can refuse this. A list of identical ids
    // would also be full of duplicates, and the assertion would then depend on
    // the parser checking length before it walks the entries.
    const many = Array.from(
      { length: DIRECTORY_OBSERVATION_LIMITS.maxObservations + 1 },
      (_, index) => ({
        id: index % 2 === 0 ? "demo.copy" : "demo.overlap",
        summary: "x",
        confidence: "low",
        evidenceRefs: [],
      }),
    );
    const parsed = parseDirectoryObservationEnvelope(
      envelope({ observations: many }),
      SCHEMA,
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.detail).toContain("cap");
  });

  it("refuses a summary past the character cap", () => {
    const parsed = parseDirectoryObservationEnvelope(
      envelope({
        observations: [
          {
            id: "demo.copy",
            summary: "x".repeat(
              DIRECTORY_OBSERVATION_LIMITS.maxSummaryChars + 1,
            ),
            confidence: "low",
            evidenceRefs: [],
          },
        ],
      }),
      SCHEMA,
    );
    expect(parsed.ok).toBe(false);
  });

  it("refuses a repeated id, so one problem cannot render twice", () => {
    const parsed = parseDirectoryObservationEnvelope(
      envelope({
        observations: [
          {
            id: "demo.copy",
            summary: "a",
            confidence: "low",
            evidenceRefs: [],
          },
          {
            id: "demo.copy",
            summary: "b",
            confidence: "low",
            evidenceRefs: [],
          },
        ],
      }),
      SCHEMA,
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.detail).toContain("repeated");
  });

  it("refuses a confidence outside the three buckets", () => {
    const parsed = parseDirectoryObservationEnvelope(
      envelope({
        observations: [
          {
            id: "demo.copy",
            summary: "a",
            confidence: 0.92,
            evidenceRefs: [],
          },
        ],
      }),
      SCHEMA,
    );
    expect(parsed.ok).toBe(false);
  });

  it("refuses an observationKind the schema does not publish", () => {
    const parsed = parseDirectoryObservationEnvelope(
      envelope({ observationKind: "intrusive" }),
      SCHEMA,
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.detail).toContain("observationKind");
  });

  it.each([
    ["absent", undefined],
    ["not a timestamp", "yesterday"],
    ["not a string", 1_700_000_000],
  ])("refuses an observedAt that is %s", (_label, observedAt) => {
    // A broker emitting a malformed timestamp is ordinary, and the refusal is
    // what keeps an unstamped envelope out of a graded result: without it,
    // nothing later can say WHEN a model said this.
    const parsed = parseDirectoryObservationEnvelope(
      envelope({ observedAt }),
      SCHEMA,
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.detail).toContain("observedAt");
  });

  it.each([
    ["promptVersion", DIRECTORY_OBSERVATION_LIMITS.maxVersionChars],
    ["modelId", DIRECTORY_OBSERVATION_LIMITS.maxModelIdChars],
  ])("refuses a %s past its cap", (field, cap) => {
    const parsed = parseDirectoryObservationEnvelope(
      envelope({ [field]: "x".repeat(cap + 1) }),
      SCHEMA,
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.detail).toContain(field);
  });

  it.each([
    ["not an array", "listing.description"],
    [
      "past the entry cap",
      Array.from(
        { length: DIRECTORY_OBSERVATION_LIMITS.maxEvidenceRefs + 1 },
        () => "ref",
      ),
    ],
    [
      "carrying an oversized entry",
      ["x".repeat(DIRECTORY_OBSERVATION_LIMITS.maxEvidenceRefChars + 1)],
    ],
  ])("refuses evidenceRefs %s", (_label, evidenceRefs) => {
    const parsed = parseDirectoryObservationEnvelope(
      envelope({
        observations: [
          {
            id: "demo.copy",
            summary: "a",
            confidence: "low",
            evidenceRefs,
          },
        ],
      }),
      SCHEMA,
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.detail).toContain("evidenceRefs");
  });

  it("accepts an envelope that omits evidenceRefs entirely", () => {
    // Absent is not the same as malformed: a model with nothing to cite is a
    // legitimate answer, and refusing it would lose the observation over a
    // field that carries no verdict.
    const parsed = parseDirectoryObservationEnvelope(
      envelope({
        observations: [
          { id: "demo.copy", summary: "a", confidence: "low" },
        ],
      }),
      SCHEMA,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.envelope.observations[0]!.evidenceRefs).toEqual([]);
  });

  it("survives a JSON round trip unchanged", () => {
    const parsed = parseDirectoryObservationEnvelope(envelope(), SCHEMA);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const round = JSON.parse(JSON.stringify(parsed.envelope));
    expect(round).toEqual(parsed.envelope);
  });
});

describe("observation → finding mapping", () => {
  it("stamps every mapped finding with llm provenance", () => {
    const parsed = parseDirectoryObservationEnvelope(envelope(), SCHEMA);
    if (!parsed.ok) throw new Error("fixture should parse");
    const findings = mapObservationsToFindings(parsed.envelope, CATALOG, STAMP);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.provenance).toBe("llm");
    expect(DIRECTORY_EVIDENCE_PROVENANCE).toContain("llm");
    expect(findings[0]!.intrusiveness).toBe("passive");
    expect(findings[0]!.engineVersion).toBe("7");
  });

  it("carries the model, prompt and schema version onto the finding", () => {
    const parsed = parseDirectoryObservationEnvelope(envelope(), SCHEMA);
    if (!parsed.ok) throw new Error("fixture should parse");
    const [finding] = mapObservationsToFindings(
      parsed.envelope,
      CATALOG,
      STAMP,
    );
    expect(finding!.details).toMatchObject({
      modelId: "anthropic/claude-sonnet-4",
      promptVersion: "p1",
      observationSchemaVersion: "1",
      confidence: "medium",
    });
  });

  it("never produces a dispositive finding, so a lane cannot be decided by it", () => {
    const parsed = parseDirectoryObservationEnvelope(
      envelope({
        observations: [
          {
            id: "demo.copy",
            summary: "a",
            confidence: "high",
            evidenceRefs: [],
          },
          {
            id: "demo.overlap",
            summary: "b",
            confidence: "high",
            evidenceRefs: [],
          },
        ],
      }),
      SCHEMA,
    );
    if (!parsed.ok) throw new Error("fixture should parse");
    const findings = mapObservationsToFindings(parsed.envelope, CATALOG, STAMP);
    for (const finding of findings) {
      expect(["heuristic", "manual-review"]).toContain(finding.class);
      expect(finding.status).toBe("informational");
    }
    // The load-bearing assertion: a lane holding ONLY AI findings is
    // `incomplete` — nothing dispositive was graded — and emphatically not
    // `not-ready`.
    expect(decideLaneStatus(findings)).toBe("incomplete");
  });

  it("drops a catalogue entry that tries to escape the experience lane", () => {
    // A catalogue is data, and the one-character edit that moves an entry into
    // a dispositive lane is exactly what the runtime guard is for.
    const rogue: DirectoryObservationCatalog<Lane, { page: string }, Id> = {
      ...CATALOG,
      mappings: [
        {
          id: "demo.copy",
          title: "escaped",
          lane: "directory-policy",
          class: "manual-review",
          source: { page: "x" },
        },
      ],
    };
    const parsed = parseDirectoryObservationEnvelope(envelope(), SCHEMA);
    if (!parsed.ok) throw new Error("fixture should parse");
    expect(mapObservationsToFindings(parsed.envelope, rogue, STAMP)).toEqual(
      [],
    );
  });

  it("drops a catalogue entry that claims a dispositive class", () => {
    const rogue = {
      ...CATALOG,
      mappings: [
        {
          id: "demo.copy" as Id,
          title: "escaped",
          lane: "experience-insights" as Lane,
          // Cast because the type already forbids this — the point of the test
          // is that a catalogue assembled from untyped data cannot get past the
          // runtime guard either.
          class: "required" as never,
          source: { page: "x" },
        },
      ],
    };
    const parsed = parseDirectoryObservationEnvelope(envelope(), SCHEMA);
    if (!parsed.ok) throw new Error("fixture should parse");
    expect(mapObservationsToFindings(parsed.envelope, rogue, STAMP)).toEqual(
      [],
    );
  });

  it("maps nothing when there is no envelope", () => {
    expect(mapObservationsToFindings(undefined, CATALOG, STAMP)).toEqual([]);
  });

  it("drops an id this build has no mapping for rather than throwing", () => {
    const narrowed = { ...CATALOG, mappings: [CATALOG.mappings[1]!] };
    const parsed = parseDirectoryObservationEnvelope(envelope(), SCHEMA);
    if (!parsed.ok) throw new Error("fixture should parse");
    expect(mapObservationsToFindings(parsed.envelope, narrowed, STAMP)).toEqual(
      [],
    );
  });
});

describe("observation state", () => {
  it("defaults to not-requested with a reason, never a bare status", () => {
    expect(NOT_REQUESTED_OBSERVATIONS.status).toBe("not-requested");
    expect(NOT_REQUESTED_OBSERVATIONS.reason).toBe("not_requested");
  });

  it("pairs billing-blocked with the reason three surfaces branch on", () => {
    const state = observationFailure("billing-blocked", "out of credits");
    expect(state.reason).toBe("billing_limit_reached");
  });

  it("keeps a schema failure distinct from a provider outage", () => {
    expect(observationFailure("invalid-output", "bad json").reason).toBe(
      "schema_invalid",
    );
    expect(observationFailure("provider-failed", "504").reason).toBe(
      "provider_error",
    );
  });
});
