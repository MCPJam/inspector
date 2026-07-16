import { patternHint } from "../schema";
import { describe, it, expect } from "vitest";
import {
  buildElicitationContent,
  initialFormValues,
  parseElicitationSchema,
  validateField,
  type ElicitationField,
} from "../schema";

const field = (over: Partial<ElicitationField>): ElicitationField => ({
  name: "f",
  kind: "string",
  required: false,
  ...over,
});

describe("parseElicitationSchema", () => {
  it("returns [] for non-object / property-less schemas", () => {
    expect(parseElicitationSchema(undefined)).toEqual([]);
    expect(parseElicitationSchema(null)).toEqual([]);
    expect(parseElicitationSchema("nope")).toEqual([]);
    expect(parseElicitationSchema({})).toEqual([]);
    expect(parseElicitationSchema({ properties: [] })).toEqual([]);
  });

  it("parses primitives with constraints and required flags", () => {
    const fields = parseElicitationSchema({
      type: "object",
      required: ["name"],
      properties: {
        name: {
          type: "string",
          title: "Full name",
          description: "Your name",
          minLength: 2,
          maxLength: 10,
          pattern: "^[A-Z]",
        },
        age: { type: "integer", minimum: 0, maximum: 120 },
        score: { type: "number", minimum: 0.5 },
        subscribed: { type: "boolean" },
      },
    });

    expect(fields.map((f) => [f.name, f.kind])).toEqual([
      ["name", "string"],
      ["age", "integer"],
      ["score", "number"],
      ["subscribed", "boolean"],
    ]);
    expect(fields[0]).toMatchObject({
      title: "Full name",
      description: "Your name",
      required: true,
      minLength: 2,
      maxLength: 10,
      pattern: "^[A-Z]",
    });
    expect(fields[1]).toMatchObject({
      minimum: 0,
      maximum: 120,
      required: false,
    });
    expect(fields[2]).toMatchObject({ minimum: 0.5 });
  });

  it("parses string formats, ignoring unknown ones", () => {
    const fields = parseElicitationSchema({
      properties: {
        a: { type: "string", format: "email" },
        b: { type: "string", format: "uri" },
        c: { type: "string", format: "date" },
        d: { type: "string", format: "date-time" },
        e: { type: "string", format: "hostname" },
      },
    });
    expect(fields.map((f) => f.format)).toEqual([
      "email",
      "uri",
      "date",
      "date-time",
      undefined,
    ]);
  });

  it("parses a single-select enum from prop.enum with legacy enumNames", () => {
    const [f] = parseElicitationSchema({
      properties: {
        color: {
          type: "string",
          enum: ["r", "g", "b"],
          enumNames: ["Red", "Green"],
        },
      },
    });
    expect(f.kind).toBe("enum");
    expect(f.options).toEqual([
      { value: "r", label: "Red" },
      { value: "g", label: "Green" },
      // No name at this index -> falls back to the raw value.
      { value: "b", label: "b" },
    ]);
  });

  it("parses a single-select enum from oneOf {const,title}", () => {
    const [f] = parseElicitationSchema({
      properties: {
        plan: {
          oneOf: [
            { const: "free", title: "Free" },
            { const: "pro", title: "Pro" },
          ],
        },
      },
    });
    expect(f.kind).toBe("enum");
    expect(f.options).toEqual([
      { value: "free", label: "Free" },
      { value: "pro", label: "Pro" },
    ]);
  });

  it("parses a single-select enum from anyOf {const} without titles", () => {
    const [f] = parseElicitationSchema({
      properties: { plan: { anyOf: [{ const: "a" }, { const: "b" }] } },
    });
    expect(f.kind).toBe("enum");
    expect(f.options).toEqual([
      { value: "a", label: "a" },
      { value: "b", label: "b" },
    ]);
  });

  it("parses a multi-select enum from array items.enum with minItems/maxItems", () => {
    const [f] = parseElicitationSchema({
      required: ["tags"],
      properties: {
        tags: {
          type: "array",
          title: "Tags",
          items: { type: "string", enum: ["x", "y", "z"] },
          minItems: 1,
          maxItems: 2,
        },
      },
    });
    expect(f).toMatchObject({
      kind: "multi-enum",
      title: "Tags",
      required: true,
      minItems: 1,
      maxItems: 2,
    });
    expect(f.options?.map((o) => o.value)).toEqual(["x", "y", "z"]);
  });

  it("parses a multi-select enum from array items.anyOf {const,title}", () => {
    const [f] = parseElicitationSchema({
      properties: {
        tags: {
          type: "array",
          items: { anyOf: [{ const: "x", title: "Ex" }, { const: "y" }] },
        },
      },
    });
    expect(f.kind).toBe("multi-enum");
    expect(f.options).toEqual([
      { value: "x", label: "Ex" },
      { value: "y", label: "y" },
    ]);
  });

  it("captures schema defaults", () => {
    const fields = parseElicitationSchema({
      properties: {
        name: { type: "string", default: "ada" },
        age: { type: "integer", default: 36 },
        subscribed: { type: "boolean", default: true },
        color: { type: "string", enum: ["r", "g"], default: "g" },
        tags: { type: "array", items: { enum: ["x", "y"] }, default: ["y"] },
      },
    });
    expect(fields.map((f) => f.default)).toEqual(["ada", 36, true, "g", ["y"]]);
  });

  it("falls back to json for nested/unrecognized (spec-forbidden) shapes", () => {
    const fields = parseElicitationSchema({
      properties: {
        nested: { type: "object", properties: { a: { type: "string" } } },
        objArray: { type: "array", items: { type: "object" } },
        plainArray: { type: "array", items: { type: "string" } },
        untyped: { description: "no type at all" },
        bogus: "not-an-object",
        mixedEnum: { type: "string", enum: ["a", 2] },
        constNonString: { oneOf: [{ const: 1 }, { const: 2 }] },
      },
    });
    expect(fields.map((f) => [f.name, f.kind])).toEqual([
      ["nested", "json"],
      ["objArray", "json"],
      ["plainArray", "json"],
      ["untyped", "json"],
      ["bogus", "json"],
      ["mixedEnum", "json"],
      ["constNonString", "json"],
    ]);
    // json fallbacks still carry their display metadata + required flag.
    expect(fields[3]).toMatchObject({ description: "no type at all" });
  });
});

