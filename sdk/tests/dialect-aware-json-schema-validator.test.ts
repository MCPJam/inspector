import { describe, expect, it, vi } from "vitest";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { DialectAwareJsonSchemaValidator } from "../src/mcp-client-manager/dialect-aware-json-schema-validator.js";

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";
const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

// Shape of what zod-to-json-schema emits for a v1-SDK server's outputSchema
// (the Atlas `listFlights` regression: upstream's default validator rejects
// the declared draft-07 dialect outright instead of validating with it).
const draft07Schema = {
  $schema: DRAFT_07,
  type: "object",
  properties: {
    flights: { type: "array", items: { type: "object" } },
  },
  required: ["flights"],
  additionalProperties: false,
} as const;

describe("DialectAwareJsonSchemaValidator", () => {
  it("upstream default rejects declared draft-07 (the regression this guards against)", () => {
    expect(() =>
      new AjvJsonSchemaValidator().getValidator(draft07Schema)
    ).toThrow(/unsupported dialect/);
  });

  it("validates declared draft-07 schemas instead of rejecting them", () => {
    const validate = new DialectAwareJsonSchemaValidator().getValidator(
      draft07Schema
    );

    expect(validate({ flights: [] }).valid).toBe(true);

    const invalid = validate({ nope: true });
    expect(invalid.valid).toBe(false);
    expect(invalid.errorMessage).toBeTruthy();
  });

  it("accepts the https draft-07 URI and the no-fragment form", () => {
    for (const uri of [
      "https://json-schema.org/draft-07/schema#",
      "http://json-schema.org/draft-07/schema",
    ]) {
      const validate = new DialectAwareJsonSchemaValidator().getValidator({
        ...draft07Schema,
        $schema: uri,
      });
      expect(validate({ flights: [] }).valid).toBe(true);
    }
  });

  it("validates schemas with no $schema as 2020-12", () => {
    const validate = new DialectAwareJsonSchemaValidator().getValidator({
      type: "object",
      properties: { a: { type: "number" } },
      required: ["a"],
    });

    expect(validate({ a: 1 }).valid).toBe(true);
    expect(validate({}).valid).toBe(false);
  });

  it("supports 2020-12-only keywords on declared 2020-12 schemas", () => {
    const validate = new DialectAwareJsonSchemaValidator().getValidator({
      $schema: DRAFT_2020_12,
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: false,
    });

    expect(validate(["a", 1]).valid).toBe(true);
    expect(validate(["a", 1, "extra"]).valid).toBe(false);
  });

  it("validates format keywords (parity with the upstream default)", () => {
    const validate = new DialectAwareJsonSchemaValidator().getValidator({
      $schema: DRAFT_07,
      type: "object",
      properties: { when: { type: "string", format: "date-time" } },
    });

    expect(validate({ when: "2026-07-21T12:00:00Z" }).valid).toBe(true);
    expect(validate({ when: "not-a-date" }).valid).toBe(false);
  });

  it("skips validation and reports unknown dialects instead of failing the call", () => {
    const onUnknownDialect = vi.fn();
    const validate = new DialectAwareJsonSchemaValidator({
      onUnknownDialect,
    }).getValidator({
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "object",
    });

    expect(validate("anything at all").valid).toBe(true);
    expect(onUnknownDialect).toHaveBeenCalledWith(
      "http://json-schema.org/draft-04/schema#"
    );
  });
});
