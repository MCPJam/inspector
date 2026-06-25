import { describe, it, expect } from "vitest";
import { assembleStepResults, parseStepStatusById } from "../eval-step-replay";
import type { TestStep } from "../steps";

// The assembler reads only `id` + `kind` off each step, so minimal fixtures
// cast through `TestStep` keep the test focused on the join logic.
const steps = [
  { id: "s1", kind: "prompt", prompt: "Show me a redbull" },
  { id: "s2", kind: "assert", assertion: { type: "toolCalledWith" } },
  { id: "s3", kind: "assert", assertion: { type: "widgetRendered" } },
  { id: "s4", kind: "interact", toolName: "store", action: { type: "click" } },
  { id: "s5", kind: "assert", assertion: { type: "toolCalledWith" } },
] as unknown as TestStep[];

describe("assembleStepResults", () => {
  it("projects persisted stepResults onto every authored step, in order", () => {
    const metadata = {
      stepResults: [
        { stepId: "s1", stepIndex: 0, kind: "prompt", status: "ok" },
        { stepId: "s2", stepIndex: 1, kind: "assert", status: "ok", reason: "tool called" },
        { stepId: "s3", stepIndex: 2, kind: "assert", status: "ok" },
        {
          stepId: "s4",
          stepIndex: 3,
          kind: "interact",
          status: "fail",
          reason: "locator timeout",
        },
        {
          stepId: "s5",
          stepIndex: 4,
          kind: "assert",
          status: "skipped",
          reason: "assert failed (step 4)",
        },
      ],
    };
    const envelope = {
      browserInteractionSteps: [
        {
          authoredStepId: "s4",
          screenshotUrl: "https://blob/s4.png",
          source: "scripted",
          locatorLabel: "Add to cart",
          ok: false,
          videoOffsetMs: 4200,
          widgetToolCalls: [{ name: "view-cart", args: {}, ok: true }],
        },
      ],
      widgetRenderObservations: [
        { authoredStepId: "s3", screenshotUrl: "https://blob/s3.png" },
      ],
      videoUrl: "https://blob/run.webm",
    };

    const out = assembleStepResults(steps, metadata, envelope);

    expect(out.map((s) => [s.stepId, s.status])).toEqual([
      ["s1", "ok"],
      ["s2", "ok"],
      ["s3", "ok"],
      ["s4", "fail"],
      ["s5", "skipped"],
    ]);
    // Reason survives from the persisted row.
    expect(out[3].reason).toBe("locator timeout");
    // Interact evidence: screenshot + source + locator + widget tool calls + video.
    expect(out[3].evidence).toMatchObject({
      screenshotUrl: "https://blob/s4.png",
      source: "scripted",
      locatorLabel: "Add to cart",
      // videoUrl present only because this step is seekable (has an offset).
      videoOffsetMs: 4200,
      videoUrl: "https://blob/run.webm",
      toolCalls: [{ name: "view-cart", ok: true }],
    });
    // widgetRendered assert picks up the render-observation screenshot.
    expect(out[2].evidence?.screenshotUrl).toBe("https://blob/s3.png");
    // A step with no artifact has no evidence key at all.
    expect(out[0].evidence).toBeUndefined();
  });

  it("falls back to browser rows + skippedSteps when stepResults is absent", () => {
    const metadata = { skippedSteps: [{ stepId: "s5" }] };
    const envelope = {
      browserInteractionSteps: [
        // widget-DOM assert verdict carried on its interaction row
        { authoredStepId: "s3", assertion: { passed: false, reason: "not visible" } },
        // interact ok flag
        { authoredStepId: "s4", ok: true },
      ],
    };

    const out = assembleStepResults(steps, metadata, envelope);

    expect(out.find((s) => s.stepId === "s3")).toMatchObject({
      status: "fail",
      reason: "not visible",
    });
    expect(out.find((s) => s.stepId === "s4")?.status).toBe("ok");
    expect(out.find((s) => s.stepId === "s5")?.status).toBe("skipped");
    // prompt/predicate-assert with no persisted verdict degrade to pending, not a false ok.
    expect(out.find((s) => s.stepId === "s1")?.status).toBe("pending");
    expect(out.find((s) => s.stepId === "s2")?.status).toBe("pending");
  });

  it("buckets evidence by promptIndex+toolCallId when authoredStepId is absent", () => {
    // Pre-authoredStepId run: persisted record still keys verdict by stepId,
    // but the artifact row only has promptIndex/toolCallId. With no stepId
    // linkage the evidence simply doesn't attach (graceful, no crash).
    const metadata = {
      stepResults: [{ stepId: "s4", stepIndex: 3, kind: "interact", status: "ok" }],
    };
    const envelope = {
      browserInteractionSteps: [
        { promptIndex: 0, toolCallId: "tc1", screenshotUrl: "https://blob/legacy.png" },
      ],
    };
    const out = assembleStepResults(steps, metadata, envelope);
    expect(out.find((s) => s.stepId === "s4")?.status).toBe("ok");
    // No authoredStepId match ⇒ no evidence attached (degrade, don't guess).
    expect(out.find((s) => s.stepId === "s4")?.evidence).toBeUndefined();
  });

  it("returns one row per step even with empty metadata + envelope", () => {
    const out = assembleStepResults(steps, undefined, undefined);
    expect(out).toHaveLength(5);
    expect(out.every((s) => s.status === "pending")).toBe(true);
  });

  it("never leaks internal/blob fields from the envelope rows (contract)", () => {
    // The assembler whitelists fields field-by-field (no spread), so internal
    // keys present on the source rows must not appear in the output — this is
    // the public-contract guarantee the /steps route depends on.
    const metadata = {
      stepResults: [{ stepId: "s4", stepIndex: 3, kind: "interact", status: "ok" }],
    };
    const envelope = {
      browserInteractionSteps: [
        {
          authoredStepId: "s4",
          screenshotUrl: "https://blob/s4.png",
          videoOffsetMs: 100,
          // Internal-only fields that MUST NOT survive:
          screenshotBlobId: "kg2_storage_secret",
          toolCallId: "tc-internal",
          promptIndex: 0,
          note: "internal-debug-note",
        },
      ],
      videoUrl: "https://blob/run.webm",
      videoBlobId: "kg2_video_secret",
    };
    const out = assembleStepResults(steps, metadata, envelope);
    const serialized = JSON.stringify(out);
    for (const leak of [
      "authoredStepId",
      "screenshotBlobId",
      "kg2_storage_secret",
      "kg2_video_secret",
      "toolCallId",
      "tc-internal",
      "promptIndex",
      "internal-debug-note",
    ]) {
      expect(serialized).not.toContain(leak);
    }
    // But the public evidence DID come through.
    expect(serialized).toContain("https://blob/s4.png");
  });
});

