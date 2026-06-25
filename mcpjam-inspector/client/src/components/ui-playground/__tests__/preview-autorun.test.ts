import { describe, expect, it } from "vitest";
import { shouldAutoRunPreview, shouldRunPreview } from "../preview-autorun";

const base = {
  autoRunInput: "Draw a dog",
  alreadyRan: false,
  isSessionBootstrapComplete: true,
  isThreadEmpty: true,
  isStreaming: false,
  handoffPending: false,
};

describe("shouldAutoRunPreview", () => {
  it("runs once the session is ready and no handoff is pending", () => {
    expect(shouldAutoRunPreview(base)).toBe(true);
  });

  it("waits for the model/settings handoff to apply first", () => {
    // The plan's merge-blocking case: model/settings must bind before auto-run.
    expect(shouldAutoRunPreview({ ...base, handoffPending: true })).toBe(false);
  });

  it("does not run twice", () => {
    expect(shouldAutoRunPreview({ ...base, alreadyRan: true })).toBe(false);
  });

  it("does not run without an input", () => {
    expect(shouldAutoRunPreview({ ...base, autoRunInput: undefined })).toBe(
      false,
    );
  });

  it("waits for session bootstrap", () => {
    expect(
      shouldAutoRunPreview({ ...base, isSessionBootstrapComplete: false }),
    ).toBe(false);
  });

  it("does not run into a non-empty or streaming thread", () => {
    expect(shouldAutoRunPreview({ ...base, isThreadEmpty: false })).toBe(false);
    expect(shouldAutoRunPreview({ ...base, isStreaming: true })).toBe(false);
  });
});

describe("shouldRunPreview", () => {
  const base = {
    runPreviewRequest: 1,
    alreadyHandledRequest: 0,
    isSessionBootstrapComplete: true,
    isStreaming: false,
    handoffPending: false,
  };

  it("runs when the session is ready", () => {
    expect(shouldRunPreview(base)).toBe(true);
  });

  it("does not run without a request nonce", () => {
    expect(shouldRunPreview({ ...base, runPreviewRequest: undefined })).toBe(
      false,
    );
  });

  it("waits for the model/settings handoff to apply first", () => {
    expect(shouldRunPreview({ ...base, handoffPending: true })).toBe(false);
  });

  it("does not re-run the same request nonce", () => {
    expect(shouldRunPreview({ ...base, alreadyHandledRequest: 1 })).toBe(false);
  });

  it("waits for session bootstrap and defers while streaming", () => {
    expect(
      shouldRunPreview({ ...base, isSessionBootstrapComplete: false }),
    ).toBe(false);
    expect(shouldRunPreview({ ...base, isStreaming: true })).toBe(false);
  });
});
