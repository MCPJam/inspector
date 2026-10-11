import { describe, expect, it } from "vitest";
import { OpenAIFormResultSchema } from "@openai/mcp-extensions/server";
import {
  buildPluginFormContent,
  compilePluginForm,
  initialPluginFormValues,
  ownedPluginFormProfile,
  pluginFormPreview,
  pluginFormThumbnailSource,
  pluginFormUnsupportedDiagnostic,
  validatePluginFormContent,
  type PluginFormProfile,
} from "../plugin-extensions/form-plan.js";
import { openAILegacyFormSchemas } from "../plugin-extensions/wire.js";

/**
 * OpenAI MCP Extensions, "OpenAI Form Elicitation" through "Previews": one
 * describe per rule, named after the spec. The client card and the wires
 * have their own conformance files beside their code.
 */
const host: PluginFormProfile = {
  fileResources: true,
  origin: "server",
  userResources: true,
  userResourceKinds: ["file", "directory"],
  previews: true,
  previewKinds: ["resource_link", "mcp_app_tool"],
};
const form = (properties: Record<string, unknown>, required?: string[]) => ({
  type: "object",
  ...(required ? { required } : {}),
  properties,
});
function refusal(raw: unknown, profile = host) {
  try {
    compilePluginForm(raw, profile);
  } catch (error) {
    return pluginFormUnsupportedDiagnostic(error, raw);
  }
  throw new Error("The form was not refused");
}

describe("2. openai/elicitation/create is a superset of elicitation/create", () => {
  const primitives = form(
    {
      email: { type: "string", format: "email", default: "a@b.co" },
      site: { type: "string", format: "uri" },
      day: { type: "string", format: "date" },
      at: { type: "string", format: "date-time" },
      name: { type: "string", minLength: 2, maxLength: 4, title: "Name" },
      ratio: { type: "number", minimum: 1, maximum: 3 },
      count: { type: "integer", minimum: 0, default: 2 },
      ok: { type: "boolean", default: true },
      plain: { type: "string", enum: ["a", "b"] },
      legacy: { type: "string", enum: ["a", "b"], enumNames: ["A", "B"] },
      titled: { type: "string", oneOf: [{ const: "x", title: "X" }] },
      many: {
        type: "array",
        items: { type: "string", enum: ["p", "q"] },
        minItems: 1,
        maxItems: 2,
        default: ["p"],
      },
      manyTitled: {
        type: "array",
        items: { anyOf: [{ const: "p", title: "P" }] },
      },
    },
    ["email"],
  );

  it("accepts every MCP primitive schema, with its defaults", () => {
    const plan = compilePluginForm(primitives, host);
    expect(plan.fields).toHaveLength(13);
    expect(initialPluginFormValues(plan)).toMatchObject({
      email: "a@b.co",
      count: 2,
      ok: true,
      many: ["p"],
    });
  });

  it.each([
    [{ email: "not-an-email" }, "email"],
    [{ email: "a@b.co", site: "not a uri" }, "site"],
    [{ email: "a@b.co", day: "2026-13-45" }, "day"],
    [{ email: "a@b.co", at: "yesterday" }, "at"],
    [{ email: "a@b.co", name: "x" }, "name"],
    [{ email: "a@b.co", name: "xxxxx" }, "name"],
    [{ email: "a@b.co", ratio: 5 }, "ratio"],
    [{ email: "a@b.co", count: 1.5 }, "count"],
    [{ email: "a@b.co", plain: "z" }, "plain"],
    [{ email: "a@b.co", titled: "y" }, "titled"],
    [{ email: "a@b.co", many: [] }, "many"],
    [{ email: "a@b.co", manyTitled: ["z"] }, "manyTitled"],
    [{}, "email"],
  ])("enforces the standard constraints: %j", (content, field) => {
    const result = validatePluginFormContent(
      compilePluginForm(primitives, host),
      content,
    );
    expect(result.valid).toBe(false);
    expect(Object.keys(result.errors)).toEqual([field]);
  });

  it("answers with the elicitation/create result shape", () => {
    const plan = compilePluginForm(primitives, host);
    const content = buildPluginFormContent(plan, {
      ...initialPluginFormValues(plan),
      ratio: "2.5",
      legacy: "b",
    });
    expect(content).toEqual({
      email: "a@b.co",
      ratio: 2.5,
      count: 2,
      ok: true,
      legacy: "b",
      many: ["p"],
    });
    expect(validatePluginFormContent(plan, content).valid).toBe(true);
    for (const result of [
      { action: "accept", content },
      { action: "decline" },
      { action: "cancel" },
    ])
      expect(OpenAIFormResultSchema.safeParse(result).success).toBe(true);
  });

  it("takes the request envelope with or without mode, like elicitation/create", () => {
    const params = { message: "Choose", requestedSchema: primitives };
    expect(openAILegacyFormSchemas.params.safeParse(params).success).toBe(true);
    expect(
      openAILegacyFormSchemas.params.safeParse({ ...params, mode: "form" })
        .success,
    ).toBe(true);
    expect(
      openAILegacyFormSchemas.params.safeParse({ ...params, mode: "url" })
        .success,
    ).toBe(false);
  });
});

