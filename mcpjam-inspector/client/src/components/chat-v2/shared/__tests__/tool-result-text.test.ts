import { describe, expect, it } from "vitest";
import {
  extractDisplayFromToolResult,
  extractDisplayFromValue,
} from "../tool-result-text";

describe("tool-result-text", () => {
  describe("extractDisplayFromValue", () => {
    it("keeps plain text as text", () => {
      expect(extractDisplayFromValue("hello world")).toEqual({
        kind: "text",
        text: "hello world",
      });
    });

    it("preserves plain text whitespace exactly", () => {
      expect(extractDisplayFromValue("  hello world  \n")).toEqual({
        kind: "text",
        text: "  hello world  \n",
      });
    });

    it("keeps whitespace-only strings as text", () => {
      expect(extractDisplayFromValue("   \n\n")).toEqual({
        kind: "text",
        text: "   \n\n",
      });
    });

    it("keeps empty strings as text", () => {
      expect(extractDisplayFromValue("")).toEqual({
        kind: "text",
        text: "",
      });
    });

    it("parses JSON object strings into structured JSON", () => {
      expect(extractDisplayFromValue('{"users":[{"id":"1"}]}')).toEqual({
        kind: "json",
        value: { users: [{ id: "1" }] },
      });
    });

    it("keeps JSON primitives as text", () => {
      expect(extractDisplayFromValue("123")).toEqual({
        kind: "text",
        text: "123",
      });
      expect(extractDisplayFromValue('"ok"')).toEqual({
        kind: "text",
        text: '"ok"',
      });
    });
  });

  describe("extractDisplayFromToolResult", () => {
    it("parses JSON inside text content blocks", () => {
      expect(
        extractDisplayFromToolResult({
          content: [
            {
              type: "text",
              text: '{"users":[{"id":"1"}],"hasNextPage":false}',
            },
          ],
        }),
      ).toEqual({
        kind: "json",
        value: { users: [{ id: "1" }], hasNextPage: false },
      });
    });

    it("preserves whitespace in plain text content blocks", () => {
      expect(
        extractDisplayFromToolResult({
          content: [
            {
              type: "text",
              text: "  line one\nline two  \n",
            },
          ],
        }),
      ).toEqual({
        kind: "text",
        text: "  line one\nline two  \n",
      });
    });
  });
});
