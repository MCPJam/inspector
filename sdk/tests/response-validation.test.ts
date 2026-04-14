import {
  buildToolCallValidationReport,
  evaluateToolCallOutcome,
  validateToolCallEnvelope,
  validateToolCallResult,
} from "../src/response-validation";

describe("validateToolCallEnvelope", () => {
  it("accepts valid text content", () => {
    const result = validateToolCallEnvelope({
      content: [{ type: "text", text: "ok" }],
      isError: false,
    });

    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.details.contentItemTypes).toEqual(["text"]);
  });

  it("accepts valid multi-item non-text content", () => {
    const result = validateToolCallEnvelope({
      content: [
        { type: "text", text: "ok" },
        {
          type: "image",
          data: "Zm9v",
          mimeType: "image/png",
        },
        {
          type: "resource",
          resource: {
            uri: "file:///note.txt",
            mimeType: "text/plain",
            text: "note",
          },
        },
      ],
    });

    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.details.contentItemTypes).toEqual([
      "text",
      "image",
      "resource",
    ]);
  });

  it("allows missing content", () => {
    const result = validateToolCallEnvelope({ isError: false });

    expect(result.passed).toBe(true);
    expect(result.details.hasContent).toBe(false);
  });

  it("rejects non-array content", () => {
    const result = validateToolCallEnvelope({
      content: { type: "text", text: "nope" },
    });

    expect(result.passed).toBe(false);
    expect(result.errors).toEqual([
      'Tool call result "content" must be an array when present.',
    ]);
  });

  it("rejects non-object content items and missing types", () => {
    const result = validateToolCallEnvelope({
      content: ["bad", { text: "missing-type" }],
    });

    expect(result.passed).toBe(false);
    expect(result.errors).toEqual([
      "Content item 0 must be an object.",
      "Content item 1 must include a string type.",
    ]);
  });

  it("warns about unknown content types instead of failing them", () => {
    const result = validateToolCallEnvelope({
      content: [{ type: "custom", value: 123 }],
    });

    expect(result.passed).toBe(true);
    expect(result.warnings).toEqual([
      'Unknown content item type "custom" at index 0 was not strictly validated.',
    ]);
  });
});

describe("evaluateToolCallOutcome", () => {
  it("fails on isError only when policy requests it", () => {
    const result = evaluateToolCallOutcome(
      { isError: true },
      { failOnIsError: true }
    );

    expect(result.passed).toBe(false);
    expect(result.errors).toEqual(["Tool call result reported isError: true."]);
  });
});

describe("validateToolCallResult", () => {
  it("keeps protocol validity separate from outcome policy", () => {
    const result = validateToolCallResult(
      {
        isError: true,
        content: [{ type: "text", text: "failed" }],
      },
      {
        envelope: true,
        outcome: { failOnIsError: true },
      }
    );

    expect(result.envelope?.passed).toBe(true);
    expect(result.outcome?.passed).toBe(false);
    expect(result.passed).toBe(false);
  });
});

describe("buildToolCallValidationReport", () => {
  it("stores a redacted copy of the raw result in metadata", () => {
    const validation = validateToolCallResult(
      {
        isError: false,
        content: [{ type: "text", text: "ok" }],
      },
      { envelope: true }
    );

    const report = buildToolCallValidationReport(validation, {
      rawResult: {
        headers: { Authorization: "Bearer super-secret" },
        accessToken: "top-secret",
      },
    });

    expect(report.schemaVersion).toBe(1);
    expect(report.kind).toBe("tools-call-validation");
    expect(report.metadata).toEqual({
      redactedRawResult: {
        headers: { Authorization: "[REDACTED]" },
        accessToken: "[REDACTED]",
      },
    });
  });
});