describe("3. Forms containing unsupported input types are reported as unsupported, not partially displayed", () => {
  it.each([
    [
      "an unknown x-openai-input type",
      { type: "string", "x-openai-input": { type: "date-range" } },
      'It asks for a "date-range" input',
    ],
    [
      "an unknown OpenAI keyword",
      { type: "string", "x-openai-color": { palette: "warm" } },
      'It uses "x-openai-color"',
    ],
    [
      "an unsupported field type",
      { type: "object", properties: {} },
      'It has the field type "object"',
    ],
    [
      "a constraint the field type lacks",
      { type: "integer", pattern: "^1" },
      'It uses "pattern"',
    ],
  ])("refuses the whole form for %s, naming the field", (_, field, reason) => {
    const raw = form({ name: { type: "string" }, odd: field });
    const diagnostic = refusal(raw);
    expect(diagnostic).toMatchObject({
      level: "error",
      details: { field: "odd" },
    });
    expect(String(diagnostic.details?.reason)).toContain(reason);
  });

  it("keeps annotation-only keywords, which never change what is asked", () => {
    expect(
      compilePluginForm(
        {
          ...form({ name: { type: "string", examples: ["x"] } }),
          title: "Request",
          additionalProperties: false,
        },
        host,
      ).fields,
    ).toHaveLength(1);
  });
});

describe("4. Servers MAY add pattern to StringSchema", () => {
  const plan = compilePluginForm(
    form({
      part: { type: "string", format: "uri", pattern: "^(cad|file):" },
      tags: { type: "array", items: { type: "string", pattern: "^[a-z]+$" } },
    }),
    host,
  );
  it("matches anywhere the pattern allows, as JSON Schema does", () => {
    expect(
      validatePluginFormContent(plan, {
        part: "cad://parts/hex-bolt",
        tags: ["ok"],
      }).valid,
    ).toBe(true);
  });
  it.each([
    [{ part: "https://example.com/hex-bolt" }, "part"],
    [{ tags: ["ok", "Not OK"] }, "tags"],
  ])("refuses %j with a plain error", (content, field) => {
    expect(validatePluginFormContent(plan, content).errors).toEqual({
      [field]: "Does not match the required pattern",
    });
  });
});

describe("5. Titled const options support an optional description", () => {
  it("keeps descriptions on single, multi and suggested options", () => {
    const option = {
      const: "hex-bolt",
      title: "M6 hex bolt",
      description: "A fastener for the main joint.",
    };
    const plan = compilePluginForm(
      form({
        one: { type: "string", oneOf: [option] },
        many: { type: "array", items: { anyOf: [option] } },
        free: { type: "string", "x-openai-suggestions": [option] },
      }),
      host,
    );
    expect(JSON.stringify(plan.schema).match(/main joint/g)).toHaveLength(3);
  });
});

describe("6. Thumbnails", () => {
  it("MUST be an HTTPS URL or a base64 image data URI", () => {
    expect(
      pluginFormThumbnailSource({ src: "https://example.com/washer.png" }),
    ).toBe("https://example.com/washer.png");
    expect(
      pluginFormThumbnailSource({ src: "data:image/png;base64,iVBORw0KGgo=" }),
    ).toBeDefined();
    for (const src of [
      "http://example.com/washer.png",
      "data:image/png,raw",
      "javascript:alert(1)",
      "/relative.png",
    ])
      expect(pluginFormThumbnailSource({ src })).toBeUndefined();
  });
  it("shows the fallback image and logs, never refusing the form", () => {
    const plan = compilePluginForm(
      form({
        part: {
          type: "string",
          oneOf: [
            {
              const: "hex-bolt",
              title: "M6 hex bolt",
              "x-openai-thumbnail": { src: "http://example.com/hex-bolt.png" },
            },
            { const: "washer", title: "M6 washer" },
          ],
        },
      }),
      host,
    );
    expect(plan.fields).toHaveLength(1);
    expect(plan.diagnostics?.map(({ code }) => code)).toEqual([
      "PLUGIN_FORM_THUMBNAIL_SOURCE_INVALID",
      "PLUGIN_FORM_THUMBNAIL_PARTIAL",
    ]);
  });
});

