import { afterEach, describe, expect, it, vi } from "vitest";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/client/validators/cf-worker";
import { DialectAwareJsonSchemaValidator } from "../src/mcp-client-manager/dialect-aware-json-schema-validator.js";
import { CspSafeDialectAwareJsonSchemaValidator } from "../src/mcp-client-manager/csp-safe-dialect-aware-json-schema-validator.js";

const DRAFT_07 = "http://json-schema.org/draft-07/schema#";
const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

// Shape of what zod-to-json-schema emits for a v1-SDK server's outputSchema
// (the Atlas `listFlights` regression: upstream's defaults rejected the
// declared draft-07 dialect outright instead of validating with it).
const draft07Schema = {
  $schema: DRAFT_07,
  type: "object",
  properties: {
    flights: { type: "array", items: { type: "object" } },
  },
  required: ["flights"],
  additionalProperties: false,
} as const;

/**
 * Where upstream's own defaults stand today.
 *
 * The Atlas regression these classes were written for is FIXED upstream as of
 * client 2.0.0: both default validators now compile a declared draft-07 schema
 * and validate with it. This block pins the boundary that is still real —
 * draft-04 is rejected by both — so the day upstream moves again, this fails
 * loudly instead of the dialect-aware classes silently carrying a dead load.
 *
 * Consequence worth acting on separately: for the two dialects the dispatcher
 * covers (2020-12 and draft-07) `DialectAwareJsonSchemaValidator` and
 * `CspSafeDialectAwareJsonSchemaValidator` are now redundant with upstream.
 * Retiring them touches the factory default and the browser/workerd bundles,
 * so it is a deliberate product change, not test cleanup — see the tests below
 * for the behavior any replacement must keep.
 */
describe("upstream defaults, post-2.0.0", () => {
  it("AjvJsonSchemaValidator (node default) now validates declared draft-07", () => {
    const validate = new AjvJsonSchemaValidator().getValidator(draft07Schema);

    expect(validate({ flights: [] }).valid).toBe(true);
    expect(validate({ nope: true }).valid).toBe(false);
  });

  it("CfWorkerJsonSchemaValidator (browser/workerd default) now validates declared draft-07", () => {
    const validate = new CfWorkerJsonSchemaValidator().getValidator(
      draft07Schema
    );

    expect(validate({ flights: [] }).valid).toBe(true);
    expect(validate({ nope: true }).valid).toBe(false);
  });

  it("still rejects a dialect neither engine carries (draft-04)", () => {
    const draft04Schema = {
      ...draft07Schema,
      $schema: "http://json-schema.org/draft-04/schema#",
    };

    expect(() =>
      new AjvJsonSchemaValidator().getValidator(draft04Schema)
    ).toThrow(/unsupported dialect/);
    expect(() =>
      new CfWorkerJsonSchemaValidator().getValidator(draft04Schema)
    ).toThrow(/unsupported dialect/);
  });
});

describe.each([
  ["DialectAwareJsonSchemaValidator (ajv)", DialectAwareJsonSchemaValidator],
  [
    "CspSafeDialectAwareJsonSchemaValidator (cfworker)",
    CspSafeDialectAwareJsonSchemaValidator,
  ],
] as const)("%s", (_name, ValidatorClass) => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates declared draft-07 schemas instead of rejecting them", () => {
    const validate = new ValidatorClass().getValidator(draft07Schema);

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
      const validate = new ValidatorClass().getValidator({
        ...draft07Schema,
        $schema: uri,
      });
      expect(validate({ flights: [] }).valid).toBe(true);
    }
  });

  it("validates schemas with no $schema as 2020-12", () => {
    const validate = new ValidatorClass().getValidator({
      type: "object",
      properties: { a: { type: "number" } },
      required: ["a"],
    });

    expect(validate({ a: 1 }).valid).toBe(true);
    expect(validate({}).valid).toBe(false);
  });

  it("supports 2020-12-only keywords on declared 2020-12 schemas", () => {
    const validate = new ValidatorClass().getValidator({
      $schema: DRAFT_2020_12,
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: false,
    });

    expect(validate(["a", 1]).valid).toBe(true);
    expect(validate(["a", 1, "extra"]).valid).toBe(false);
  });

  it("skips validation and reports unknown dialects instead of failing the call", () => {
    const onUnknownDialect = vi.fn();
    const validate = new ValidatorClass({ onUnknownDialect }).getValidator({
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "object",
    });

    expect(validate("anything at all").valid).toBe(true);
    expect(onUnknownDialect).toHaveBeenCalledWith(
      "http://json-schema.org/draft-04/schema#"
    );
  });

  it("warns via console.warn by default, once per dialect per instance", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const validator = new ValidatorClass();
    const unknown = {
      $schema: "http://json-schema.org/draft-04/schema#",
      type: "object",
    } as const;

    validator.getValidator(unknown);
    validator.getValidator(unknown);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("draft-04");
  });
});

describe("DialectAwareJsonSchemaValidator (ajv-only behavior)", () => {
  it("validates format keywords (parity with the upstream node default)", () => {
    const validate = new DialectAwareJsonSchemaValidator().getValidator({
      $schema: DRAFT_07,
      type: "object",
      properties: { when: { type: "string", format: "date-time" } },
    });

    expect(validate({ when: "2026-07-21T12:00:00Z" }).valid).toBe(true);
    expect(validate({ when: "not-a-date" }).valid).toBe(false);
  });
});
