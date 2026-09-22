/**
 * Parity + behaviour test for the versioned eval SUITE FILE contract.
 *
 * Same arrangement as `score-contract-parity.test.ts`: the fixture file is the
 * cross-repo ground truth, copied VERBATIM into mcpjam-backend so a hand-
 * mirrored Convex validator can be proven to agree without either side
 * importing the other's code.
 *
 * Beyond accept/reject, three properties are asserted BY REASON rather than by
 * "something failed", because each of them is the point of a specific design
 * decision and a row rejected for an unrelated typo would still pass a bare
 * `success === false` check:
 *
 *   1. A reserved value is rejected AS RESERVED (not accepted-and-ignored, and
 *      not reported as a generic enum miss).
 *   2. An unknown `schemaVersion` says the CLI/SDK needs upgrading, so nobody
 *      goes and edits a file that is correct.
 *   3. Parsing materializes NO defaults, which is what makes the canonical form
 *      round-trip byte-stable.
 */

import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/contract/canonical.js";
import { IMPORT_MAPPING_STATUSES } from "../src/contract/chain.js";
import { TEST_STEP_KINDS } from "../src/contract/steps.js";
import {
  EVAL_SUITE_SCHEMA_VERSION,
  EVAL_SUITE_SCHEMA_VERSION_2,
  EVAL_SUITE_SCHEMA_VERSIONS,
  evalSuiteFileCaseImportSchema,
  evalSuiteFileSchema,
} from "../src/contract/suite-file.js";
import {
  findFixture,
  suiteFileFixtures as data,
  suiteFilePayload as payload,
  type SuiteFileFixtureRow,
} from "./support/eval-suite-fixtures.js";

function rejectRow(labelPrefix: string): SuiteFileFixtureRow {
  return findFixture(data.reject, labelPrefix);
}

function messagesFor(labelPrefix: string): string[] {
  const parsed = evalSuiteFileSchema.safeParse(payload(rejectRow(labelPrefix)));
  expect(parsed.success, `expected "${labelPrefix}" to be rejected`).toBe(
    false
  );
  if (parsed.success) return [];
  return parsed.error.issues.map((issue) => issue.message);
}

describe("eval suite file fixtures — shape of the fixture itself", () => {
  it("has a README and all three cohorts", () => {
    expect(typeof data.__readme).toBe("string");
    expect(data.accept.length).toBeGreaterThan(0);
    expect(data.reject.length).toBeGreaterThan(0);
    expect(data.roundTrip.length).toBeGreaterThan(0);
  });

  it("dispatches every row to the suiteFile validator", () => {
    for (const row of [...data.accept, ...data.reject, ...data.roundTrip]) {
      expect(row.__kind, row.__label).toBe("suiteFile");
    }
  });

  it("exercises BOTH dialects in every cohort", () => {
    // A corpus that quietly dropped back to one dialect would leave the other
    // dialect's document and the union's second branch untested with nothing
    // failing. The unknown-version reject row is the one legitimate exception.
    const known = new Set<unknown>(EVAL_SUITE_SCHEMA_VERSIONS);
    for (const cohort of [data.accept, data.roundTrip]) {
      const versions = new Set(cohort.map((row) => row.schemaVersion));
      expect([...versions].sort()).toEqual([...EVAL_SUITE_SCHEMA_VERSIONS]);
    }
    const rejectVersions = data.reject
      .filter((row) => known.has(row.schemaVersion))
      .map((row) => row.schemaVersion);
    expect(rejectVersions).toContain(EVAL_SUITE_SCHEMA_VERSION);
    expect(rejectVersions).toContain(EVAL_SUITE_SCHEMA_VERSION_2);
  });

  it("annotates every reject row as structural or not", () => {
    // The flag drives the JSON Schema test. Missing it there would silently
    // skip a row rather than fail, so it is required HERE.
    for (const row of data.reject) {
      expect(typeof row.__structural, row.__label).toBe("boolean");
    }
  });

  it("covers every step kind in the accept cohort", () => {
    const kinds = new Set<string>();
    for (const row of data.accept) {
      for (const testCase of (
        row as unknown as { cases: Array<{ steps: Array<{ kind: string }> }> }
      ).cases) {
        for (const step of testCase.steps) kinds.add(step.kind);
      }
    }
    expect([...kinds].sort()).toEqual([...TEST_STEP_KINDS].sort());
  });

  it("covers every import mapping status in the accept cohort", () => {
    const statuses = new Set<string>();
    for (const row of data.accept) {
      for (const testCase of (
        row as unknown as {
          cases: Array<{ import?: { status: string } }>;
        }
      ).cases) {
        if (testCase.import) statuses.add(testCase.import.status);
      }
    }
    expect([...statuses].sort()).toEqual([...IMPORT_MAPPING_STATUSES].sort());
  });
});

