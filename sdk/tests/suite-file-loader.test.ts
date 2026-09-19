/**
 * The suite-file LOADER's behaviour — the concern the contract module says is
 * separate from itself (`src/contract/suite-file.ts:7-9`).
 *
 * The contract's own accept/reject parity is proven next door in
 * `eval-suite-file.test.ts`, over the same fixture rows. What is proven HERE is
 * everything that only exists because the loader exists:
 *
 *   1. One parse path reads YAML and JSON, and a multi-document stream is
 *      refused rather than silently read as its first document.
 *   2. The byte cap is a BYTE cap, tested on both sides of the boundary, and
 *      an oversize file is rejected rather than trimmed.
 *   3. Defaults are resolved in memory and are ABSENT from re-serialization —
 *      the mechanism that keeps an unchanged suite's diff empty.
 *   4. Identity survives a rename at the FILE level: retitling a case and
 *      writing the file back leaves its `id` untouched.
 *   5. Findings are deterministic — same bytes, byte-identical findings.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_SUITE_FILE_BYTES,
  SUITE_FILE_DEFAULT_COVERAGE,
  SUITE_FILE_VALIDITY_DEFAULTS,
  loadEvalSuiteFile,
  resolveEvalSuiteFile,
  serializeEvalSuiteFile,
  suiteFilePointer,
  type SuiteFileLoadSuccess,
} from "../src/suite-file-loader.js";
import {
  EVAL_SUITE_SCHEMA_VERSION_2,
  type EvalSuiteFile,
  type EvalSuiteFileV2,
} from "../src/contract/suite-file.js";
import {
  findFixture,
  suiteFileFixtures as data,
  suiteFilePayload as payload,
} from "./support/eval-suite-fixtures.js";

/** Every fixture row is JSON, and JSON is YAML — so it is already suite-file text. */
function asText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function loadOrThrow(text: string): SuiteFileLoadSuccess {
  const result = loadEvalSuiteFile(text);
  if (!result.ok) {
    throw new Error(
      `expected a valid suite file, got ${JSON.stringify(result.findings)}`
    );
  }
  return result;
}

const MINIMAL = payload(findFixture(data.accept, "minimal")) as EvalSuiteFile;
const MINIMAL_V2 = payload(
  findFixture(data.accept, "dialect 2 — minimal")
) as EvalSuiteFileV2;

