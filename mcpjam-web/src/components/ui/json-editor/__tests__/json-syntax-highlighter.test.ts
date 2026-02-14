import { describe, it, expect } from "vitest";
import {
  tokenizeJson,
  formatPath,
  highlightJson,
} from "../json-syntax-highlighter";

describe("tokenizeJson", () => {
  describe("basic primitives", () => {
    it("tokenizes a string value", () => {
      const tokens = tokenizeJson('"hello"');
      expect(tokens).toHaveLength(1);
      expect(tokens[0]).toMatchObject({
        type: "string",
        value: '"hello"',
        start: 0,
        end: 7,
      });
    });

    it("tokenizes a number value", () => {
      const tokens = tokenizeJson("42");
      expect(tokens).toHaveLength(1);
      expect(tokens[0]).toMatchObject({
        type: "number",
        value: "42",
        start: 0,
        end: 2,
      });
    });

    it("tokenizes negative numbers", () => {
      const tokens = tokenizeJson("-123.45");
      expect(tokens).toHaveLength(1);
      expect(tokens[0]).toMatchObject({
        type: "number",
        value: "-123.45",
      });
    });

    it("tokenizes scientific notation", () => {
      const tokens = tokenizeJson("1.5e10");
      expect(tokens).toHaveLength(1);
      expect(tokens[0]).toMatchObject({
        type: "number",
        value: "1.5e10",
      });
    });

    it("tokenizes boolean true", () => {
      const tokens = tokenizeJson("true");
      expect(tokens).toHaveLength(1);
      expect(tokens[0]).toMatchObject({
        type: "boolean",
        value: "true",
      });
    });

    it("tokenizes boolean false", () => {
      const tokens = tokenizeJson("false");
      expect(tokens).toHaveLength(1);
      expect(tokens[0]).toMatchObject({
        type: "boolean-false",
        value: "false",
      });
    });

    it("tokenizes null", () => {
      const tokens = tokenizeJson("null");
      expect(tokens).toHaveLength(1);
      expect(tokens[0]).toMatchObject({
        type: "null",
        value: "null",
      });
    });
  });

  describe("objects", () => {
    it("tokenizes an empty object", () => {
      const tokens = tokenizeJson("{}");
      expect(tokens).toHaveLength(2);
      expect(tokens[0]).toMatchObject({ type: "punctuation", value: "{" });
      expect(tokens[1]).toMatchObject({ type: "punctuation", value: "}" });
    });

    it("tokenizes a simple object with key-value", () => {
      const tokens = tokenizeJson('{"name": "value"}');
      expect(tokens).toHaveLength(5);
      expect(tokens[0]).toMatchObject({ type: "punctuation", value: "{" });
      expect(tokens[1]).toMatchObject({ type: "key", value: '"name"' });
      expect(tokens[2]).toMatchObject({ type: "punctuation", value: ":" });
      expect(tokens[3]).toMatchObject({ type: "string", value: '"value"' });
      expect(tokens[4]).toMatchObject({ type: "punctuation", value: "}" });
    });

    it("tokenizes object with multiple keys", () => {
      const tokens = tokenizeJson('{"a": 1, "b": 2}');
      const keys = tokens.filter((t) => t.type === "key");
      const numbers = tokens.filter((t) => t.type === "number");
      expect(keys).toHaveLength(2);
      expect(numbers).toHaveLength(2);
    });
  });

  describe("arrays", () => {
    it("tokenizes an empty array", () => {
      const tokens = tokenizeJson("[]");
      expect(tokens).toHaveLength(2);
      expect(tokens[0]).toMatchObject({ type: "punctuation", value: "[" });
      expect(tokens[1]).toMatchObject({ type: "punctuation", value: "]" });
    });

    it("tokenizes array with primitives", () => {
      const tokens = tokenizeJson("[1, 2, 3]");
      const numbers = tokens.filter((t) => t.type === "number");
      expect(numbers).toHaveLength(3);
      expect(numbers.map((t) => t.value)).toEqual(["1", "2", "3"]);
    });

    it("tokenizes array with mixed types", () => {
      const tokens = tokenizeJson('[1, "two", true, null]');
      expect(tokens.filter((t) => t.type === "number")).toHaveLength(1);
      expect(tokens.filter((t) => t.type === "string")).toHaveLength(1);
      expect(tokens.filter((t) => t.type === "boolean")).toHaveLength(1);
      expect(tokens.filter((t) => t.type === "null")).toHaveLength(1);
    });
  });

  describe("nested structures", () => {
    it("tokenizes nested objects", () => {
      const json = '{"outer": {"inner": "value"}}';
      const tokens = tokenizeJson(json);
      const keys = tokens.filter((t) => t.type === "key");
      expect(keys).toHaveLength(2);
      expect(keys.map((t) => t.value)).toEqual(['"outer"', '"inner"']);
    });

    it("tokenizes nested arrays", () => {
      const json = "[[1, 2], [3, 4]]";
      const tokens = tokenizeJson(json);
      const brackets = tokens.filter((t) => t.value === "[" || t.value === "]");
      expect(brackets).toHaveLength(6);
    });

    it("tokenizes objects in arrays", () => {
      const json = '[{"a": 1}, {"b": 2}]';
      const tokens = tokenizeJson(json);
      const keys = tokens.filter((t) => t.type === "key");
      expect(keys).toHaveLength(2);
    });

    it("tokenizes arrays in objects", () => {
      const json = '{"items": [1, 2, 3]}';
      const tokens = tokenizeJson(json);
      const numbers = tokens.filter((t) => t.type === "number");
      expect(numbers).toHaveLength(3);
    });
  });

  describe("escape sequences in strings", () => {
    it("handles escaped quotes", () => {
      const tokens = tokenizeJson('"hello \\"world\\""');
      expect(tokens).toHaveLength(1);
      expect(tokens[0].value).toBe('"hello \\"world\\""');
    });

    it("handles escaped backslashes", () => {
      const tokens = tokenizeJson('"path\\\\to\\\\file"');
      expect(tokens).toHaveLength(1);
      expect(tokens[0].value).toBe('"path\\\\to\\\\file"');
    });

    it("handles escaped newlines and tabs", () => {
      const tokens = tokenizeJson('"line1\\nline2\\ttab"');
      expect(tokens).toHaveLength(1);
      expect(tokens[0].type).toBe("string");
    });

    it("handles unicode escapes", () => {
      const tokens = tokenizeJson('"unicode: \\u0041"');
      expect(tokens).toHaveLength(1);
      expect(tokens[0].type).toBe("string");
    });
  });

  describe("path tracking", () => {
    it("tracks path for simple object values", () => {
      const tokens = tokenizeJson('{"name": "John"}');
      const stringValue = tokens.find(
        (t) => t.type === "string" && t.value === '"John"',
      );
      expect(stringValue?.path).toEqual(["name"]);
      expect(stringValue?.keyName).toBe("name");
    });

    it("tracks path for nested values", () => {
      const tokens = tokenizeJson('{"user": {"name": "John"}}');
      const stringValue = tokens.find(
        (t) => t.type === "string" && t.value === '"John"',
      );
      expect(stringValue?.path).toEqual(["user", "name"]);
    });

    it("tracks path for array elements", () => {
      const tokens = tokenizeJson('{"items": [1, 2]}');
      const numbers = tokens.filter((t) => t.type === "number");
      expect(numbers[0].path).toEqual(["items", 0]);
      expect(numbers[1].path).toEqual(["items", 1]);
    });

    it("tracks path for deeply nested array in object", () => {
      const tokens = tokenizeJson('{"data": {"list": [{"id": 1}]}}');
      const numberToken = tokens.find((t) => t.type === "number");
      expect(numberToken?.path).toEqual(["data", "list", 0, "id"]);
    });
  });

  describe("edge cases", () => {
    it("handles empty string values", () => {
      const tokens = tokenizeJson('{"empty": ""}');
      const stringValue = tokens.find(
        (t) => t.type === "string" && t.value === '""',
      );
      expect(stringValue).toBeDefined();
    });

    it("handles zero", () => {
      const tokens = tokenizeJson("0");
      expect(tokens[0]).toMatchObject({ type: "number", value: "0" });
    });

    it("handles negative zero", () => {
      const tokens = tokenizeJson("-0");
      expect(tokens[0]).toMatchObject({ type: "number", value: "-0" });
    });

    it("handles whitespace between tokens", () => {
      const tokens = tokenizeJson('{ "a" : 1 }');
      expect(tokens.filter((t) => t.type === "key")).toHaveLength(1);
      expect(tokens.filter((t) => t.type === "number")).toHaveLength(1);
    });

    it("handles newlines in formatted JSON", () => {
      const json = `{
  "name": "test"
}`;
      const tokens = tokenizeJson(json);
      expect(tokens.filter((t) => t.type === "key")).toHaveLength(1);
      expect(tokens.filter((t) => t.type === "string")).toHaveLength(1);
    });
  });
});

