import { describe, expect, it } from "vitest";
import {
  pluginToolCallValidation,
  PLUGIN_APP_READ_RESULT_BYTES,
} from "../tool-call-validation.js";
import { PLUGIN_INVOCATION_ORIGINS } from "../invocation.js";

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
  const fileResult = (bytes: number) => {
    const result = { content: [], structuredContent: { value: 1, blob: "" } };
    result.structuredContent.blob = "A".repeat(
      bytes - JSON.stringify(result).length,
    );
    return result;
  };
  const readTool = { ...tool, annotations: { readOnlyHint: true } };
  const error = (kind: string) => new Error(kind);

  it.each(["app", "settings"] as const)("admits an assembly-sized %s read without changing its bytes or schema validation", (origin) => {
    const result = fileResult(6_090_525);
    const validate = pluginToolCallValidation(readTool, {}, error, origin);
    expect(() => validate(result)).not.toThrow();
    expect(JSON.stringify(result)).toHaveLength(6_090_525);
    expect(result.structuredContent.blob.length).toBeGreaterThan(6_000_000);
    expect(() =>
      validate({ ...result, structuredContent: { value: -1 } }),
    ).toThrow("result");
    expect(() =>
      validate(fileResult(PLUGIN_APP_READ_RESULT_BYTES)),
    ).not.toThrow();
    expect(() =>
      validate(fileResult(PLUGIN_APP_READ_RESULT_BYTES + 1)),
    ).toThrow("limit");
  });

  it("keeps the ordinary budget for non-App origins and mutating or unannotated App calls", () => {
    const result = fileResult(512 * 1024 + 1);
    for (const origin of PLUGIN_INVOCATION_ORIGINS.filter(
      (value) => value !== "app" && value !== "settings",
    ))
      expect(() =>
        pluginToolCallValidation(readTool, {}, error, origin)(result),
      ).toThrow("limit");
    for (const candidate of [
      tool,
      { ...tool, annotations: { readOnlyHint: false } },
    ])
      expect(() =>
        pluginToolCallValidation(candidate, {}, error, "app")(result),
      ).toThrow("limit");
    expect(() => pluginToolCallValidation(readTool, {}, error)(result)).toThrow(
      "limit",
    );
  });

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