describe("validateField", () => {
  it("enforces required and allows blank optionals", () => {
    expect(validateField(field({ required: true }), "")).toBe("f is required");
    expect(validateField(field({ required: true }), undefined)).toBe(
      "f is required"
    );
    expect(validateField(field({ required: false }), "")).toBeNull();
  });

  it("uses the title in messages when present", () => {
    expect(validateField(field({ required: true, title: "Name" }), "")).toBe(
      "Name is required"
    );
  });

  it("treats a false boolean as answered", () => {
    expect(
      validateField(field({ kind: "boolean", required: true }), false)
    ).toBeNull();
  });

  it("enforces min/max on numbers", () => {
    const f = field({ kind: "number", minimum: 1, maximum: 10 });
    expect(validateField(f, "0")).toBe("f must be at least 1");
    expect(validateField(f, "11")).toBe("f must be at most 10");
    expect(validateField(f, "5.5")).toBeNull();
    expect(validateField(f, "abc")).toBe("f must be a number");
  });

  it("enforces integer integrality", () => {
    const f = field({ kind: "integer", minimum: 0 });
    expect(validateField(f, "3.5")).toBe("f must be an integer");
    expect(validateField(f, "3")).toBeNull();
    expect(validateField(f, "-1")).toBe("f must be at least 0");
  });

  it("enforces minLength/maxLength", () => {
    const f = field({ minLength: 2, maxLength: 4 });
    expect(validateField(f, "a")).toBe("f must be at least 2 characters");
    expect(validateField(f, "abcde")).toBe("f must be at most 4 characters");
    expect(validateField(f, "abc")).toBeNull();
  });

  it("does not enforce pattern client-side at all", () => {
    // Deliberate: running a server-chosen regex on the UI thread is a hang
    // vector with no safe subset (see the note on `patternHint`). A mismatched
    // value round-trips and the MCP server rejects it; the user still sees the
    // pattern as a hint. An un-compilable pattern is likewise a non-event.
    expect(validateField(field({ pattern: "^ab" }), "xy")).toBeNull();
    expect(validateField(field({ pattern: "^ab" }), "abc")).toBeNull();
    expect(validateField(field({ pattern: "([" }), "anything")).toBeNull();
  });

  it("enforces formats", () => {
    expect(validateField(field({ format: "email" }), "nope")).toBe(
      "f must be a valid email address"
    );
    expect(validateField(field({ format: "email" }), "a@b.co")).toBeNull();
    expect(validateField(field({ format: "uri" }), "not a uri")).toBe(
      "f must be a valid URI"
    );
    expect(
      validateField(field({ format: "uri" }), "https://example.com/x")
    ).toBeNull();
    expect(validateField(field({ format: "date" }), "2024-1-1")).toBe(
      "f must be a valid date"
    );
    expect(validateField(field({ format: "date" }), "2024-01-01")).toBeNull();
    expect(validateField(field({ format: "date-time" }), "2024-01-01")).toBe(
      "f must be a valid date and time"
    );
    // datetime-local (no timezone) and full RFC 3339 both pass.
    expect(
      validateField(field({ format: "date-time" }), "2024-01-01T10:30")
    ).toBeNull();
    expect(
      validateField(field({ format: "date-time" }), "2024-01-01T10:30:00Z")
    ).toBeNull();
  });

  it("rejects enum values outside the offered options", () => {
    const f = field({
      kind: "enum",
      options: [{ value: "a", label: "A" }],
    });
    expect(validateField(f, "b")).toBe("f must be one of the offered options");
    expect(validateField(f, "a")).toBeNull();
  });

  it("enforces multi-enum required/minItems/maxItems", () => {
    expect(
      validateField(field({ kind: "multi-enum", required: true }), [])
    ).toBe("f is required");
    expect(
      validateField(field({ kind: "multi-enum", minItems: 2 }), ["a"])
    ).toBe("Select at least 2 options");
    expect(
      validateField(field({ kind: "multi-enum", maxItems: 1 }), ["a", "b"])
    ).toBe("Select at most 1 option");
    expect(
      validateField(field({ kind: "multi-enum", minItems: 1, maxItems: 2 }), [
        "a",
      ])
    ).toBeNull();
    // An optional multi-enum with no minItems accepts an empty selection.
    expect(validateField(field({ kind: "multi-enum" }), [])).toBeNull();
  });

  it("requires valid JSON in the json fallback", () => {
    expect(validateField(field({ kind: "json" }), "{oops")).toBe(
      "f must be valid JSON"
    );
    expect(validateField(field({ kind: "json" }), '{"a":1}')).toBeNull();
  });
});

