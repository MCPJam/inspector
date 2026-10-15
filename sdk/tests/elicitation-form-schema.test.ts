import { describe, expect, it } from "vitest";
import { selectElicitationFormSchema } from "../src/mcp-client-manager/elicitation-form-schema.js";
import {
  MrtrInputValidationError,
  runInputRequiredOperation,
  validateRoundResponses,
  type ElicitationFormSchemaSelector,
  type MrtrLegSender,
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

describe("runInputRequiredOperation with a form schema selector", () => {
  // One extension form, then the tool's result once a valid answer arrives.
  const sender = (): MrtrLegSender => {
    let leg = 0;
    return async () =>
      (leg++ === 0
        ? {
            resultType: "input_required",
            inputRequests: {
              form: {
                method: "elicitation/create",
                params: withExtension({ requestedSchema: extended }),
              },
            },
          }
        : { content: [{ type: "text", text: "done" }] }) as never;
  };
  const answerless = async () => ({
    form: { action: "accept", content: { other: "x" } },
  });
  const requiresRefs = (schema: unknown, content: unknown) => {
    const required =
      (schema as { required?: string[] }).required ?? ([] as string[]);
    const missing = required.filter((key) => !(key in (content as object)));
    return missing.length
      ? { valid: false, error: `missing ${missing.join(",")}` }
      : { valid: true };
  };
  const run = (selectFormSchema?: ElicitationFormSchemaSelector) =>
    runInputRequiredOperation({
      method: "tools/call",
      params: { name: "t" },
      sender: sender(),
      collectInput: answerless,
      validateContent: requiresRefs,
      selectFormSchema,
    });

  it("accepts an in-process answer the empty core schema allows when no selector is set", async () => {
    await expect(run()).resolves.toEqual({
      content: [{ type: "text", text: "done" }],
    });
  });

  it("refuses that answer against the selected extension schema before the retry", async () => {
    await expect(
      run((params) => {
        const selected = selectElicitationFormSchema(params, {
          extensionForms: true,
        });
        if (selected.kind === "unsupported") throw new Error(selected.reason);
        return selected.schema;
      })
    ).rejects.toThrow(MrtrInputValidationError);
  });
});
