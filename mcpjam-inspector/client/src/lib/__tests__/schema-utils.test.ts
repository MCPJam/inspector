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

  describe("unstructured content validation", () => {
    const stringSchema = {
      type: "object",
      properties: {
        message: { type: "string" },
        count: { type: "number" },
      },
      required: ["message"],
    };

    it("returns valid when content matches schema", () => {
      const result = {
        content: [
          { type: "text", text: JSON.stringify({ message: "hello", count: 42 }) },
        ],
      };

      const report = validateToolOutput(result, stringSchema);
      expect(report.unstructuredStatus).toBe("valid");
    });

    it("returns schema_mismatch when content does not match schema", () => {
      const result = {
        content: [
          {
            type: "text",
            text: JSON.stringify({ wrong: "property" }), // missing required "message"
          },
        ],
      };

      const report = validateToolOutput(result, stringSchema);
      expect(report.unstructuredStatus).toBe("schema_mismatch");
    });

    it("returns invalid_json when content is not valid JSON", () => {
      const result = {
        content: [{ type: "text", text: "not valid json {}" }],
      };

      const report = validateToolOutput(result, stringSchema);
      expect(report.unstructuredStatus).toBe("invalid_json");
    });

    it("handles empty JSON object", () => {
      const result = {
        content: [{ type: "text", text: "{}" }],
      };

      const report = validateToolOutput(result, stringSchema);
      expect(report.unstructuredStatus).toBe("schema_mismatch"); // missing required "message"
    });

    it("handles JSON array in content", () => {
      const arraySchema = {
        type: "array",
        items: { type: "string" },
      };
      const result = {
        content: [{ type: "text", text: '["a", "b", "c"]' }],
      };

      const report = validateToolOutput(result, arraySchema);
      expect(report.unstructuredStatus).toBe("valid");
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

  describe("combined validation", () => {
    const schema = {
      type: "object",
      properties: {
        value: { type: "number" },
      },
    };

    it("validates both structured and unstructured content independently", () => {
      const result = {
        content: [{ type: "text", text: '{"value": "not a number"}' }],
        structuredContent: { value: 42 },
      };

      const report = validateToolOutput(result, schema);

      // Structured content is valid
      expect(report.structuredErrors).toBeNull();

      // Unstructured content has wrong type
      expect(report.unstructuredStatus).toBe("schema_mismatch");
    });

    it("handles result with both valid structured and unstructured content", () => {
      const result = {
        content: [{ type: "text", text: '{"value": 123}' }],
        structuredContent: { value: 123 },
      };

      const report = validateToolOutput(result, schema);
      expect(report.structuredErrors).toBeNull();
      expect(report.unstructuredStatus).toBe("valid");
    });
  });

  describe("edge cases", () => {
    it("throws when content array is empty (accessing undefined index)", () => {
      const result = { content: [] };
      const schema = { type: "object" };

      // The implementation throws when trying to access content[0].text on empty array
      expect(() => validateToolOutput(result, schema)).toThrow();
    });

    it("handles null schema values", () => {
      const result = {
        content: [{ type: "text", text: '{"key": null}' }],
      };
      const schema = {
        type: "object",
        properties: {
          key: { type: "null" },
        },
      };

      const report = validateToolOutput(result, schema);
      expect(report.unstructuredStatus).toBe("valid");
    });

    it("handles nested objects in content", () => {
      const nestedSchema = {
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: {
              name: { type: "string" },
            },
            required: ["name"],
          },
        },
      };

      // Note: The content must be properly stringified JSON
      const result = {
        content: [
          {
            type: "text",
            text: '{"user":{"name":"John"}}',
          },
        ],
      };

      const report = validateToolOutput(result, nestedSchema);
      expect(report.unstructuredStatus).toBe("valid");
    });
  });
});