describe("initialFormValues", () => {
  it("prefills schema defaults and uses empty values otherwise", () => {
    const fields = parseElicitationSchema({
      properties: {
        name: { type: "string", default: "ada" },
        blank: { type: "string" },
        age: { type: "integer", default: 36 },
        subscribed: { type: "boolean", default: true },
        off: { type: "boolean" },
        color: { type: "string", enum: ["r", "g"], default: "g" },
        tags: { type: "array", items: { enum: ["x", "y"] }, default: ["y"] },
        blob: { type: "object", default: { a: 1 } },
      },
    });
    expect(initialFormValues(fields)).toEqual({
      name: "ada",
      blank: "",
      age: "36",
      subscribed: true,
      // Optional, no schema default → UNANSWERED, not `false`. `false` would be
      // an answer the user never gave; see "unanswered vs answered" below.
      off: undefined,
      color: "g",
      tags: ["y"],
      blob: JSON.stringify({ a: 1 }, null, 2),
    });
  });

  it("drops defaults that are not offered options", () => {
    const fields = parseElicitationSchema({
      properties: {
        color: { type: "string", enum: ["r", "g"], default: "purple" },
        tags: { type: "array", items: { enum: ["x"] }, default: ["x", "zz"] },
      },
    });
    expect(initialFormValues(fields)).toEqual({ color: "", tags: ["x"] });
  });
});

