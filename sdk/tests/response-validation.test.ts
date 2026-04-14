import {
  buildToolCallValidationReport,
  evaluateToolCallOutcome,
  validateToolCallEnvelope,
  validateToolCallResult,
} from "../src/response-validation";

describe("validateToolCallEnvelope", () => {
  it("accepts valid audio and resource link content blocks", () => {
    const result = validateToolCallEnvelope({
      content: [
        { type: "audio", data: "Zm9v", mimeType: "audio/wav" },
        {
          type: "resource_link",
          uri: "file:///tmp/output.txt",
          name: "Output",
          mimeType: "text/plain",
        },
      ],
      isError: false,
    });

    expect(result.passed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.details.contentItemTypes).toEqual(["audio", "resource_link"]);
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

  it("rejects unsupported content block types instead of warning", () => {
    const result = validateToolCallEnvelope({
      content: [{ type: "custom", value: 123 }],
    });

    expect(result.passed).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.errors).toEqual([
      'Tool call result failed MCP validation at "content[0]": Invalid input',
    ]);
  });

  it("rejects invalid image payloads that only provide a url", () => {
    const result = validateToolCallEnvelope({
      content: [{ type: "image", url: "https://example.com/image.png" }],
    });

    expect(result.passed).toBe(false);
    expect(result.errors).toEqual([
      'Tool call result failed MCP validation at "content[0]": Invalid input',
    ]);
  });

  it("rejects resource content that only includes mimeType", () => {
    const result = validateToolCallEnvelope({
      content: [
        {
          type: "resource",
          resource: {
            uri: "file:///note.txt",
            mimeType: "text/plain",
          },
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.errors).toEqual([
      'Tool call result failed MCP validation at "content[0]": Invalid input',
    ]);
  });

  it("rejects non-boolean isError values", () => {
    const result = validateToolCallEnvelope({
      isError: "true",
      content: [{ type: "text", text: "ok" }],
    });

    expect(result.passed).toBe(false);
    expect(result.errors).toContain(
      'Tool call result failed MCP validation at "isError": Invalid input: expected boolean, received string',
    );
  });
});

describe("evaluateToolCallOutcome", () => {
  it("fails on isError only when policy requests it", () => {
    const result = evaluateToolCallOutcome(
      { isError: true },
      { failOnIsError: true },
    );

    expect(result.passed).toBe(false);
    expect(result.errors).toEqual(["Tool call result reported isError: true."]);
  });

  it("rejects malformed isError values even without failOnIsError", () => {
    const result = evaluateToolCallOutcome(
      { isError: "true" },
      { failOnIsError: false },
    );

    expect(result.passed).toBe(false);
    expect(result.errors).toContain(
      'Tool call result failed MCP validation at "isError": Invalid input: expected boolean, received string',
    );
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
      },
    );

    expect(result.envelope?.passed).toBe(true);
    expect(result.outcome?.passed).toBe(false);
    expect(result.passed).toBe(false);
  });
});

describe("buildToolCallValidationReport", () => {
  it("stores a redacted compact summary instead of the full raw payload", () => {
    const longText = "Authorization: Bearer super-secret ".repeat(20);
    const resourceText = "refresh_token=resource-secret ".repeat(20);
    const linkDescription = "client_secret=link-secret ".repeat(20);
    const rawResult = {
      isError: false,
      content: [
        { type: "text", text: longText },
        { type: "image", data: "A".repeat(5_000), mimeType: "image/png" },
        { type: "audio", data: "B".repeat(6_000), mimeType: "audio/wav" },
        {
          type: "resource",
          resource: {
            uri: "file:///tmp/blob.bin",
            mimeType: "text/plain",
            text: resourceText,
          },
        },
        {
          type: "resource_link",
          uri: "file:///tmp/file.txt",
          name: "File",
          description: linkDescription,
        },
      ],
      structuredContent: {
        giant: "x".repeat(1_000),
      },
      _meta: {
        accessToken: "top-secret",
      },
    };
    const validation = validateToolCallResult(rawResult, { envelope: true });

    const report = buildToolCallValidationReport(validation, { rawResult });
    const summary = report.metadata.redactedRawResult as Record<string, unknown>;
    const serializedSummary = JSON.stringify(summary);

    expect(report.schemaVersion).toBe(1);
    expect(report.kind).toBe("tools-call-validation");
    expect(summary).toEqual({
      isError: false,
      contentCount: 5,
      content: [
        {
          type: "text",
          textLength: longText.length,
          textPreview: expect.stringContaining("Authorization: [REDACTED]"),
        },
        {
          type: "image",
          mimeType: "image/png",
          dataLength: 5_000,
        },
        {
          type: "audio",
          mimeType: "audio/wav",
          dataLength: 6_000,
        },
        {
          type: "resource",
          resource: {
            uri: "file:///tmp/blob.bin",
            mimeType: "text/plain",
            textLength: resourceText.length,
            textPreview: expect.stringContaining(
              "refresh_token=[REDACTED]",
            ),
          },
        },
        {
          type: "resource_link",
          uri: "file:///tmp/file.txt",
          name: "File",
          descriptionLength: linkDescription.length,
          descriptionPreview: expect.stringContaining(
            "client_secret=[REDACTED]",
          ),
        },
      ],
      structuredContentKeys: ["giant"],
      metaKeys: ["accessToken"],
    });
    expect(serializedSummary).not.toContain("A".repeat(100));
    expect(serializedSummary).not.toContain("B".repeat(100));
    expect(serializedSummary).not.toContain("x".repeat(100));
    expect(serializedSummary).not.toContain("top-secret");
  });
});
