import { describe, expect, it } from "vitest";
import { pluginToolCallValidation } from "../tool-call-validation.js";

const tool = {
  name: "fixture",
  inputSchema: { type: "object" as const, additionalProperties: false },
  outputSchema: {
    type: "object" as const,
    required: ["value"],
    properties: { value: { type: "integer", minimum: 0 } },
  },
};
describe("shared ordinary tool admission", () => {
  it("accepts complete declared output and protocol error results without requiring success output", () => {
    const validate = pluginToolCallValidation(
      tool,
      {},
      (kind) => new Error(kind),
    );
    const result = {
      content: [{ type: "text", text: "Complete" }],
      structuredContent: { value: 1 },
      _meta: { "fixture/result": { nested: [null, false] } },
    };
    const before = JSON.stringify(result);
    expect(() => validate(result)).not.toThrow();
    expect(JSON.stringify(result)).toBe(before);
    const error = {
      content: [{ type: "text", text: "Server refused" }],
      isError: true,
      _meta: { "fixture/error": true },
    };
    expect(() => validate(error)).not.toThrow();
    expect(() =>
      validate({ ...error, structuredContent: { value: "invalid" } }),
    ).toThrow("result");
  });
  it("refuses invalid input, malformed schemas, missing/malformed output and oversized complete results", () => {
    const factory = (kind: string) => new Error(kind);
    expect(() =>
      pluginToolCallValidation(tool, { extra: true }, factory),
    ).toThrow("arguments");
    expect(() =>
      pluginToolCallValidation(
        { inputSchema: { type: "invented" } },
        {},
        factory,
      ),
    ).toThrow("schema");
    const validate = pluginToolCallValidation(tool, {}, factory);
    for (const result of [
      { content: [] },
      { content: [], structuredContent: { value: -1 } },
      { content: "invalid" },
    ])
      expect(() => validate(result)).toThrow("result");
    expect(() =>
      validate({
        content: [{ type: "text", text: "x".repeat(512 * 1024) }],
        structuredContent: { value: 1 },
      }),
    ).toThrow("limit");
  });
});