describe("buildElicitationContent", () => {
  it("coerces values into the ElicitResult.content shape", () => {
    const fields = parseElicitationSchema({
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
        score: { type: "number" },
        subscribed: { type: "boolean" },
        color: { type: "string", enum: ["r", "g"] },
        tags: { type: "array", items: { enum: ["x", "y"] } },
      },
    });
    expect(
      buildElicitationContent(fields, {
        name: "ada",
        age: "36",
        score: "1.5",
        subscribed: true,
        color: "g",
        tags: ["x", "y"],
      })
    ).toEqual({
      name: "ada",
      age: 36,
      score: 1.5,
      subscribed: true,
      color: "g",
      tags: ["x", "y"],
    });
  });

  it("omits empty optionals but always reports booleans", () => {
    const fields = parseElicitationSchema({
      properties: {
        name: { type: "string" },
        age: { type: "integer" },
        subscribed: { type: "boolean" },
        color: { type: "string", enum: ["r"] },
        tags: { type: "array", items: { enum: ["x"] } },
        blob: { type: "object" },
      },
    });
    expect(
      buildElicitationContent(fields, {
        name: "",
        age: "",
        subscribed: false,
        color: "",
        tags: [],
        blob: "",
      })
    ).toEqual({ subscribed: false });
  });

  it("ignores values for fields that are not in the schema", () => {
    const fields = parseElicitationSchema({
      properties: { name: { type: "string" } },
    });
    expect(
      buildElicitationContent(fields, { name: "ada", injected: "nope" })
    ).toEqual({ name: "ada" });
  });

  it("parses json fallbacks, re-serializing shapes the spec cannot carry", () => {
    const fields = parseElicitationSchema({
      properties: {
        nested: { type: "object" },
        scalar: { type: "object" },
        list: { type: "object" },
      },
    });
    expect(
      buildElicitationContent(fields, {
        nested: '{"a":1}',
        scalar: "42",
        list: '["a","b"]',
      })
    ).toEqual({
      // A nested object cannot be an ElicitResult.content value -> JSON string.
      nested: '{"a":1}',
      // Parsed values that already fit the shape pass through natively.
      scalar: 42,
      list: ["a", "b"],
    });
  });

  it("keeps unparseable json-fallback text as a raw string", () => {
    const fields = parseElicitationSchema({
      properties: { blob: { type: "object" } },
    });
    expect(buildElicitationContent(fields, { blob: "{oops" })).toEqual({
      blob: "{oops",
    });
  });

  it("drops non-string members from a multi-enum selection", () => {
    const fields = parseElicitationSchema({
      properties: { tags: { type: "array", items: { enum: ["x"] } } },
    });
    expect(buildElicitationContent(fields, { tags: ["x", 3, null] })).toEqual({
      tags: ["x"],
    });
  });
});


describe("pattern handling", () => {
  it("never executes a server-supplied pattern, however catastrophic", () => {
    // An earlier cut tried to allow "safe-looking" patterns. It was bypassable:
    // `a?a?a?...aaa` has no nested-quantifier markers and still took ~150ms at
    // 50 chars, doubling per character. There is no safe subset — so we simply
    // don't run them. This test is a clock, not a shape assertion.
    const evil = "^" + "a?".repeat(60) + "a".repeat(60) + "$";
    const field = {
      name: "x",
      kind: "string" as const,
      required: false,
      pattern: evil,
    };

    const started = Date.now();
    const result = validateField(field, "a".repeat(55) + "X");
    const elapsed = Date.now() - started;

    // Would be seconds if we compiled and ran it.
    expect(elapsed).toBeLessThan(50);
    // And it must not fabricate a failure either — the server validates.
    expect(result).toBeNull();
  });

  it("surfaces the pattern to the user as a hint instead", () => {
    expect(
      patternHint({
        name: "x",
        kind: "string",
        required: false,
        pattern: "^[a-z]+$",
      }),
    ).toBe("Must match: ^[a-z]+$");
  });

  it("has no hint when the schema declares no pattern", () => {
    expect(
      patternHint({ name: "x", kind: "string", required: false }),
    ).toBeUndefined();
  });
});