describe("parseStepStatusById", () => {
  it("maps persisted stepResults to an EvalStepStatus map keyed by stepId", () => {
    const map = parseStepStatusById({
      stepResults: [
        { stepId: "s1", status: "ok" },
        { stepId: "s2", status: "fail" },
        { stepId: "s3", status: "skipped" },
      ],
    });
    expect(map.get("s1")).toBe("ok");
    expect(map.get("s2")).toBe("fail");
    expect(map.get("s3")).toBe("skipped");
    expect(map.size).toBe(3);
  });

  it("omits pending rows so the step row stays neutral (not a false verdict)", () => {
    const map = parseStepStatusById({
      stepResults: [
        { stepId: "s1", status: "ok" },
        { stepId: "s2", status: "pending" },
      ],
    });
    expect(map.has("s2")).toBe(false);
    expect(map.size).toBe(1);
  });

  it("returns an empty map when stepResults is absent (pre-stepResults runs)", () => {
    expect(parseStepStatusById(undefined).size).toBe(0);
    expect(parseStepStatusById({}).size).toBe(0);
  });

  it("skips malformed rows (missing stepId or unknown status)", () => {
    const map = parseStepStatusById({
      stepResults: [
        { status: "ok" }, // no stepId
        { stepId: "s2", status: "weird" }, // unknown status
        { stepId: "s3", status: "ok" },
      ],
    });
    expect(map.size).toBe(1);
    expect(map.get("s3")).toBe("ok");
  });
});
