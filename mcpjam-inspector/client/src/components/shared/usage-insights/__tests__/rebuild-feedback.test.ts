import { describe, expect, it } from "vitest";
import { rebuildFeedback } from "../rebuild-feedback";

describe("rebuildFeedback", () => {
  it("confirms a freshly queued rebuild", () => {
    expect(
      rebuildFeedback({ runId: "r1", status: "queued", alreadyRunning: false }),
    ).toEqual({ tone: "success", message: "Rebuild queued" });
  });

  it("reports a plain coalesce as informational", () => {
    expect(
      rebuildFeedback({
        runId: "r1",
        status: "running",
        alreadyRunning: true,
        tuningMismatch: false,
      }).tone,
    ).toBe("info");
  });

  it("says out loud that a differently-tuned request was dropped", () => {
    // The failure this guards against is a silent one: the user changes a
    // setting, is told "already running", watches that run finish unchanged,
    // and concludes the knobs are broken.
    const feedback = rebuildFeedback({
      runId: "r1",
      status: "running",
      alreadyRunning: true,
      tuningMismatch: true,
    });
    expect(feedback.tone).toBe("warning");
    expect(feedback.message).toMatch(/not applied/i);
  });

  it("treats a backend with no mismatch field as a plain coalesce", () => {
    expect(
      rebuildFeedback({ runId: "r1", status: "running", alreadyRunning: true })
        .tone,
    ).toBe("info");
  });
});