describe("the parity corpus, through the loader", () => {
  it("accepts every accept row", () => {
    expect(data.accept).toHaveLength(8);
    for (const row of data.accept) {
      const result = loadEvalSuiteFile(asText(payload(row)));
      expect(result.ok, `${row.__label}: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it("rejects every reject row as a CONTRACT failure, not a parse failure", () => {
    expect(data.reject).toHaveLength(39);
    for (const row of data.reject) {
      const result = loadEvalSuiteFile(asText(payload(row)));
      expect(result.ok, row.__label).toBe(false);
      if (result.ok) continue;
      // The stage is what the CLI turns into an exit code: these rows all
      // PARSED, so reporting them as "malformed YAML" would send an author to
      // look for a syntax error that is not there.
      expect(result.stage, row.__label).toBe("contract");
      expect(result.findings.length, row.__label).toBeGreaterThan(0);
      for (const entry of result.findings) {
        expect(entry.code).toBe("SUITE_FILE_INVALID");
      }
    }
  });

  it("round-trips every roundTrip row through serialize → load", () => {
    expect(data.roundTrip).toHaveLength(3);
    for (const row of data.roundTrip) {
      const authored = payload(row) as EvalSuiteFile;
      const reloaded = loadOrThrow(serializeEvalSuiteFile(authored));
      expect(reloaded.authored, row.__label).toEqual(authored);
    }
  });
});

describe("one parser for YAML and JSON", () => {
  it("reads the same document either way", () => {
    const json = loadOrThrow(asText(MINIMAL));
    const yaml = loadOrThrow(serializeEvalSuiteFile(MINIMAL));
    expect(json.authored).toEqual(yaml.authored);
    expect(json.resolved).toEqual(yaml.resolved);
  });

  it("refuses a multi-document stream instead of reading the first document", () => {
    const stream = `${serializeEvalSuiteFile(
      MINIMAL
    )}---\n${serializeEvalSuiteFile(MINIMAL)}`;
    const result = loadEvalSuiteFile(stream);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("parse");
    expect(result.findings[0]?.code).toBe("SUITE_FILE_MULTIPLE_DOCUMENTS");
  });

  it("reports malformed YAML with a location, not just 'invalid'", () => {
    const result = loadEvalSuiteFile("suite:\n  id: [1, 2\n  name: broken\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("parse");
    const [first] = result.findings;
    expect(first?.code).toBe("SUITE_FILE_YAML_INVALID");
    expect(first?.location?.line).toBeGreaterThan(0);
    expect(first?.location?.column).toBeGreaterThan(0);
  });

  it("reports an empty document as 'nothing was validated'", () => {
    for (const text of ["", "   \n\n", "# just a comment\n"]) {
      const result = loadEvalSuiteFile(text);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.stage).toBe("parse");
      expect(result.findings[0]?.code).toBe("SUITE_FILE_EMPTY");
    }
  });
});

describe("the byte cap", () => {
  /**
   * Pad the minimal file's description up to an EXACT UTF-8 byte length.
   *
   * The padding is ASCII so one character is one byte, which is what makes an
   * exact-size input constructible at all — and the multi-byte case below is
   * what proves the loader is not counting characters.
   */
  function fileOfExactBytes(bytes: number): string {
    const base = { ...MINIMAL, suite: { ...MINIMAL.suite, description: "" } };
    const skeleton = asText(base);
    const padding = bytes - new TextEncoder().encode(skeleton).length;
    expect(padding).toBeGreaterThanOrEqual(0);
    return asText({
      ...base,
      suite: { ...base.suite, description: "x".repeat(padding) },
    });
  }

  it("accepts exactly 1,048,576 bytes", () => {
    expect(MAX_SUITE_FILE_BYTES).toBe(1_048_576);
    const text = fileOfExactBytes(MAX_SUITE_FILE_BYTES);
    expect(new TextEncoder().encode(text).length).toBe(MAX_SUITE_FILE_BYTES);
    expect(loadEvalSuiteFile(text).ok).toBe(true);
  });

  it("rejects 1,048,577 bytes, and truncates nothing", () => {
    const text = fileOfExactBytes(MAX_SUITE_FILE_BYTES + 1);
    expect(new TextEncoder().encode(text).length).toBe(
      MAX_SUITE_FILE_BYTES + 1
    );
    const result = loadEvalSuiteFile(text);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("input");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.code).toBe("SUITE_FILE_TOO_LARGE");
  });

  it("counts UTF-8 BYTES, not UTF-16 code units", () => {
    // Every "🙂" is four UTF-8 bytes and two code units, so a string whose
    // `.length` is comfortably under the cap is over it in bytes. A
    // `String.length` check would admit this file.
    const emoji = "🙂".repeat(300_000);
    const text = asText({
      ...MINIMAL,
      suite: { ...MINIMAL.suite, description: emoji },
    });
    expect(text.length).toBeLessThan(MAX_SUITE_FILE_BYTES);
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(
      MAX_SUITE_FILE_BYTES
    );
    expect(loadEvalSuiteFile(text).ok).toBe(false);
  });

  it("prefers a byte length the caller measured", () => {
    // A caller that read a file knows its real on-disk size; the loader must
    // believe it rather than re-deriving one from the decoded text.
    const result = loadEvalSuiteFile(asText(MINIMAL), {
      byteLength: MAX_SUITE_FILE_BYTES + 1,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings[0]?.code).toBe("SUITE_FILE_TOO_LARGE");
  });
});

describe("defaults are resolved in memory and never written back", () => {
  it("applies the documented validity defaults onto the resolved value", () => {
    const { authored, resolved } = loadOrThrow(asText(MINIMAL));
    expect(authored.defaults.validity).toEqual({});
    expect(resolved.defaults.validity).toEqual({
      coverage: SUITE_FILE_DEFAULT_COVERAGE,
      minCompletionRate: SUITE_FILE_VALIDITY_DEFAULTS.minCompletionRate,
      maxEvaluatorErrorRate: SUITE_FILE_VALIDITY_DEFAULTS.maxEvaluatorErrorRate,
    });
    // An omitted `minEligibleTrials` is not "no minimum": it selects the
    // coverage RULE — every configured trial attempted, at least one gradeable
    // — and the resolved value says so rather than leaving a reader to invent
    // `?? 0`.
    expect(resolved.defaults.validity.coverage).toEqual({
      kind: "allConfiguredTrialsAttempted",
      minGradeableTrials: 1,
    });
    expect(resolved.defaults.captureLevel).toBe("full");
  });

  it("an explicit minEligibleTrials REPLACES the default coverage rule", () => {
    const authored = {
      ...MINIMAL,
      defaults: { ...MINIMAL.defaults, validity: { minEligibleTrials: 3 } },
    } as EvalSuiteFile;
    const { resolved } = loadOrThrow(asText(authored));
    expect(resolved.defaults.validity.coverage).toEqual({
      kind: "minEligibleTrials",
      minEligibleTrials: 3,
    });
    // The other two remain independent checks, still at their own defaults.
    expect(resolved.defaults.validity.minCompletionRate).toBe(0.8);
    expect(resolved.defaults.validity.maxEvaluatorErrorRate).toBe(0.1);
  });

  it("resolves suite defaults onto every case", () => {
    const { resolved } = loadOrThrow(asText(MINIMAL));
    const [only] = resolved.cases;
    expect(only?.model).toBe(MINIMAL.defaults.model);
    expect(only?.iterations).toBe(MINIMAL.defaults.repetitions);
    expect(only?.passThreshold).toBe(MINIMAL.defaults.passThreshold);
    expect(only?.isNegativeTest).toBe(false);
    expect(only?.disabled).toBe(false);
    expect(resolved.enabledCases).toHaveLength(1);
  });

  it("keeps disabled cases in the file but out of `enabledCases`", () => {
    const authored = {
      ...MINIMAL,
      cases: [
        { ...MINIMAL.cases[0], disabled: true },
        { ...MINIMAL.cases[0], id: "c_second" },
      ],
    } as EvalSuiteFile;
    const { resolved } = loadOrThrow(asText(authored));
    expect(resolved.cases).toHaveLength(2);
    expect(resolved.enabledCases.map((entry) => entry.id)).toEqual([
      "c_second",
    ]);
  });

  it("writes back exactly what was authored — no resolved default appears", () => {
    for (const row of data.roundTrip) {
      const authored = payload(row) as EvalSuiteFile;
      const loaded = loadOrThrow(asText(authored));
      const text = serializeEvalSuiteFile(loaded.authored);

      // A LITERAL check on every defaultable key the row left out, not just a
      // deep-equal: a materialized default shows up as a KEY in the text, and
      // a caller comparing two resolved values would not notice.
      const omitted = [
        ...(authored.defaults.validity.minCompletionRate === undefined
          ? ["minCompletionRate"]
          : []),
        ...(authored.defaults.validity.maxEvaluatorErrorRate === undefined
          ? ["maxEvaluatorErrorRate"]
          : []),
        ...(authored.defaults.captureLevel === undefined
          ? ["captureLevel"]
          : []),
      ];
      for (const key of omitted) {
        expect(text, `${row.__label} materialized ${key}`).not.toContain(key);
      }

      expect(loadOrThrow(text).authored).toEqual(authored);
    }
  });

  it("leaves the minimal row with no validity keys at all", () => {
    // The row that omits every defaultable field, asserted on its own so the
    // loop above cannot pass vacuously if a fixture starts declaring them.
    const text = serializeEvalSuiteFile(loadOrThrow(asText(MINIMAL)).authored);
    expect(text).toContain("validity: {}");
    expect(text).not.toContain("minCompletionRate");
    expect(text).not.toContain("maxEvaluatorErrorRate");
    expect(text).not.toContain("captureLevel");
  });

  it("preserves authored execution config without inventing absent fields", () => {
    const configured = payload(
      findFixture(data.accept, "environment-only target")
    ) as EvalSuiteFile;
    const loaded = loadOrThrow(asText(configured));
    expect(loaded.resolved.defaults.systemPrompt).toBe(
      "Use the billing tools and keep the answer concise."
    );
    expect(loaded.resolved.defaults.temperature).toBe(0.2);

    const minimal = loadOrThrow(asText(MINIMAL));
    expect("systemPrompt" in minimal.resolved.defaults).toBe(false);
    expect("temperature" in minimal.resolved.defaults).toBe(false);
  });

  it("resolves without re-reading text", () => {
    const { authored, resolved } = loadOrThrow(asText(MINIMAL));
    expect(resolveEvalSuiteFile(authored)).toEqual(resolved);
  });
});

describe("identity survives a rename", () => {
  it("keeps the case id when only the title changes", () => {
    const before = loadOrThrow(asText(MINIMAL));
    const renamed: EvalSuiteFile = {
      ...before.authored,
      cases: before.authored.cases.map((entry) => ({
        ...entry,
        title: "Refunds",
      })),
    };
    const after = loadOrThrow(serializeEvalSuiteFile(renamed));

    expect(after.authored.cases[0]?.title).toBe("Refunds");
    expect(after.authored.cases[0]?.id).toBe(before.authored.cases[0]?.id);
    expect(after.resolved.cases[0]?.id).toBe(before.resolved.cases[0]?.id);
    // And the identity is the ONLY thing that stayed: the rename really did
    // happen, so this is not passing because nothing changed.
    expect(after.authored.cases[0]?.title).not.toBe(
      before.authored.cases[0]?.title
    );
  });
});

describe("case intent", () => {
  it("preserves a label in the authored file and resolved runner view", () => {
    const authored: EvalSuiteFile = {
      ...MINIMAL,
      cases: MINIMAL.cases.map((entry, index) =>
        index === 0 ? { ...entry, intent: "refund" } : entry
      ),
    };

    const loaded = loadOrThrow(serializeEvalSuiteFile(authored));
    expect(loaded.authored.cases[0]?.intent).toBe("refund");
    expect(loaded.resolved.cases[0]?.intent).toBe("refund");
  });

  it("treats an explicit null update as unlabelled in the runner view", () => {
    const authored: EvalSuiteFile = {
      ...MINIMAL,
      cases: MINIMAL.cases.map((entry, index) =>
        index === 0 ? { ...entry, intent: null } : entry
      ),
    };

    const loaded = loadOrThrow(asText(authored));
    expect(loaded.authored.cases[0]?.intent).toBeNull();
    expect(loaded.resolved.cases[0]?.intent).toBeUndefined();
  });
});

describe("case kind", () => {
  it("accepts capability and regression and omits when absent", () => {
    const authored: EvalSuiteFile = {
      ...MINIMAL,
      cases: MINIMAL.cases.map((entry, index) =>
        index === 0 ? { ...entry, kind: "regression" } : entry
      ),
    };
    const loaded = loadOrThrow(serializeEvalSuiteFile(authored));
    expect(loaded.authored.cases[0]?.kind).toBe("regression");
    expect(loaded.resolved.cases[0]?.kind).toBe("regression");

    const omitted = loadOrThrow(serializeEvalSuiteFile(MINIMAL));
    expect(omitted.authored.cases[0]?.kind).toBeUndefined();
    expect(omitted.resolved.cases[0]?.kind).toBeUndefined();
  });

  it("treats an explicit null kind as absent in the runner view", () => {
    const authored: EvalSuiteFile = {
      ...MINIMAL,
      cases: MINIMAL.cases.map((entry, index) =>
        index === 0 ? { ...entry, kind: null } : entry
      ),
    };
    const loaded = loadOrThrow(asText(authored));
    expect(loaded.authored.cases[0]?.kind).toBeNull();
    expect(loaded.resolved.cases[0]?.kind).toBeUndefined();
  });
});

/**
 * The case's grading rules are CHECKS. `assertions` is the name they were
 * authored under before the API, the UI and `create_eval_case` all settled on
 * `check`, and it still loads — a customer's committed suite file cannot stop
 * working because the word moved.
 */
describe("case checks", () => {
  const CHECK = {
    type: "toolCalledAtLeastOnce",
    toolName: "search",
  } as const;

  it("loads `checks` into the runner view", () => {
    const authored = {
      ...MINIMAL,
      cases: MINIMAL.cases.map((entry, index) =>
        index === 0 ? { ...entry, checks: [CHECK] } : entry
      ),
    } as EvalSuiteFile;

    const loaded = loadOrThrow(serializeEvalSuiteFile(authored));
    expect(loaded.authored.cases[0]?.checks).toEqual([CHECK]);
    expect(loaded.resolved.cases[0]?.assertions).toEqual([CHECK]);
  });

  it("still loads the deprecated `assertions` spelling", () => {
    const authored = {
      ...MINIMAL,
      cases: MINIMAL.cases.map((entry, index) =>
        index === 0 ? { ...entry, assertions: [CHECK] } : entry
      ),
    } as EvalSuiteFile;

    const loaded = loadOrThrow(serializeEvalSuiteFile(authored));
    expect(loaded.resolved.cases[0]?.assertions).toEqual([CHECK]);
  });

  it("refuses a case that sets both, rather than picking one", () => {
    // Two lists are two different gradings of one case. Choosing silently
    // would score it against rules its author cannot see in the file.
    const authored = {
      ...MINIMAL,
      cases: MINIMAL.cases.map((entry, index) =>
        index === 0 ? { ...entry, checks: [CHECK], assertions: [] } : entry
      ),
    } as EvalSuiteFile;

    const result = loadEvalSuiteFile(asText(authored));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).toContain("assertions");
  });

  it("serializes `checks` in canonical key order, not after `import`", () => {
    // A key missing from CASE_KEY_ORDER falls through to the remainder and is
    // appended last, so an authored file would reorder itself on its first
    // write-back — diff churn on a file a customer keeps in review.
    const authored = {
      ...MINIMAL,
      cases: MINIMAL.cases.map((entry, index) =>
        index === 0 ? { ...entry, checks: [CHECK] } : entry
      ),
    } as EvalSuiteFile;

    const text = serializeEvalSuiteFile(authored);
    expect(text.indexOf("checks:")).toBeGreaterThan(text.indexOf("steps:"));

    // And it is STABLE: serializing the reparsed file returns the same bytes.
    expect(serializeEvalSuiteFile(loadOrThrow(text).authored)).toBe(text);
  });

  it("sorts `checks` BEFORE `import`, the key it would have followed", () => {
    // The ordering that actually regressed: an unlisted key lands in the
    // remainder, which `ordered()` appends AFTER every listed one — so the
    // symptom is `checks` trailing `import`. A case with no `import` cannot
    // show that, so this one carries both (and the provenance an import
    // status requires).
    const authored = {
      ...MINIMAL,
      provenance: {
        sourceHash: "a".repeat(64),
        sourceFormat: "promptfoo",
        reportHash: "b".repeat(64),
      },
      cases: MINIMAL.cases.map((entry, index) =>
        index === 0
          ? {
              ...entry,
              checks: [CHECK],
              import: { status: "approximated", note: "widened the matcher" },
            }
          : entry
      ),
    } as EvalSuiteFile;

    const text = serializeEvalSuiteFile(authored);
    const checksAt = text.indexOf("checks:");
    const importAt = text.indexOf("import:");
    expect(checksAt).toBeGreaterThan(-1);
    expect(importAt).toBeGreaterThan(-1);
    expect(checksAt).toBeLessThan(importAt);
    expect(serializeEvalSuiteFile(loadOrThrow(text).authored)).toBe(text);
  });

  it("leaves a case with neither empty in the runner view", () => {
    const loaded = loadOrThrow(serializeEvalSuiteFile(MINIMAL));
    expect(loaded.resolved.cases[0]?.assertions).toEqual([]);
  });
});

/**
 * Dialect 2 spells the configured count `iterations` and the rule list
 * `assertions`. The loader reads both dialects into ONE resolved shape, and
 * writes each file back in its own dialect — never upgrading a file on its
 * author's behalf.
 */
describe("dialect 2", () => {
  const RULE = { type: "toolCalledAtLeastOnce", toolName: "search" } as const;

  it("resolves to the same in-memory view as its dialect-1 twin", () => {
    // The two minimal rows are the same suite under two spellings, so the
    // runner must not be able to tell them apart once resolved. Only the
    // declared version survives, because it is a fact about the file.
    const v1 = loadOrThrow(asText(MINIMAL)).resolved;
    const v2 = loadOrThrow(asText(MINIMAL_V2)).resolved;
    expect(v2.schemaVersion).toBe(EVAL_SUITE_SCHEMA_VERSION_2);
    expect({ ...v2, schemaVersion: undefined }).toEqual({
      ...v1,
      schemaVersion: undefined,
    });
    expect(v2.defaults.iterations).toBe(MINIMAL_V2.defaults.iterations);
    expect(v2.cases[0]?.iterations).toBe(MINIMAL_V2.defaults.iterations);
  });

  it("applies a per-case `iterations` override and loads `assertions`", () => {
    const authored: EvalSuiteFileV2 = {
      ...MINIMAL_V2,
      cases: MINIMAL_V2.cases.map((entry, index) =>
        index === 0 ? { ...entry, iterations: 2, assertions: [RULE] } : entry
      ),
    };
    const loaded = loadOrThrow(asText(authored));
    expect(loaded.resolved.cases[0]?.iterations).toBe(2);
    expect(loaded.resolved.cases[0]?.assertions).toEqual([RULE]);
  });

  it("writes a dialect-2 file back in dialect 2, in canonical key order", () => {
    const authored: EvalSuiteFileV2 = {
      ...MINIMAL_V2,
      cases: MINIMAL_V2.cases.map((entry, index) =>
        index === 0 ? { ...entry, iterations: 2, assertions: [RULE] } : entry
      ),
    };
    const text = serializeEvalSuiteFile(authored);
    expect(text).toContain('schemaVersion: "2"');
    expect(text).toContain("iterations:");
    expect(text).toContain("assertions:");
    // The dialect-1 words never appear: a writer emits the file's OWN dialect.
    expect(text).not.toContain("repetitions");
    expect(text).not.toContain("checks:");
    // `iterations` sits where `repetitions` sits in dialect 1, and
    // `assertions` where `checks` does — so the file reads in the order a
    // dialect-1 author already knows.
    expect(text.indexOf("iterations:")).toBeLessThan(
      text.indexOf("passThreshold:")
    );
    const caseAssertionsAt = text.lastIndexOf("assertions:");
    expect(caseAssertionsAt).toBeGreaterThan(text.indexOf("steps:"));
    // And it is STABLE: serializing the reparsed file returns the same bytes.
    expect(serializeEvalSuiteFile(loadOrThrow(text).authored)).toBe(text);
  });

  it("keeps a dialect-1 file in dialect 1 — nothing is upgraded on write", () => {
    const text = serializeEvalSuiteFile(MINIMAL);
    expect(text).toContain('schemaVersion: "1"');
    expect(text).toContain("repetitions:");
    expect(text).not.toContain("iterations:");
  });

  it("names the dialect that owns a foreign spelling, instead of just 'unrecognized'", () => {
    // A strict object refuses `repetitions` in a dialect-2 file, correctly —
    // but "Unrecognized key" alone sends the author hunting for a typo in a
    // word that is spelled right. The finding says which dialect spells it
    // that way and offers both fixes.
    const v2WithRepetitions = {
      ...MINIMAL_V2,
      defaults: { ...MINIMAL_V2.defaults, repetitions: 5 },
    };
    const result = loadEvalSuiteFile(asText(v2WithRepetitions));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const message = result.findings.map((entry) => entry.message).join("\n");
    expect(message).toContain(
      'schemaVersion "2" spells this field `iterations`'
    );
    expect(message).toContain(
      '`repetitions` is the schemaVersion "1" spelling'
    );

    const v2WithChecks = {
      ...MINIMAL_V2,
      cases: [{ ...MINIMAL_V2.cases[0], checks: [RULE] }],
    };
    const checks = loadEvalSuiteFile(asText(v2WithChecks));
    expect(checks.ok).toBe(false);
    if (checks.ok) return;
    expect(checks.findings.map((entry) => entry.message).join("\n")).toContain(
      'schemaVersion "2" spells this field `assertions`'
    );

    const v1WithIterations = {
      ...MINIMAL,
      defaults: { ...MINIMAL.defaults, iterations: 5 },
    };
    const v1 = loadEvalSuiteFile(asText(v1WithIterations));
    expect(v1.ok).toBe(false);
    if (v1.ok) return;
    expect(v1.findings.map((entry) => entry.message).join("\n")).toContain(
      'schemaVersion "1" spells this field `repetitions`'
    );
  });

  it("does not decorate an unknown key that is not a dialect spelling", () => {
    const stray = {
      ...MINIMAL_V2,
      cases: [{ ...MINIMAL_V2.cases[0], timeoutMs: 30_000 }],
    };
    const result = loadEvalSuiteFile(asText(stray));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const message = result.findings.map((entry) => entry.message).join("\n");
    expect(message).toContain("timeoutMs");
    expect(message).not.toContain("spells this field");
  });
});

describe("findings", () => {
  const duplicateCaseIds = asText(
    payload(findFixture(data.reject, "duplicate case ids"))
  );

  it("names the cross-field rules with a stable path", () => {
    const result = loadEvalSuiteFile(duplicateCaseIds);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.findings.map((entry) => entry.pointer)).toContain(
      "cases[1].id"
    );

    const duplicateSteps = loadEvalSuiteFile(
      asText(payload(findFixture(data.reject, "duplicate step ids")))
    );
    expect(duplicateSteps.ok).toBe(false);
    if (duplicateSteps.ok) return;
    expect(duplicateSteps.findings.map((entry) => entry.pointer)).toContain(
      "cases[0].steps[1].id"
    );

    const orphanImport = loadEvalSuiteFile(
      asText(payload(findFixture(data.reject, "case carries an import block")))
    );
    expect(orphanImport.ok).toBe(false);
    if (orphanImport.ok) return;
    expect(orphanImport.findings.map((entry) => entry.pointer)).toContain(
      "cases[0].import"
    );
  });

  it("keeps `path` and `pointer` in step", () => {
    const result = loadEvalSuiteFile(duplicateCaseIds);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const entry of result.findings) {
      expect(entry.pointer).toBe(suiteFilePointer(entry.path));
    }
  });

  it("is byte-identical across repeated runs, with no timestamps", () => {
    const first = loadEvalSuiteFile(duplicateCaseIds);
    const second = loadEvalSuiteFile(duplicateCaseIds);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const serialized = JSON.stringify(first);
    // A year is the cheapest tell for a timestamp that would make two runs of
    // the same file differ.
    expect(serialized).not.toMatch(/\b20\d{2}-\d{2}-\d{2}T/);
  });

  it("orders findings by document position, not by validator traversal", () => {
    const authored = {
      ...MINIMAL,
      cases: [
        { ...MINIMAL.cases[0], id: "c_one", title: "" },
        { ...MINIMAL.cases[0], id: "c_two", repetitions: 0 },
        { ...MINIMAL.cases[0], id: "c_three", passThreshold: 4 },
      ],
    };
    const result = loadEvalSuiteFile(asText(authored));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const indexes = result.findings.map((entry) => entry.path[1]);
    expect(indexes).toEqual([...indexes].sort((a, b) => Number(a) - Number(b)));
  });
});

describe("suiteFilePointer", () => {
  it("renders array indexes as brackets and the empty path as the file", () => {
    expect(suiteFilePointer([])).toBe("");
    expect(suiteFilePointer(["cases", 3, "steps", 0, "id"])).toBe(
      "cases[3].steps[0].id"
    );
    expect(suiteFilePointer(["defaults", "validity"])).toBe(
      "defaults.validity"
    );
  });
});

it("round-trips case family suppression without inventing defaults", () => {
  const base = payload(data.accept[0]) as EvalSuiteFile;
  const authored = {
    ...base,
    cases: base.cases.map((entry, index) =>
      index
        ? entry
        : { ...entry, suppressedSuiteStandardCheckIds: ["response.errors"] }
    ),
  };
  const loaded = loadOrThrow(asText(authored));
  expect(
    loaded.resolved.enabledCases[0].suppressedSuiteStandardCheckIds
  ).toEqual(["response.errors"]);
  const reloaded = loadOrThrow(serializeEvalSuiteFile(loaded.authored));
  expect(reloaded.authored.cases[0].suppressedSuiteStandardCheckIds).toEqual([
    "response.errors",
  ]);
});

describe("judge settings file parity", () => {
  it.each([MINIMAL, MINIMAL_V2])(
    "round trips instructions, manual mode and case opt-outs in both dialects",
    (minimal) => {
      const judge = {
        enabled: true,
        autoRun: false,
        model: "openai/gpt-5.4-mini",
        threshold: 0.8,
        rubric: {
          instructions: "Require a confirming tool result",
          criteria: [{ id: "confirmed", label: "Confirmed", required: true }],
        },
      };
      const input = {
        ...minimal,
        defaults: { ...minimal.defaults, judge },
        cases: minimal.cases.map((item) => ({
          ...item,
          judge: { enabled: false },
        })),
      };
      const loaded = loadOrThrow(JSON.stringify(input));
      expect(loaded.resolved.defaults.judge).toEqual(judge);
      expect(loaded.resolved.cases[0].judge).toEqual({ enabled: false });
      const reloaded = loadOrThrow(serializeEvalSuiteFile(loaded.authored));
      expect(reloaded.resolved.defaults.judge).toEqual(judge);
      expect(reloaded.resolved.cases[0].judge).toEqual({ enabled: false });
    }
  );
});
