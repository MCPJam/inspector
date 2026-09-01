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
import type { EvalSuiteFile } from "../src/contract/suite-file.js";
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

describe("the parity corpus, through the loader", () => {
  it("accepts every accept row", () => {
    expect(data.accept).toHaveLength(6);
    for (const row of data.accept) {
      const result = loadEvalSuiteFile(asText(payload(row)));
      expect(result.ok, `${row.__label}: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it("rejects every reject row as a CONTRACT failure, not a parse failure", () => {
    expect(data.reject).toHaveLength(35);
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
    expect(data.roundTrip).toHaveLength(2);
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
    expect(only?.repetitions).toBe(MINIMAL.defaults.repetitions);
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
