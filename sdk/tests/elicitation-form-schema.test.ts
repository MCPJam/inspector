import { describe, expect, it } from "vitest";
import { selectElicitationFormSchema } from "../src/mcp-client-manager/elicitation-form-schema.js";
import {
  MrtrInputValidationError,
  validateRoundResponses,
  type MrtrOperationState,
} from "../src/mcp-client-manager/mrtr-driver.js";

const empty = { type: "object", properties: {} };
const extended = {
  type: "object",
  required: ["refs"],
  properties: {
    refs: { type: "array", items: { type: "string", format: "uri" } },
  },
};
const withExtension = (extension: unknown) => ({
  mode: "form",
  message: "Pick",
  requestedSchema: empty,
  _meta: { "openai/elicitation": extension },
});

describe("selectElicitationFormSchema", () => {
  it("uses the extension schema when it is present and extension forms are live", () => {
    expect(
      selectElicitationFormSchema(
        withExtension({ requestedSchema: extended }),
        { extensionForms: true }
      )
    ).toEqual({
      kind: "schema",
      source: "openai/elicitation",
      schema: extended,
    });
  });

  it.each([
    ["no schema", {}],
    ["a non-object schema", { requestedSchema: { type: "string" } }],
    ["no properties", { requestedSchema: { type: "object" } }],
    ["a non-record extension", "schema"],
  ])(
    "refuses %s instead of falling back to the empty core form",
    (_, value) => {
      expect(
        selectElicitationFormSchema(withExtension(value), {
          extensionForms: true,
        })
      ).toEqual({ kind: "unsupported", reason: "extension-schema-invalid" });
    }
  );

  it("refuses an extension form when this request has no extension forms", () => {
    expect(
      selectElicitationFormSchema(
        withExtension({ requestedSchema: extended }),
        { extensionForms: false }
      )
    ).toEqual({ kind: "unsupported", reason: "extension-forms-off" });
  });

  it("keeps a plain MCP form's core schema, including an empty confirmation", () => {
    for (const extensionForms of [true, false])
      expect(
        selectElicitationFormSchema(
          { mode: "form", requestedSchema: empty },
          { extensionForms }
        )
      ).toEqual({ kind: "schema", source: "core", schema: empty });
    expect(
      selectElicitationFormSchema(undefined, { extensionForms: true })
    ).toEqual({ kind: "schema", source: "core", schema: undefined });
  });
});

describe("validateRoundResponses with a form schema selector", () => {
  const state = {
    pendingInputRequests: {
      form: {
        method: "elicitation/create",
        params: withExtension({ requestedSchema: extended }),
      },
    },
  } as unknown as MrtrOperationState;
  const answer = {
    form: { action: "accept", content: { refs: ["fixture://a"] } },
  };
  const strictKeys = (schema: unknown, content: unknown) => {
    const allowed = Object.keys(
      (schema as { properties: Record<string, unknown> }).properties
    );
    const extra = Object.keys(content as object).filter(
      (key) => !allowed.includes(key)
    );
    return extra.length
      ? { valid: false, error: `unexpected ${extra.join(",")}` }
      : { valid: true };
  };

  it("validates against the core schema by default, which rejects extended content", () => {
    expect(() => validateRoundResponses(state, answer, strictKeys)).toThrow(
      MrtrInputValidationError
    );
  });

  it("validates against the selected schema when a selector is injected", () => {
    const select = (params: Record<string, unknown> | undefined) => {
      const selected = selectElicitationFormSchema(params, {
        extensionForms: true,
      });
      if (selected.kind === "unsupported") throw new Error(selected.reason);
      return selected.schema;
    };
    expect(() =>
      validateRoundResponses(state, answer, strictKeys, select)
    ).not.toThrow();
  });

  it("lets a selector refuse the round", () => {
    expect(() =>
      validateRoundResponses(state, answer, strictKeys, () => {
        throw new Error("refused");
      })
    ).toThrow("refused");
  });
});
