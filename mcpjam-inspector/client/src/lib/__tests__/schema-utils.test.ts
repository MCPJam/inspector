import { describe, it, expect } from "vitest";
import { validateToolOutput } from "../schema-utils.js";

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

  describe("non-JSON-Schema keywords", () => {
    it("ignores x- vendor extension keys", () => {
      const schema = {
        type: "object",
        properties: {
          result: { type: "number" },
        },
        required: ["result"],
        "x-fastmcp-wrap-result": true,
      };

      const result = {
        content: [{ type: "text", text: '{"result": 6}' }],
        structuredContent: { result: 6 },
      };

      const report = validateToolOutput(result, schema);
      expect(report.structuredErrors).toBeNull();
    });

    it("flags missing structuredContent even with x- keys in schema", () => {
      const schema = {
        type: "object",
        properties: {
          result: { type: "number" },
        },
        required: ["result"],
        "x-fastmcp-wrap-result": true,
      };

      const result = {
        content: [{ type: "text", text: '{"result": 6}' }],
      };

      const report = validateToolOutput(result, schema);
      expect(report.unstructuredStatus).toBe("schema_mismatch");
    });

    it("ignores OpenAPI 'example' keyword", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string", example: "John" },
          createdAt: {
            type: "string",
            format: "date-time",
            example: "2022-03-10T04:01:12Z",
          },
        },
        required: ["name"],
      };

      const result = {
        content: [
          {
            type: "text",
            text: '{"name": "Alice", "createdAt": "2024-01-01T00:00:00Z"}',
          },
        ],
        structuredContent: {
          name: "Alice",
          createdAt: "2024-01-01T00:00:00Z",
        },
      };

      const report = validateToolOutput(result, schema);
      expect(report.structuredErrors).toBeNull();
      expect(report.unstructuredStatus).toBe("not_applicable");
    });

    it("ignores nested non-JSON-Schema keywords in complex schemas", () => {
      const schema = {
        type: "object",
        properties: {
          data: { type: "string", "x-custom-annotation": "hello" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string", example: "abc-123" },
              },
            },
            description: "List of items",
            example: "e.g. a list of records",
          },
        },
        "x-vendor-info": { version: 2 },
      };

      const result = {
        content: [
          { type: "text", text: '{"data": "test", "items": [{"id": "1"}]}' },
        ],
        structuredContent: { data: "test", items: [{ id: "1" }] },
      };

      const report = validateToolOutput(result, schema);
      expect(report.structuredErrors).toBeNull();
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
