import { describe, expect, it } from "vitest";
import {
  HOSTED_MRTR_DATA_PART_TYPE,
  HOSTED_MRTR_VERSION,
  isCompatibleMrtrVersion,
  isMrtrContinuationDataPart,
  isMrtrContinuationEvent,
  isMrtrResumeSubmission,
  type MrtrInputRequiredEvent,
} from "../mrtr-continuation";

const inputRequired: MrtrInputRequiredEvent = {
  kind: "input_required",
  version: HOSTED_MRTR_VERSION,
  continuationId: "cont-1",
  serverId: "srv-1",
  serverName: "GitHub",
  method: "tools/call",
  operationLabel: "create_issue",
  round: 0,
  inputRequests: [
    { key: "q1", mode: "form", message: "Pick a repo", requestedSchema: { type: "object" } },
    { key: "q2", mode: "url", message: "Authorize", url: "https://example.test/auth" },
  ],
  expiresAt: Date.now() + 60_000,
  chatSessionId: "chat-1",
};

describe("mrtr-continuation data part", () => {
  it("accepts a well-formed input_required event", () => {
    expect(isMrtrContinuationEvent(inputRequired)).toBe(true);
    expect(
      isMrtrContinuationDataPart({
        type: HOSTED_MRTR_DATA_PART_TYPE,
        data: inputRequired,
      }),
    ).toBe(true);
  });

  it("accepts a resolved event with optional indeterminate flag", () => {
    expect(
      isMrtrContinuationEvent({
        kind: "resolved",
        version: HOSTED_MRTR_VERSION,
        continuationId: "cont-1",
        outcome: "indeterminate" as never,
      }),
    ).toBe(false); // 'indeterminate' is NOT a valid resolved outcome
    expect(
      isMrtrContinuationEvent({
        kind: "resolved",
        version: HOSTED_MRTR_VERSION,
        continuationId: "cont-1",
        outcome: "failed",
        indeterminate: true,
      }),
    ).toBe(true);
  });

  it("rejects a url-mode request missing its url", () => {
    const bad = {
      ...inputRequired,
      inputRequests: [{ key: "q2", mode: "url", message: "Authorize" }],
    };
    expect(isMrtrContinuationEvent(bad)).toBe(false);
  });

  it("rejects an event with no input requests", () => {
    expect(
      isMrtrContinuationEvent({ ...inputRequired, inputRequests: [] }),
    ).toBe(false);
  });

  it("rejects a non-numeric version", () => {
    expect(
      isMrtrContinuationEvent({ ...inputRequired, version: "1" as never }),
    ).toBe(false);
  });
});

describe("HOSTED_MRTR_VERSION handshake (stale-browser fast fail)", () => {
  it("matches the current version", () => {
    expect(isCompatibleMrtrVersion(HOSTED_MRTR_VERSION)).toBe(true);
  });

  it("fails fast on a newer part than the browser understands", () => {
    expect(isCompatibleMrtrVersion(HOSTED_MRTR_VERSION + 1)).toBe(false);
  });

  it("fails fast on an older part", () => {
    expect(isCompatibleMrtrVersion(HOSTED_MRTR_VERSION - 1)).toBe(false);
  });
});

describe("isMrtrResumeSubmission", () => {
  it("accepts a well-formed submission", () => {
    expect(
      isMrtrResumeSubmission({
        continuationId: "cont-1",
        round: 0,
        responses: {
          q1: { action: "accept", content: { repo: "x" } },
          q2: { action: "decline" },
        },
      }),
    ).toBe(true);
  });

  it("rejects an invalid action", () => {
    expect(
      isMrtrResumeSubmission({
        continuationId: "cont-1",
        round: 0,
        responses: { q1: { action: "approve" } },
      }),
    ).toBe(false);
  });

  it("rejects a non-integer-shaped round or missing responses", () => {
    expect(
      isMrtrResumeSubmission({ continuationId: "c", round: "0", responses: {} }),
    ).toBe(false);
    expect(
      isMrtrResumeSubmission({ continuationId: "c", round: 0 }),
    ).toBe(false);
  });
});