describe("__proto__ field names", () => {
  // Built via JSON.parse, exactly how a schema reaches us: JSON.parse creates a
  // real own `__proto__` key, whereas an object *literal* would just set the
  // prototype and the field would silently not exist. (Writing this test the
  // literal way hid the bug entirely.)
  const schema = JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"string"},"safe":{"type":"string"}},"required":["__proto__"]}'
  );

  it("parses a __proto__ property as a real field", () => {
    const fields = parseElicitationSchema(schema);
    expect(fields.map((f) => f.name)).toContain("__proto__");
  });

  it("keeps a __proto__ answer as an own key, not a prototype mutation", () => {
    // A plain object would swallow this assignment and the server would never
    // receive the answer to a field it marked required.
    const fields = parseElicitationSchema(schema);
    const values = initialFormValues(fields);
    values["__proto__"] = "hello";
    const content = buildElicitationContent(fields, values);

    expect(Object.prototype.hasOwnProperty.call(content, "__proto__")).toBe(true);
    expect(content["__proto__"]).toBe("hello");
    expect(Object.keys(content)).toContain("__proto__");
    // And nothing leaked onto Object.prototype.
    expect(({} as any).__proto__).not.toBe("hello");
  });

  it("initialFormValues returns a null-prototype map", () => {
    expect(Object.getPrototypeOf(initialFormValues([]))).toBeNull();
  });
});


describe("unanswered vs answered", () => {
  const boolSchema = (required: boolean) => ({
    type: "object",
    properties: { subscribe: { type: "boolean", title: "Subscribe" } },
    ...(required ? { required: ["subscribe"] } : {}),
  });

  it("omits an optional boolean the user never touched", () => {
    // Every boolean used to initialize to `false` and always serialize, so an
    // untouched optional checkbox told the server "no" — an answer the user
    // never gave. Absent and false are different claims.
    const fields = parseElicitationSchema(boolSchema(false));
    const values = initialFormValues(fields);

    expect(values.subscribe).toBeUndefined();
    expect(buildElicitationContent(fields, values)).toEqual({});
  });

  it("sends false once the user actually answers false", () => {
    // Toggling on then off is a real answer and must reach the server.
    const fields = parseElicitationSchema(boolSchema(false));
    const values = { ...initialFormValues(fields), subscribe: false };

    expect(buildElicitationContent(fields, values)).toEqual({ subscribe: false });
  });

  it("still sends a required boolean, and honors a schema default", () => {
    // Required means the server wants a value; unchecked is a legitimate one.
    const requiredFields = parseElicitationSchema(boolSchema(true));
    expect(
      buildElicitationContent(requiredFields, initialFormValues(requiredFields)),
    ).toEqual({ subscribe: false });

    const defaulted = parseElicitationSchema({
      type: "object",
      properties: { subscribe: { type: "boolean", default: true } },
    });
    expect(
      buildElicitationContent(defaulted, initialFormValues(defaulted)),
    ).toEqual({ subscribe: true });
  });

  const multiSchema = (required: boolean) => ({
    type: "object",
    properties: {
      colors: {
        type: "array",
        minItems: 2,
        items: { type: "string", enum: ["red", "green", "blue"] },
      },
    },
    ...(required ? { required: ["colors"] } : {}),
  });

  it("lets an optional multi-select stay empty despite minItems", () => {
    // minItems constrains an ANSWER, not the choice not to answer. Enforcing it
    // on an empty optional field made submit unreachable for a value we would
    // never have sent anyway.
    const [field] = parseElicitationSchema(multiSchema(false));
    expect(validateField(field, [])).toBeNull();
    expect(validateField(field, undefined)).toBeNull();
  });

  it("still enforces minItems once an optional multi-select is answered", () => {
    const [field] = parseElicitationSchema(multiSchema(false));
    expect(validateField(field, ["red"])).toBe("Select at least 2 options");
    expect(validateField(field, ["red", "blue"])).toBeNull();
  });

  it("still requires a required multi-select", () => {
    const [field] = parseElicitationSchema(multiSchema(true));
    expect(validateField(field, [])).toBe("colors is required");
  });
});