describe("eval suite file — accept[]", () => {
  for (const row of data.accept) {
    it(`accepts: ${row.__label}`, () => {
      const parsed = evalSuiteFileSchema.safeParse(payload(row));
      if (!parsed.success) {
        throw new Error(
          `Expected accept, got reject for "${row.__label}":\n` +
            JSON.stringify(parsed.error.issues, null, 2)
        );
      }
      expect(parsed.success).toBe(true);
    });
  }
});

describe("eval suite file — reject[]", () => {
  for (const row of data.reject) {
    it(`rejects: ${row.__label}`, () => {
      const parsed = evalSuiteFileSchema.safeParse(payload(row));
      if (parsed.success) {
        throw new Error(`Expected reject, got accept for "${row.__label}"`);
      }
      expect(parsed.success).toBe(false);
    });
  }
});

describe("eval suite file — reserved values are rejected AS RESERVED", () => {
  const reserved: Array<[string, string]> = [
    ['reserved mode "serverContract"', "serverContract"],
    ['reserved reportingMode "restricted"', "restricted"],
    ['reserved reportingMode "summary"', "summary"],
    ['reserved captureLevel "metadataOnly"', "metadataOnly"],
    ['reserved captureLevel "none"', "none"],
  ];

  for (const [label, value] of reserved) {
    it(`names the reserved value and the v1 stance: ${value}`, () => {
      const messages = messagesFor(label);
      const named = messages.find((message) => message.includes(value));
      expect(named, `no message mentioned "${value}"`).toBeDefined();
      // "reserved" is the load-bearing word: it distinguishes "not built yet,
      // stop planning around it" from an ordinary typo.
      expect(named).toContain("is reserved and not accepted");
      expect(named).toContain(`schemaVersion ${EVAL_SUITE_SCHEMA_VERSION}`);
    });
  }

  it("says something different for a value that is merely wrong", () => {
    const parsed = evalSuiteFileSchema.safeParse({
      ...(payload(data.accept[0]) as Record<string, unknown>),
      mode: "agentWorkflows",
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const message = parsed.error.issues[0]?.message ?? "";
    expect(message).not.toContain("is reserved and not accepted");
    expect(message).toContain('must be "agentWorkflow"');
  });
});

describe("eval suite file — cross-field rules", () => {
  it("an unknown schemaVersion sends the reader to the CLI/SDK, not the file", () => {
    const messages = messagesFor('unknown schemaVersion "3"');
    const message = messages.find((entry) => entry.includes("schemaVersion"));
    expect(message).toContain("needs a newer CLI/SDK");
    expect(message).toContain("rather than editing the file");
    // And it names every dialect this build reads, so the reader can tell
    // "too new" from "misspelled" without opening the source.
    for (const version of EVAL_SUITE_SCHEMA_VERSIONS) {
      expect(message).toContain(`"${version}"`);
    }
  });

  it("rejects duplicate case ids at the offending path", () => {
    const parsed = evalSuiteFileSchema.safeParse(
      payload(rejectRow("duplicate case ids"))
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issue = parsed.error.issues.find((entry) =>
      entry.message.startsWith("duplicate case id")
    );
    expect(issue, "the duplicate-id issue is missing").toBeDefined();
    expect(issue!.path[0]).toBe("cases");
    expect(issue!.path[2]).toBe("id");
  });

  it("rejects duplicate step ids inside one case", () => {
    const messages = messagesFor("duplicate step ids within one case");
    expect(messages.some((m) => m.startsWith("duplicate step id"))).toBe(true);
  });

  it("refuses an import status with no provenance to audit it against", () => {
    const messages = messagesFor(
      "case carries an import block but the file has no provenance"
    );
    expect(
      messages.some((message) => message.includes("cannot be audited"))
    ).toBe(true);
  });

  it('names the exact-claim rule when an "exact" import has no note', () => {
    const messages = messagesFor('import.status "exact" with no note');
    const named = messages.find((message) => message.includes("import.note"));
    expect(named, "no message named import.note").toBeDefined();
    // The wording is the point: `exact` is a CONVERTER claim, and the message
    // has to say so or a reader takes the rejection for a formatting nit and
    // pastes in filler prose to clear it.
    expect(named).toContain("converter-asserted, not verified");
    expect(named).toContain('Record "approximated"');
  });

  it("bounds sourceCaseKey and note at the caps the platform enforces", () => {
    // The accept cohort holds the exactly-at-the-cap twins, so these two rows
    // prove the bound is inclusive rather than merely present.
    const key = messagesFor(
      "import.sourceCaseKey one character over the 512-character cap"
    );
    expect(key.some((message) => message.includes("512"))).toBe(true);
    const note = messagesFor(
      "import.note one character over the 2000-character cap"
    );
    expect(note.some((message) => message.includes("2000"))).toBe(true);
  });

  it("refuses a blank note or source key, rather than trimming one", () => {
    // `.min(1)` counts characters, so `"   "` passes it. On `exact` that is a
    // policy hole: the note is the rule that EARNS the claim, and a case
    // claiming exact while citing nothing runs with no approval at all.
    const note = messagesFor("import.note that is only whitespace");
    expect(note.some((message) => message.includes("must not be blank"))).toBe(
      true
    );
    const key = messagesFor("import.sourceCaseKey that is only whitespace");
    expect(key.some((message) => message.includes("must not be blank"))).toBe(
      true
    );
    // REJECTED, not trimmed: the platform's validator rejects a blank value
    // too, so trimming here would make a file load locally and fail at ingest.
    expect(
      evalSuiteFileCaseImportSchema.safeParse({
        status: "approximated",
        note: "  cited rule  ",
      }).data?.note
    ).toBe("  cited rule  ");
  });

  it("refuses an approval field smuggled into a case's import block", () => {
    // Approval is a per-run decision the server derives from the authenticated
    // launcher. A file that could carry one would file somebody else's approval
    // under a name they never used, and would outlive the run it was for.
    const messages = messagesFor("import block carries an approval field");
    expect(
      messages.some(
        (message) =>
          message.includes("approvedBy") || message.includes("Unrecognized")
      )
    ).toBe(true);
  });

  it("does NOT require a non-exact import to be disabled", () => {
    // Eligibility is runtime policy: an audited case can be enabled while still
    // recorded as `approximated`. Encoding it structurally would make the
    // outcome an audit exists to produce unrepresentable.
    const full = payload(
      data.accept.find((row) => row.__label.startsWith("full"))!
    ) as { cases: Array<{ import?: { status: string }; disabled?: boolean }> };
    const enabledApproximation = full.cases.find(
      (testCase) =>
        testCase.import?.status === "approximated" && !testCase.disabled
    );
    expect(enabledApproximation).toBeDefined();
  });
});

describe("eval suite file — dialect 2 spells the count and the rules canonically", () => {
  it("reads `iterations` and `assertions`, and nothing else for those fields", () => {
    const parsed = evalSuiteFileSchema.parse(
      payload(findFixture(data.accept, "dialect 2 — full"))
    );
    expect(parsed.schemaVersion).toBe(EVAL_SUITE_SCHEMA_VERSION_2);
    if (parsed.schemaVersion !== EVAL_SUITE_SCHEMA_VERSION_2) return;
    expect(typeof parsed.defaults.iterations).toBe("number");
    expect("repetitions" in parsed.defaults).toBe(false);
    const withOverride = parsed.cases.find(
      (entry) => entry.iterations !== undefined
    );
    expect(
      withOverride,
      "the full row carries a per-case override"
    ).toBeDefined();
    const withRules = parsed.cases.find((entry) => entry.assertions?.length);
    expect(withRules, "the full row carries assertions").toBeDefined();
    for (const entry of parsed.cases) {
      expect("checks" in entry).toBe(false);
      expect("repetitions" in entry).toBe(false);
    }
  });

  it("refuses the dialect-1 spellings as unknown keys, not as aliases", () => {
    // Structural, so the JSON Schema test proves the same thing over ajv.
    for (const label of [
      "dialect 2 with the dialect-1 count spelling",
      "dialect 2 with the dialect-1 rule spelling",
    ]) {
      const parsed = evalSuiteFileSchema.safeParse(payload(rejectRow(label)));
      expect(parsed.success, label).toBe(false);
      if (parsed.success) continue;
      expect(parsed.error.issues.map((issue) => issue.code)).toContain(
        "unrecognized_keys"
      );
    }
  });

  it("keeps dialect 1 frozen — it never learns the dialect-2 word", () => {
    const parsed = evalSuiteFileSchema.safeParse(
      payload(rejectRow("dialect 1 with the dialect-2 count spelling"))
    );
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues.map((issue) => issue.code)).toContain(
      "unrecognized_keys"
    );
  });
});

describe("eval suite file — round trip", () => {
  for (const row of data.roundTrip) {
    it(`round-trips through canonical JSON: ${row.__label}`, () => {
      const input = payload(row);
      const first = evalSuiteFileSchema.parse(input);
      const reparsed = evalSuiteFileSchema.parse(
        JSON.parse(canonicalJson(first))
      );
      expect(reparsed).toEqual(first);
      // And the parse added nothing the author did not write — the whole
      // reason there is no `.default()` in the schema.
      expect(first).toEqual(input);
    });
  }

  it("preserves step order (steps are ORDERED, not a set)", () => {
    const row = data.roundTrip.find((entry) =>
      entry.__label.startsWith("round trip — full")
    )!;
    const parsed = evalSuiteFileSchema.parse(payload(row));
    const ids = parsed.cases[0]!.steps.map((step) => step.id);
    const reparsed = evalSuiteFileSchema.parse(
      JSON.parse(canonicalJson(parsed))
    );
    expect(reparsed.cases[0]!.steps.map((step) => step.id)).toEqual(ids);
  });
});
