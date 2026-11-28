import { describe, expect, it } from "vitest";
import { checkToolInputSchema } from "../../src/mcp-conformance/checks/tool-input-schema.js";

describe("tool input schema grading", () => {
  it.each([{ nullable: true }, { type: 42 }])(
    "grades a linked rule the same way as an inline rule: %j",
    (rule) => {
      const inline = { type: "object", properties: { name: rule } };
      const linked = {
        type: "object",
        properties: { name: { $ref: "#/$defs/name" } },
        $defs: { name: rule },
      };
      const expected = "type" in rule ? "invalid" : undefined;
      expect(checkToolInputSchema(inline)?.status).toBe(expected);
      expect(checkToolInputSchema(linked)?.status).toBe(expected);
    },
  );

  it("rejects a non-string dialect", () => {
    expect(checkToolInputSchema({ type: "object", $schema: 42 })).toMatchObject({
      status: "invalid",
      reason: expect.stringContaining("$schema"),
    });
  });

  it("resolves escaped pointers and boolean targets", () => {
    expect(checkToolInputSchema({
      type: "object",
      $ref: "#/$defs/a~1b%20c",
      $defs: { "a/b c": false },
    })).toBeUndefined();
  });

  it("checks a dynamic reference against an embedded resource", () => {
    const schema = {
      type: "object",
      $id: "https://example.com/input.json",
      $defs: { child: { $id: "child.json", $dynamicAnchor: "node", type: "string" } },
    };
    expect(checkToolInputSchema({ ...schema, $dynamicRef: "child.json#node" })).toBeUndefined();
    expect(checkToolInputSchema({ ...schema, $dynamicRef: "child.json#missing" })?.status).toBe("invalid");
  });

  it("checks local draft-07 definitions and fragment identifiers", () => {
    const schema = {
      type: "object",
      $schema: "http://json-schema.org/draft-07/schema#",
      definitions: { name: { $id: "#name", type: "string" } },
    };
    expect(checkToolInputSchema({ ...schema, $ref: "#name" })).toBeUndefined();
    expect(checkToolInputSchema({ ...schema, $ref: "#/definitions/missing" })?.status).toBe("invalid");
  });

  it("treats references in sample data as ordinary values", () => {
    expect(checkToolInputSchema({ type: "object", examples: [{ $ref: "#/missing" }] })).toBeUndefined();
  });

  it("fails a broken local link even when an outside schema is unavailable", () => {
    expect(checkToolInputSchema({
      type: "object",
      properties: {
        first: { $ref: "https://example.com/first.json" },
        second: { $ref: "#/$defs/missing" },
      },
    })?.status).toBe("invalid");
  });
});
