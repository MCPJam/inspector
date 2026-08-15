import { describe, expect, it } from "vitest";
import {
  compactInsightsForModel,
  MODEL_CONTRACT_JSON_CAP,
  MODEL_MAX_EVIDENCE_PER_FINDING,
  MODEL_MAX_FINDINGS,
} from "../src/tools/platformTools.js";

function finding(i: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `rf_${i}`,
    actionability: i === 0 ? "ready" : "investigate",
    evidence: [{ kind: "tool_error", excerpt: "e1" }],
    ...overrides,
  };
}

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    scope: { kind: "eval_run", id: "r" },
    status: "completed",
    findings: [finding(0)],
    truncation: {
      truncated: false,
      omittedFindings: 0,
      omittedEvidence: 0,
      contractTruncated: false,
    },
    ...overrides,
  };
}

describe("compactInsightsForModel", () => {
  it("passes small envelopes through untouched (same reference)", () => {
    const payload = { run: { id: "r", insights: envelope() } };
    expect(compactInsightsForModel(payload)).toBe(payload);
  });

  it("caps findings head-first (ready findings sort first upstream) and counts omissions", () => {
    const findings = Array.from({ length: MODEL_MAX_FINDINGS + 4 }, (_, i) =>
      finding(i)
    );
    const out = compactInsightsForModel({
      insights: envelope({ findings }),
    }) as { insights: ReturnType<typeof envelope> };
    const compacted = out.insights;
    expect(compacted.findings).toHaveLength(MODEL_MAX_FINDINGS);
    expect((compacted.findings as Array<{ id: string }>)[0]!.id).toBe("rf_0");
    expect(compacted.truncation).toMatchObject({
      truncated: true,
      omittedFindings: 4,
    });
  });

  it("caps evidence per finding and counts every omitted record", () => {
    const evidence = Array.from({ length: 5 }, (_, i) => ({
      kind: "tool_error",
      excerpt: `e${i}`,
    }));
    const out = compactInsightsForModel({
      insights: envelope({ findings: [finding(0, { evidence })] }),
    }) as { insights: { findings: Array<{ evidence: unknown[] }>; truncation: { omittedEvidence: number } } };
    expect(out.insights.findings[0]!.evidence).toHaveLength(
      MODEL_MAX_EVIDENCE_PER_FINDING
    );
    expect(out.insights.truncation.omittedEvidence).toBe(
      5 - MODEL_MAX_EVIDENCE_PER_FINDING
    );
  });

  it("truncates contract fragments before dropping findings, and says so", () => {
    const big = "x".repeat(MODEL_CONTRACT_JSON_CAP * 2);
    const out = compactInsightsForModel({
      insights: envelope({
        findings: [
          finding(0, {
            target: {
              serverId: "s",
              surface: "input_schema",
              snapshotHash: "h",
              currentDefinition: { inputSchemaJson: big, truncated: false },
            },
          }),
        ],
      }),
    }) as {
      insights: {
        findings: Array<{
          target: { currentDefinition: { inputSchemaJson: string; truncated: boolean } };
        }>;
        truncation: { contractTruncated: boolean };
      };
    };
    const def = out.insights.findings[0]!.target.currentDefinition;
    expect(def.inputSchemaJson).toHaveLength(MODEL_CONTRACT_JSON_CAP);
    expect(def.truncated).toBe(true);
    expect(out.insights.truncation.contractTruncated).toBe(true);
  });

  it("finds envelopes one level down and leaves other fields alone", () => {
    const findings = Array.from({ length: MODEL_MAX_FINDINGS + 1 }, (_, i) =>
      finding(i)
    );
    const out = compactInsightsForModel({
      project: { id: "p" },
      run: { id: "r", status: "completed", insights: envelope({ findings }) },
    }) as { project: { id: string }; run: { insights: { truncation: { omittedFindings: number } } } };
    expect(out.project).toEqual({ id: "p" });
    expect(out.run.insights.truncation.omittedFindings).toBe(1);
  });
});
