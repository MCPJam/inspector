import { describe, expect, it } from "vitest";
import {
  HTTP_STEP_ORDER,
  LIFECYCLE_GUIDE_METADATA,
  LIFECYCLE_GUIDE_SLIM,
  PHASE_ACCENT,
  getLifecycleStepGuide,
  getLifecycleStepIndex,
  isLastHttpLifecycleStep,
  nextHttpLifecycleStepId,
} from "../mcp-lifecycle-guide-data";

describe("LIFECYCLE_GUIDE_METADATA", () => {
  it("has metadata for all 5 HTTP steps", () => {
    expect(HTTP_STEP_ORDER).toHaveLength(5);
    for (const step of HTTP_STEP_ORDER) {
      expect(LIFECYCLE_GUIDE_METADATA[step]).toBeDefined();
    }
  });

  it("HTTP_STEP_ORDER matches expected step sequence", () => {
    expect(HTTP_STEP_ORDER).toEqual([
      "initialize_request",
      "initialize_result",
      "initialized_notification",
      "operation_request",
      "operation_response",
    ]);
  });

  it("each step has required fields: title, summary, phase, teachableMoments, tips", () => {
    for (const step of HTTP_STEP_ORDER) {
      const guide = LIFECYCLE_GUIDE_METADATA[step]!;
      expect(guide.title).toBeTruthy();
      expect(guide.summary).toBeTruthy();
      expect(["initialization", "operation", "shutdown"]).toContain(
        guide.phase,
      );
      expect(guide.teachableMoments.length).toBeGreaterThan(0);
      expect(guide.tips.length).toBeGreaterThan(0);
    }
  });

  it("code examples are valid JSON strings where provided", () => {
    for (const step of HTTP_STEP_ORDER) {
      const guide = LIFECYCLE_GUIDE_METADATA[step]!;
      if (guide.codeExample) {
        expect(() => JSON.parse(guide.codeExample!)).not.toThrow();
      }
    }
  });

  it("all 5 steps have code examples", () => {
    for (const step of HTTP_STEP_ORDER) {
      const guide = LIFECYCLE_GUIDE_METADATA[step]!;
      expect(guide.codeExample).toBeTruthy();
    }
  });

  it("tables have consistent column counts", () => {
    for (const step of HTTP_STEP_ORDER) {
      const guide = LIFECYCLE_GUIDE_METADATA[step]!;
      if (guide.table) {
        const headerCount = guide.table.headers.length;
        for (const row of guide.table.rows) {
          expect(row).toHaveLength(headerCount);
        }
      }
    }
  });
});

describe("nextHttpLifecycleStepId", () => {
  it("returns the first step when current is undefined", () => {
    expect(nextHttpLifecycleStepId(undefined)).toBe("initialize_request");
  });

  it("returns the first step when current is unknown", () => {
    expect(nextHttpLifecycleStepId("not_a_step")).toBe("initialize_request");
  });

  it("advances along HTTP_STEP_ORDER", () => {
    expect(nextHttpLifecycleStepId("initialize_request")).toBe(
      "initialize_result",
    );
    expect(nextHttpLifecycleStepId("operation_request")).toBe(
      "operation_response",
    );
  });

  it("wraps from the last step to the first", () => {
    expect(nextHttpLifecycleStepId("operation_response")).toBe(
      "initialize_request",
    );
  });
});

describe("isLastHttpLifecycleStep", () => {
  it("is false when current is undefined", () => {
    expect(isLastHttpLifecycleStep(undefined)).toBe(false);
  });

  it("is true only on the final HTTP step", () => {
    expect(isLastHttpLifecycleStep("operation_request")).toBe(false);
    expect(isLastHttpLifecycleStep("operation_response")).toBe(true);
  });
});

describe("getLifecycleStepGuide", () => {
  it("returns guide for valid step", () => {
    const guide = getLifecycleStepGuide("initialize_request");
    expect(guide).toBeDefined();
    expect(guide!.title).toBe("Initialize Request");
  });

  it("returns undefined for stdio-only step", () => {
    const guide = getLifecycleStepGuide("close_stdin");
    expect(guide).toBeUndefined();
  });
});

describe("getLifecycleStepIndex", () => {
  it("returns correct indices for HTTP steps", () => {
    expect(getLifecycleStepIndex("initialize_request")).toBe(0);
    expect(getLifecycleStepIndex("initialize_result")).toBe(1);
    expect(getLifecycleStepIndex("initialized_notification")).toBe(2);
    expect(getLifecycleStepIndex("operation_request")).toBe(3);
    expect(getLifecycleStepIndex("operation_response")).toBe(4);
  });

  it("returns MAX_SAFE_INTEGER for stdio-only steps", () => {
    expect(getLifecycleStepIndex("close_stdin")).toBe(Number.MAX_SAFE_INTEGER);
    expect(getLifecycleStepIndex("process_exit")).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("LIFECYCLE_GUIDE_SLIM", () => {
  it("has slim data for all 5 HTTP steps", () => {
    for (const step of HTTP_STEP_ORDER) {
      expect(LIFECYCLE_GUIDE_SLIM[step]).toBeDefined();
    }
  });

  it("each slim step has concise content", () => {
    for (const step of HTTP_STEP_ORDER) {
      const slim = LIFECYCLE_GUIDE_SLIM[step];
      expect(slim.title).toBeTruthy();
      expect(slim.subtitle.length).toBeLessThan(80);
      expect(slim.keyInsight.length).toBeLessThan(200);
      expect(["initialization", "operation", "shutdown"]).toContain(slim.phase);
      expect(["client-to-server", "server-to-client"]).toContain(
        slim.direction,
      );
    }
  });

  it("all slim steps have code snippets", () => {
    for (const step of HTTP_STEP_ORDER) {
      expect(LIFECYCLE_GUIDE_SLIM[step].codeSnippet).toBeTruthy();
    }
  });
});

describe("PHASE_ACCENT", () => {
  it("has colors for all three phases", () => {
    expect(PHASE_ACCENT.initialization).toBeTruthy();
    expect(PHASE_ACCENT.operation).toBeTruthy();
    expect(PHASE_ACCENT.shutdown).toBeTruthy();
  });
});