describe("7. The same field constraints apply to suggested and entered values", () => {
  const plan = compilePluginForm(
    form({
      part: {
        type: "string",
        minLength: 1,
        pattern: "^[a-z-]+$",
        "x-openai-suggestions": [{ const: "hex-bolt", title: "M6 hex bolt" }],
      },
      accessories: {
        type: "array",
        minItems: 1,
        maxItems: 3,
        uniqueItems: true,
        items: {
          type: "string",
          maxLength: 14,
          format: "email",
          "x-openai-suggestions": [{ const: "a@b.co", title: "A" }],
        },
      },
      extras: {
        type: "array",
        items: {
          type: "string",
          minLength: 3,
          "x-openai-suggestions": [{ const: "washer", title: "M6 washer" }],
        },
      },
    }),
    host,
  );
  it("returns suggested and entered values together", () => {
    const content = {
      part: "custom-part",
      extras: ["washer", "custom-spacer", "custom-gasket"],
    };
    expect(validatePluginFormContent(plan, content).valid).toBe(true);
  });
  it.each([
    [{ part: "" }, "part"],
    [{ part: "Not-Allowed" }, "part"],
    [{ accessories: [] }, "accessories"],
    [{ accessories: ["a@b.co", "a@b.co"] }, "accessories"],
    [{ accessories: ["a@b.co", "c@d.co", "e@f.co", "g@h.co"] }, "accessories"],
    [{ accessories: ["not-an-email"] }, "accessories"],
    [{ accessories: ["very-long@example.com"] }, "accessories"],
    [{ extras: ["washer", "no"] }, "extras"],
  ])("refuses %j", (content, field) => {
    expect(Object.keys(validatePluginFormContent(plan, content).errors)).toEqual(
      [field],
    );
  });
});