describe("formatPath", () => {
  it("formats simple path", () => {
    expect(formatPath(["user"])).toBe("user");
  });

  it("formats nested path with dots", () => {
    expect(formatPath(["user", "profile", "name"])).toBe("user.profile.name");
  });

  it("formats path with array indices", () => {
    expect(formatPath(["items", 0])).toBe("items[0]");
  });

  it("formats complex path with mixed keys and indices", () => {
    expect(formatPath(["users", 0, "addresses", 1, "city"])).toBe(
      "users[0].addresses[1].city",
    );
  });

  it("handles empty path", () => {
    expect(formatPath([])).toBe("");
  });

  it("handles path starting with array index", () => {
    expect(formatPath([0, "name"])).toBe("[0].name");
  });
});

describe("highlightJson", () => {
  it("returns HTML with span elements", () => {
    const html = highlightJson('{"key": "value"}');
    expect(html).toContain('<span class="json-punctuation">{</span>');
    expect(html).toContain('<span class="json-key">"key"</span>');
    expect(html).toContain('<span class="json-string">"value"</span>');
  });

  it("escapes HTML entities", () => {
    const html = highlightJson('{"html": "<div>&amp;</div>"}');
    expect(html).toContain("&lt;div&gt;&amp;amp;&lt;/div&gt;");
  });

  it("preserves whitespace between tokens", () => {
    const html = highlightJson('{ "a": 1 }');
    expect(html).toContain(" ");
  });
});
