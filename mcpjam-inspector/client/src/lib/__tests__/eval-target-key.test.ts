import { describe, expect, it } from "vitest";
import { comparisonKey, type ModelSelection } from "@mcpjam/sdk/browser";
import {
  iterationTargetKey,
  modelEffortTargetKey,
  modelIdFromTargetKey,
  runIterationTargetKey,
  runTargetKey,
  sameRunTarget,
  selectionFromTargetKey,
  targetKeyLabel,
  targetKeyLabels,
  targetKeySuffix,
} from "../eval-target-key";

const SONNET = "anthropic/claude-sonnet-5.5";
const hosted = (effort?: "low" | "high", modelId = SONNET): ModelSelection => ({
  modelId,
  source: "hosted",
  ...(effort ? { settings: { reasoningEffort: effort } } : {}),
  fallback: { provider: "none", model: "none" },
});
const LOW = comparisonKey(hosted("low"));
const HIGH = comparisonKey(hosted("high"));

describe("selectionFromTargetKey", () => {
  it("round-trips a non-default key back to its selection", () => {
    const selection = selectionFromTargetKey(HIGH);
    expect(selection).toEqual(hosted("high"));
    expect(comparisonKey(selection)).toBe(HIGH);
  });

  it("round-trips an org-connection key", () => {
    const org: ModelSelection = {
      modelId: SONNET,
      source: "org",
      connectionRef: { kind: "orgProvider", id: "conn_1" },
      settings: { reasoningEffort: "low", temperature: 0.2 },
      fallback: { provider: "openrouter", model: "none" },
    };
    const key = comparisonKey(org);
    expect(comparisonKey(selectionFromTargetKey(key))).toBe(key);
  });

  it("reads a bare key as a default hosted selection", () => {
    const selection = selectionFromTargetKey(SONNET);
    expect(selection).toMatchObject({ modelId: SONNET, source: "hosted" });
    expect(comparisonKey(selection)).toBe(SONNET);
  });

  it("falls back to the bare reading on malformed JSON or a mismatched model", () => {
    expect(comparisonKey(selectionFromTargetKey(`${SONNET}\u0000{nope`))).toBe(
      SONNET,
    );
    const other = comparisonKey(hosted("high", "openai/gpt-5"));
    const spliced = `${SONNET}\u0000${other.split("\u0000")[1]}`;
    expect(comparisonKey(selectionFromTargetKey(spliced))).toBe(SONNET);
  });

  it("modelIdFromTargetKey strips the selection part", () => {
    expect(modelIdFromTargetKey(HIGH)).toBe(SONNET);
    expect(modelIdFromTargetKey(SONNET)).toBe(SONNET);
  });
});

describe("run and iteration keys", () => {
  it("prefer targetKey and fall back to today's model id", () => {
    expect(runTargetKey({ targetKey: HIGH, effectiveModelId: SONNET })).toBe(
      HIGH,
    );
    expect(runTargetKey({ targetKey: null, effectiveModelId: SONNET })).toBe(
      SONNET,
    );
    expect(runTargetKey({})).toBeUndefined();
    expect(
      iterationTargetKey({
        testCaseSnapshot: { model: SONNET, selection: hosted("low") },
      }),
    ).toBe(LOW);
    expect(iterationTargetKey({ testCaseSnapshot: { model: SONNET } })).toBe(
      SONNET,
    );
    expect(
      iterationTargetKey({
        targetKey: HIGH,
        testCaseSnapshot: { model: SONNET },
      }),
    ).toBe(HIGH);
  });

  it("a single-model run keys its iterations by the run", () => {
    expect(
      runIterationTargetKey(
        { effectiveModelId: SONNET, targetKey: HIGH },
        { testCaseSnapshot: { model: SONNET } },
      ),
    ).toBe(HIGH);
    expect(
      runIterationTargetKey(
        {},
        { testCaseSnapshot: { model: SONNET, selection: hosted("low") } },
      ),
    ).toBe(LOW);
  });

  it("sameRunTarget compares targets when both have one, models otherwise", () => {
    expect(
      sameRunTarget(
        { targetKey: LOW, effectiveModelId: SONNET },
        { targetKey: HIGH, effectiveModelId: SONNET },
      ),
    ).toBe(false);
    expect(
      sameRunTarget(
        { effectiveModelId: SONNET },
        { targetKey: HIGH, effectiveModelId: SONNET },
      ),
    ).toBe(true);
    expect(sameRunTarget({}, {})).toBe(true);
  });
});

describe("labels show only what differs", () => {
  it("two efforts of one model read Low / High", () => {
    const labels = targetKeyLabels([LOW, HIGH]);
    expect(labels.get(LOW)).toBe("claude-sonnet-5.5 · Low");
    expect(labels.get(HIGH)).toBe("claude-sonnet-5.5 · High");
  });

  it("a lone target reads as its model", () => {
    expect(targetKeyLabel(HIGH, [HIGH, "openai/gpt-5"])).toBe(
      "claude-sonnet-5.5",
    );
    expect(targetKeySuffix(HIGH, [HIGH])).toBe("");
  });

  it("a default run beside an effort run reads Default", () => {
    expect(targetKeyLabel(SONNET, [SONNET, HIGH])).toBe(
      "claude-sonnet-5.5 · Default",
    );
  });

  it("default keys alone are byte-identical to the model label", () => {
    const labels = targetKeyLabels([SONNET, "openai/gpt-5"], (id) => id);
    expect(labels.get(SONNET)).toBe(SONNET);
    expect(labels.get("openai/gpt-5")).toBe("openai/gpt-5");
  });

  it("names usage rows by model × effort", () => {
    expect(modelEffortTargetKey(SONNET, undefined)).toBe(SONNET);
    expect(modelEffortTargetKey(SONNET, "high")).toBe(HIGH);
    const weird = modelEffortTargetKey(SONNET, "turbo");
    expect(targetKeyLabel(weird, [weird, SONNET])).toBe(
      "claude-sonnet-5.5 · turbo",
    );
  });
});
