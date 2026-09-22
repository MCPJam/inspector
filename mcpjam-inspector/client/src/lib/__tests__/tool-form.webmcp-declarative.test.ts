/**
 * The invoke form against a schema the BROWSER wrote.
 *
 * `tool-form.ts` was built for schemas MCP servers publish. A declarative WebMCP
 * tool's schema comes from somewhere else entirely: Blink derives it from a
 * `<form>`'s own controls, and until the declarative fixtures existed nothing
 * had ever put one through this code. The constant below is that schema,
 * captured verbatim from Chromium 151.0.7922.34 against the `typed_fields`
 * fixture (`server/services/webmcp-inspector/__tests__/fixture-page.ts`) and
 * re-derived by the spike's "derives the inputSchema" tests — so if a Chromium
 * bump changes what the browser writes, the spike says so and this file is the
 * next thing to re-check.
 */
import { describe, it, expect } from "vitest";
import { generateFormFieldsFromSchema } from "../tool-form";

/** Verbatim `inputSchema` for the `typed_fields` declarative fixture tool. */
const BLINK_DERIVED_SCHEMA = {
  "type": "object",
  "properties": {
    "text": {
      "type": "string"
    },
    "num": {
      "type": "number",
      "minimum": 1,
      "maximum": 99,
      "multipleOf": 0.5
    },
    "range": {
      "type": "number",
      "minimum": 0,
      "maximum": 10,
      "multipleOf": 1
    },
    "date": {
      "type": "string",
      "format": "date",
      "description": "Dates MUST be provided in 'YYYY-MM-DD' format."
    },
    "time": {
      "type": "string",
      "format": "^([01][0-9]|2[0-3]):[0-5][0-9]$"
    },
    "datetime": {
      "type": "string",
      "format": "^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$"
    },
    "month": {
      "type": "string",
      "format": "^[0-9]{4}-(0[1-9]|1[0-2])$"
    },
    "week": {
      "type": "string",
      "format": "^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$"
    },
    "color": {
      "type": "string",
      "format": "^#[0-9a-zA-Z]{6}$"
    },
    "search": {
      "type": "string",
      "pattern": "[a-z]+"
    },
    "agree": {
      "type": "boolean"
    },
    "tier": {
      "type": "string",
      "anyOf": [
        {
          "type": "string",
          "const": "basic"
        },
        {
          "type": "string",
          "const": "pro"
        }
      ],
      "enum": [
        "basic",
        "pro"
      ]
    },
    "note": {
      "type": "string"
    },
    "ship": {
      "type": "string",
      "anyOf": [
        {
          "type": "string",
          "const": "standard",
          "title": "standard"
        },
        {
          "type": "string",
          "const": "express",
          "title": "express"
        }
      ],
      "enum": [
        "standard",
        "express"
      ]
    },
    "addons": {
      "type": "array",
      "items": {
        "type": "string",
        "anyOf": [
          {
            "type": "string",
            "const": "gift",
            "title": "gift"
          },
          {
            "type": "string",
            "const": "rush",
            "title": "rush"
          }
        ],
        "enum": [
          "gift",
          "rush"
        ]
      },
      "uniqueItems": true
    }
  },
  "required": []
} as const;

function fields() {
  return new Map(
    generateFormFieldsFromSchema(BLINK_DERIVED_SCHEMA).map((field) => [
      field.name,
      field,
    ]),
  );
}

describe("tool-form against a Blink-derived declarative schema", () => {
  it("builds a field for every control on the form", () => {
    expect([...fields().keys()]).toEqual(
      Object.keys(BLINK_DERIVED_SCHEMA.properties),
    );
  });

  it("carries numeric bounds through, so the form can validate them", () => {
    // `min`/`max` on an `<input type=number>` arrive as real JSON Schema
    // constraints, and the form is the only place a person sees them.
    expect(fields().get("num")).toMatchObject({
      type: "number",
      minimum: 1,
      maximum: 99,
    });
    expect(fields().get("range")).toMatchObject({
      type: "number",
      minimum: 0,
      maximum: 10,
    });
  });

  it("renders a select and a radio group as enums, first option selected", () => {
    // Blink writes these as `enum` PLUS an `anyOf` of consts — the same shape
    // some Python MCP servers emit, which this module already understood.
    expect(fields().get("ship")).toMatchObject({
      type: "enum",
      enum: ["standard", "express"],
      value: "standard",
    });
    expect(fields().get("tier")).toMatchObject({
      type: "enum",
      enum: ["basic", "pro"],
    });
  });

  it("gives a checkbox a real boolean default rather than an empty string", () => {
    expect(fields().get("agree")).toMatchObject({ type: "boolean", value: false });
  });

  it("treats a multi-select as an array", () => {
    expect(fields().get("addons")).toMatchObject({ type: "array", value: [] });
  });

  it("keeps the date input's guidance, which the model is meant to read", () => {
    // The ONE named JSON Schema format Blink emits, and it comes with prose.
    expect(fields().get("date")?.description).toContain("YYYY-MM-DD");
  });

  it("does not mistake a regex in `format` for a validation pattern", () => {
    // WORTH PINNING because it looks like a bug and is not ours: for every
    // date-ish input except `date`, Blink puts a REGEX in `format` — which is
    // not what `format` means in JSON Schema, and is not `pattern`. This module
    // reads `pattern` and ignores `format`, so those fields render as plain
    // strings with no constraint. A future change that started reading `format`
    // as a pattern would have to handle `date` (a format NAME) separately.
    expect(fields().get("time")?.pattern).toBeUndefined();
    expect(fields().get("datetime")?.pattern).toBeUndefined();
    expect(String(BLINK_DERIVED_SCHEMA.properties.time.format)).toMatch(/^\^/);
    // A real `pattern` attribute DOES come through.
    expect(fields().get("search")?.pattern).toBe("[a-z]+");
  });

  it("marks nothing required when the form requires nothing", () => {
    expect([...fields().values()].every((field) => !field.required)).toBe(true);
  });
});