describe("8. Resource selection", () => {
  const options = [
    { uri: "cad://parts/hex-bolt", name: "hex-bolt", title: "M6 hex bolt" },
    { uri: "cad://parts/washer", name: "washer", title: "M6 washer" },
  ];
  const single = (input: Record<string, unknown>, extra = {}) =>
    form({
      part: {
        type: "string",
        format: "uri",
        "x-openai-input": { type: "resource", options, ...input },
        ...extra,
      },
    });
  const multi = (input: Record<string, unknown>, extra = {}) =>
    form({
      parts: {
        type: "array",
        items: { type: "string", format: "uri" },
        "x-openai-input": { type: "resource", options, ...input },
        ...extra,
      },
    });

  it("single-select submits a URI string; multi-select an array of URIs", () => {
    expect(
      validatePluginFormContent(compilePluginForm(single({}), host), {
        part: "cad://parts/washer",
      }).valid,
    ).toBe(true);
    expect(
      validatePluginFormContent(compilePluginForm(multi({}), host), {
        parts: ["cad://parts/washer", "cad://parts/hex-bolt"],
      }).valid,
    ).toBe(true);
    expect(
      validatePluginFormContent(compilePluginForm(single({}), host), {
        part: ["cad://parts/washer"],
      }).valid,
    ).toBe(false);
  });

  it('still accepts the deprecated type: "file" alias', () => {
    expect(compilePluginForm(single({ type: "file" }), host).fields).toHaveLength(
      1,
    );
  });

  it.each([
    [
      "selection on a single-select field",
      single({ selection: "explicit" }),
      "selection is only allowed on multi-select",
    ],
    [
      "a default that isn't one of the options",
      single({}, { default: "cad://parts/missing" }),
      "Defaults must name supplied resources",
    ],
    [
      "a default with implicit selection",
      multi({ selection: "implicit" }, { default: ["cad://parts/washer"] }),
      "Implicit selection cannot specify a default",
    ],
  ])("refuses %s with the reason", (_, raw, reason) => {
    expect(String(refusal(raw).details?.reason)).toContain(reason);
  });

  it("implicit selection starts with every option and always takes uploads", () => {
    const plan = compilePluginForm(multi({ selection: "implicit" }), host);
    expect(initialPluginFormValues(plan)).toEqual({
      parts: ["cad://parts/hex-bolt", "cad://parts/washer"],
    });
    // Added files are any URI the host issued; what remains is the answer.
    expect(
      validatePluginFormContent(plan, {
        parts: ["cad://parts/washer", "mcpjam-form-file://upload"],
      }).valid,
    ).toBe(true);
    // Without an upload service the whole form is refused, never shown
    // without its upload input.
    expect(
      refusal(multi({ selection: "implicit" }), {
        ...host,
        userResources: false,
      }).code,
    ).toBe("PLUGIN_FORM_RESOURCE_SERVICE_UNAVAILABLE");
  });

  it("explicit selection without userOptions takes only the offered URIs", () => {
    const plan = compilePluginForm(multi({ selection: "explicit" }), host);
    expect(
      validatePluginFormContent(plan, { parts: ["file:///forged"] }).valid,
    ).toBe(false);
    const uploads = compilePluginForm(
      multi({ selection: "explicit", userOptions: { accept: [".stl"] } }),
      host,
    );
    expect(
      validatePluginFormContent(uploads, { parts: ["file:///added.stl"] })
        .valid,
    ).toBe(true);
  });

  it("refuses a userOptions kind the host can't add", () => {
    expect(
      refusal(single({ userOptions: { kind: "directory" } }), {
        ...host,
        userResourceKinds: ["file"],
      }).code,
    ).toBe("PLUGIN_FORM_RESOURCE_SERVICE_UNAVAILABLE");
  });

  it("forms from MCP Apps allow only explicit selection without uploads while File resources is off", () => {
    const app = ownedPluginFormProfile(false, "mcp-app", true);
    expect(compilePluginForm(multi({ selection: "explicit" }), app).fields)
      .toHaveLength(1);
    for (const raw of [
      multi({ selection: "implicit" }),
      multi({ selection: "explicit", userOptions: {} }),
      single({ userOptions: { kind: "file" } }),
    ])
      expect(refusal(raw, app).code).toBe("PLUGIN_FORM_WEB_UPLOAD_UNSUPPORTED");
    // The toggle on, or a form the server asked for, takes uploads.
    expect(
      compilePluginForm(
        multi({ selection: "implicit" }),
        ownedPluginFormProfile(true, "mcp-app", true),
      ).fields,
    ).toHaveLength(1);
    expect(
      compilePluginForm(
        multi({ selection: "implicit" }),
        ownedPluginFormProfile(false, "server", true),
      ).fields,
    ).toHaveLength(1);
  });

  it("keeps resource option thumbnails and previews", () => {
    const plan = compilePluginForm(
      single({
        options: [
          {
            ...options[0],
            _meta: {
              "openai/thumbnail": { src: "https://example.com/hex-bolt.png" },
              "openai/preview": {
                target: { type: "mcp_app_tool", name: "cad.open" },
              },
            },
          },
        ],
      }),
      host,
    );
    expect(plan.diagnostics).toBeUndefined();
    expect(JSON.stringify(plan.schema)).toContain("openai/thumbnail");
  });
});

describe("9. Previews", () => {
  it("parses both targets; mcp_app_tool arguments are optional", () => {
    expect(
      pluginFormPreview({
        _meta: { "openai/preview": { target: { type: "mcp_app_tool", name: "cad.open" } } },
      }),
    ).toEqual({ type: "mcp_app_tool", name: "cad.open" });
    expect(
      pluginFormPreview({
        _meta: {
          "openai/preview": {
            target: {
              type: "resource_link",
              uri: "cad://parts/hex-bolt",
              name: "M6 hex bolt",
            },
          },
        },
      }),
    ).toMatchObject({ type: "resource_link", uri: "cad://parts/hex-bolt" });
  });
  it("drops a blank-named or unrenderable preview with a Logs entry, keeping the form", () => {
    const raw = form({
      part: {
        type: "string",
        format: "uri",
        "x-openai-input": {
          type: "resource",
          options: [
            {
              uri: "cad://parts/hex-bolt",
              name: "hex-bolt",
              _meta: {
                "openai/preview": {
                  target: { type: "mcp_app_tool", name: "  " },
                },
              },
            },
          ],
        },
      },
    });
    const plan = compilePluginForm(raw, host);
    expect(plan.fields).toHaveLength(1);
    expect(plan.diagnostics?.[0]?.code).toBe("PLUGIN_FORM_PREVIEW_INVALID");
  });
});
