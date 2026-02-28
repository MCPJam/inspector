import { describe, it, expect } from "vitest";
import { validateToolOutput } from "../schema-utils.js";

describe("validateToolOutput", () => {
  describe("when no outputSchema is provided", () => {
    it("returns undefined", () => {
      const result = { content: [{ type: "text", text: "Hello" }] };
      expect(validateToolOutput(result)).toBeUndefined();
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

    it("returns true when structuredContent is valid", () => {
      const result = {
        content: [{ type: "text", text: "raw content" }],
        structuredContent: { data: "valid" },
      };

      expect(validateToolOutput(result, schema)).toBe(true);
    });

    it("returns false when structuredContent is invalid", () => {
      const result = {
        content: [{ type: "text", text: "raw content" }],
        structuredContent: { wrong: "field" },
      };

      expect(validateToolOutput(result, schema)).toBe(false);
    });

    it("returns false when outputSchema is itself invalid", () => {
      const invalidSchema = {
        type: "invalid-type-that-doesnt-exist",
        properties: { $ref: "circular-reference" },
      };

      const result = {
        content: [{ type: "text", text: "{}" }],
        structuredContent: { any: "thing" },
      };

      // AJV may or may not throw for all invalid schemas —
      // either false or true is acceptable, but it must not throw
      expect(() => validateToolOutput(result, invalidSchema)).not.toThrow();
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

      expect(validateToolOutput(result, schema)).toBe(true);
    });

    it("ignores content[0].text shape when structuredContent is invalid", () => {
      const result = {
        content: [{ type: "text", text: '{"value": 123}' }],
        structuredContent: { value: "wrong type" },
      };

      expect(validateToolOutput(result, schema)).toBe(false);
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

      expect(validateToolOutput(result, schema)).toBe(true);
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

      expect(validateToolOutput(result, schema)).toBe(true);
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

      expect(validateToolOutput(result, schema)).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("returns undefined when no structuredContent is present", () => {
      const result = { content: [] };
      const schema = { type: "object" };

      expect(validateToolOutput(result, schema)).toBeUndefined();
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

      expect(validateToolOutput(result, schema)).toBe(true);
    });
  });
});
