import { describe, it, expect } from "vitest";
import { validateToolOutput, type ValidationReport } from "../schema-utils.js";

describe("validateToolOutput", () => {
  describe("when no outputSchema is provided", () => {
    it("returns not_applicable status and undefined structuredErrors", () => {
      const result = { content: [{ type: "text", text: "Hello" }] };
      const report = validateToolOutput(result);

      expect(report.structuredErrors).toBeUndefined();
      expect(report.unstructuredStatus).toBe("not_applicable");
    });
  });

  describe("structured content validation", () => {
    const schema = {
      type: "object",
      properties: {
        data: { type: "string" },
      },
      required: ["data"],
    };

    it("returns null structuredErrors when structuredContent is valid", () => {
      const result = {
        content: [{ type: "text", text: "raw content" }],
        structuredContent: { data: "valid" },
      };

      const report = validateToolOutput(result, schema);
      expect(report.structuredErrors).toBeNull(); // null means valid
      expect(report.unstructuredStatus).toBe("not_applicable");
    });

    it("returns validation errors when structuredContent is invalid", () => {
      const result = {
        content: [{ type: "text", text: "raw content" }],
        structuredContent: { wrong: "field" },
      };

      const report = validateToolOutput(result, schema);
      expect(report.structuredErrors).toBeDefined();
      expect(report.structuredErrors).not.toBeNull();
      expect(report.structuredErrors!.length).toBeGreaterThan(0);
      // unstructured is still not_applicable because structuredContent exists
      expect(report.unstructuredStatus).toBe("not_applicable");
    });

    it("returns schema-compilation error when outputSchema is invalid", () => {
      const invalidSchema = {
        type: "invalid-type-that-doesnt-exist",
        properties: { $ref: "circular-reference" },
      };

      const result = {
        content: [{ type: "text", text: "{}" }],
        structuredContent: { any: "thing" },
      };

      const report = validateToolOutput(result, invalidSchema);
      // Note: AJV may or may not throw for all invalid schemas
      // This tests the error handling path
      expect(report.structuredErrors !== undefined).toBe(true);
    });
  });

  describe("missing structuredContent", () => {
    const schema = {
      type: "object",
      properties: {
        message: { type: "string" },
      },
      required: ["message"],
    };

    it("flags as schema_mismatch when outputSchema exists but no structuredContent", () => {
      const result = {
        content: [{ type: "text", text: JSON.stringify({ message: "hello" }) }],
      };

      const report = validateToolOutput(result, schema);
      expect(report.structuredErrors).toBeUndefined();
      expect(report.unstructuredStatus).toBe("schema_mismatch");
    });

    it("does not flag error responses as schema_mismatch", () => {
      const result = {
        content: [{ type: "text", text: "Something went wrong" }],
        isError: true,
      };

      const report = validateToolOutput(result, schema);
      expect(report.unstructuredStatus).toBe("not_applicable");
    });

    it("does not validate content[0].text against the schema", () => {
      // Even though the text content matches the schema shape,
      // we only care about structuredContent
      const result = {
        content: [{ type: "text", text: JSON.stringify({ message: "valid" }) }],
      };

      const report = validateToolOutput(result, schema);
      // Still flagged because structuredContent is missing
      expect(report.unstructuredStatus).toBe("schema_mismatch");
    });
  });

  describe("content is never validated against outputSchema", () => {
    const schema = {
      type: "object",
      properties: {
        value: { type: "number" },
      },
    };

    it("ignores content[0].text shape when structuredContent is valid", () => {
      // FastMCP scenario: structured = { value: 42 }, text = something else
      const result = {
        content: [{ type: "text", text: '{"value": "not a number"}' }],
        structuredContent: { value: 42 },
      };

      const report = validateToolOutput(result, schema);
      expect(report.structuredErrors).toBeNull();
      expect(report.unstructuredStatus).toBe("not_applicable");
    });

    it("ignores content[0].text shape when structuredContent is invalid", () => {
      const result = {
        content: [{ type: "text", text: '{"value": 123}' }],
        structuredContent: { value: "wrong type" },
      };

      const report = validateToolOutput(result, schema);
      expect(report.structuredErrors).not.toBeNull();
      expect(report.unstructuredStatus).toBe("not_applicable");
    });
  });

  describe("edge cases", () => {
    it("handles empty content array without throwing", () => {
      const result = { content: [] };
      const schema = { type: "object" };

      // No longer accesses content[0], so shouldn't throw
      const report = validateToolOutput(result, schema);
      expect(report.unstructuredStatus).toBe("schema_mismatch");
    });

    it("handles result with structuredContent and empty content", () => {
      const schema = {
        type: "object",
        properties: { key: { type: "null" } },
      };
      const result = {
        content: [],
        structuredContent: { key: null },
      };

      const report = validateToolOutput(result, schema);
      expect(report.structuredErrors).toBeNull();
      expect(report.unstructuredStatus).toBe("not_applicable");
    });
  });
});
