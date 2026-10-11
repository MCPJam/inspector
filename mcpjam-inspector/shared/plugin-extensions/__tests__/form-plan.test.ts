import { describe, expect, it } from "vitest";
import {
  compilePluginForm,
  decodePrivatePluginFormSchema,
  ownedPluginFormProfile,
  initialPluginFormValues,
  buildPluginFormContent,
  validatePluginFormContent,
  pluginFormPreview,
  pluginFormUnsupportedDiagnostic,
} from "../form-plan.js";
const profile = {
  fileResources: true,
  origin: "server",
  userResources: false,
  previews: false,
} as const;
const schema = {
  type: "object",
  required: ["code", "files"],
  properties: {
    code: {
      type: "string",
      pattern: "^[A-Z]{2}$",
      "x-openai-suggestions": [
        { const: "AB", title: "Code AB", description: "Suggestion" },
      ],
    },
    tags: {
      type: "array",
      uniqueItems: true,
      items: {
        type: "string",
        minLength: 2,
        "x-openai-suggestions": [{ const: "bolt", title: "Bolt" }],
      },
    },
    files: {
      type: "array",
      minItems: 1,
      items: { type: "string", format: "uri" },
      "x-openai-input": {
        type: "resource",
        options: [{ uri: "fixture://one", name: "One" }],
      },
    },
  },
};
describe("whole plugin form plans", () => {
  it("decodes legal schema property names from bounded private JSON", () => {
    const value = {
      type: "object",
      properties: { ['key"\\\nπ\0']: { type: "string" } },
    };
    expect(decodePrivatePluginFormSchema(JSON.stringify(value))).toEqual(value);
  });
  it.each([
    undefined,
    {},
    "{",
    "[]",
    "null",
    "false",
    '"scalar"',
    " ".repeat(256 * 1024 + 1),
  ])("refuses an invalid private schema before mounting (%#)", (value) => {
    expect(() => decodePrivatePluginFormSchema(value)).toThrow(
      "PLUGIN_FORM_UNAVAILABLE",
    );
  });
  it.each(["string", "array"])(
    "bounds every declared plain %s enum before presentation",
    (type) => {
      const values = Array.from({ length: 129 }, (_, index) => String(index));
      const field =
        type === "string"
          ? { type, enum: values }
          : { type, items: { type: "string", enum: values } };
      expect(() =>
        compilePluginForm(
          { type: "object", properties: { choice: field } },
          profile,
        ),
      ).toThrow("PLUGIN_FORM_TOO_LARGE");
    },
  );
  it("admits bounded local file/directory ports and preserves whole-form web/App refusal", () => {
    const raw = (kind: "file" | "directory") => ({
      type: "object",
      properties: {
        file: {
          type: "string",
          format: "uri",
          "x-openai-input": {
            type: "resource",
            userOptions: { kind },
            options: [],
          },
        },
      },
    });
    expect(
      compilePluginForm(
        raw("file"),
        ownedPluginFormProfile(true, "server", true),
      ).fields,
    ).toHaveLength(1);
    expect(
      compilePluginForm(
        raw("directory"),
        ownedPluginFormProfile(true, "server", true),
      ).fields,
    ).toHaveLength(1);
    expect(() =>
      compilePluginForm(raw("directory"), {
        ...ownedPluginFormProfile(true, "server", true),
        userResourceKinds: ["file"],
      }),
    ).toThrow("PLUGIN_FORM_RESOURCE_SERVICE_UNAVAILABLE");
    expect(() =>
      compilePluginForm(
        raw("file"),
        ownedPluginFormProfile(true, "server"),
      ),
    ).toThrow("PLUGIN_FORM_RESOURCE_SERVICE_UNAVAILABLE");
    expect(() =>
      compilePluginForm(
        raw("file"),
        ownedPluginFormProfile(false, "mcp-app", true),
      ),
    ).toThrow("PLUGIN_FORM_WEB_UPLOAD_UNSUPPORTED");
  });
  it("bounds schema UTF-8 bytes rather than JavaScript character count", () => {
    const value = (count: number) => ({
      type: "object",
      properties: {
        note: { type: "string", description: "π".repeat(count) },
      },
    });
    expect(compilePluginForm(value(130000), profile).schema).toEqual(
      value(130000),
    );
    expect(() => compilePluginForm(value(131072), profile)).toThrow(
      "PLUGIN_FORM_TOO_LARGE",
    );
  });
  it("does not turn an unanswered required number into zero", () => {
    const plan = compilePluginForm(
      {
        type: "object",
        required: ["amount"],
        properties: { amount: { type: "number" } },
      },
      profile,
    );
    const content = buildPluginFormContent(plan, { amount: " " });
    expect(Object.hasOwn(content, "amount")).toBe(false);
    expect(validatePluginFormContent(plan, content).valid).toBe(false);
  });
  it("preserves official choices, typed custom arrays and offered resource URIs", () => {
    const plan = compilePluginForm(schema, profile);
    const content = buildPluginFormContent(plan, {
      code: "AB",
      tags: ["bolt", "custom"],
      files: ["fixture://one"],
    });
    expect(plan.schema).toEqual(schema);
    expect(content.tags).toEqual(["bolt", "custom"]);
    expect(validatePluginFormContent(plan, content).valid).toBe(true);
    for (const change of [
      { code: "abc" },
      { tags: ["x"] },
      { tags: ["bolt", "bolt"] },
      { files: ["fixture://foreign"] },
    ])
      expect(
        validatePluginFormContent(plan, { ...content, ...change }).valid,
      ).toBe(false);
  });
  it.each([
    {
      type: "object",
      properties: { future: { type: "object", properties: {} } },
    },
    {
      type: "object",
      properties: {
        future: { type: "string", "x-openai-input": { type: "future" } },
      },
    },
    { type: "object", properties: { code: { type: "string", pattern: "(" } } },
    {
      type: "object",
      properties: { code: { type: "string", pattern: "(?=a)a" } },
    },
    {
      type: "object",
      properties: { code: { type: "string", allOf: [{ minLength: 2 }] } },
    },
    { type: "object", required: ["missing"], properties: {} },
  ])("rejects the whole unsupported schema", (value) => {
    expect(() => compilePluginForm(value, profile)).toThrow();
  });
  it("requires actual user resource and preview services and narrows the web App profile", () => {
    const resources = {
      type: "object",
      properties: {
        files: {
          ...schema.properties.files,
          "x-openai-input": {
            ...schema.properties.files["x-openai-input"],
            selection: "implicit",
          },
        },
      },
    };
    expect(() => compilePluginForm(resources, profile)).toThrow(
      "RESOURCE_SERVICE",
    );
    expect(
      initialPluginFormValues(
        compilePluginForm(resources, { ...profile, userResources: true }),
      ).files,
    ).toEqual(["fixture://one"]);
    expect(() =>
      compilePluginForm(resources, {
        ...profile,
        fileResources: false,
        origin: "mcp-app",
        userResources: true,
      }),
    ).toThrow("WEB_UPLOAD");
    const preview = {
      type: "object",
      properties: {
        file: {
          type: "string",
          format: "uri",
          "x-openai-input": {
            type: "resource",
            options: [
              {
                uri: "fixture://one",
                name: "One",
                _meta: {
                  "openai/preview": {
                    target: {
                      type: "mcp_app_tool",
                      name: "viewer",
                      arguments: { item: "one" },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    };
    // Without a preview service the form stays; only its Preview is dropped.
    const withoutPreviews = compilePluginForm(preview, profile);
    expect(withoutPreviews.fields).toHaveLength(1);
    expect(
      (withoutPreviews.schema.properties.file as any)["x-openai-input"]
        .options[0]._meta,
    ).toBeUndefined();
    expect(withoutPreviews.diagnostics).toEqual([
      expect.objectContaining({
        level: "warning",
        code: "PLUGIN_FORM_PREVIEW_DROPPED",
        details: { field: "file", option: "fixture://one" },
      }),
    ]);
    // The caller's schema is never modified.
    expect(
      preview.properties.file["x-openai-input"].options[0]._meta,
    ).toBeDefined();
    const withPreviews = compilePluginForm(preview, {
      ...profile,
      previews: true,
    });
    expect(withPreviews.fields).toHaveLength(1);
    expect(withPreviews.diagnostics).toBeUndefined();
    expect(() =>
      pluginFormPreview({
        _meta: {
          "openai/preview": {
            target: {
              type: "mcp_app_tool",
              name: "viewer",
              serverId: "forged",
            },
          },
        },
      }),
    ).toThrow();
  });
  it("preserves hostile field names, empty enum values and optional non-answers", () => {
    const schema = JSON.parse(
      '{"type":"object","required":["__proto__"],"properties":{"__proto__":{"type":"string","default":"answer"},"empty":{"type":"string","oneOf":[{"const":"","title":"Empty"}]},"unused":{"type":"boolean"},"requiredFalse":{"type":"boolean","default":false}}}',
    );
    const plan = compilePluginForm(schema, profile),
      values = initialPluginFormValues(plan);
    expect(values.empty).toBeUndefined();
    expect(values.unused).toBeUndefined();
    const content = buildPluginFormContent(plan, { ...values, empty: "" });
    expect(Object.hasOwn(content, "__proto__")).toBe(true);
    expect(content.empty).toBe("");
    expect(content.requiredFalse).toBe(false);
    expect(content.unused).toBeUndefined();
    expect(validatePluginFormContent(plan, content).valid).toBe(true);
    expect(
      validatePluginFormContent(plan, { ...content, foreign: true }).valid,
    ).toBe(false);
  });
  it("bounds the whole schema and rejects defaults outside resource options", () => {
    expect(() =>
      compilePluginForm(
        {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 65 }, (_, i) => [
              String(i),
              { type: "string" },
            ]),
          ),
        },
        profile,
      ),
    ).toThrow("TOO_LARGE");
    expect(() =>
      compilePluginForm(
        {
          type: "object",
          properties: {
            file: {
              type: "string",
              format: "uri",
              default: "fixture://foreign",
              "x-openai-input": { type: "resource", options: [] },
            },
          },
        },
        profile,
      ),
    ).toThrow();
  });
});

describe("installed partial resource preview profile", () => {
  it.each([false, true])(
    "admits declared resource and App previews (File resources %s) while withholding uploads",
    (fileResources) => {
      const field = (target: unknown) => ({
        type: "object",
        properties: {
          file: {
            type: "string",
            format: "uri",
            "x-openai-input": {
              type: "resource",
              options: [
                {
                  uri: "fixture://one",
                  name: "One",
                  _meta: { "openai/preview": { target } },
                },
              ],
            },
          },
        },
      });
      const current = ownedPluginFormProfile(fileResources, "server");
      expect(
        compilePluginForm(
          field({
            type: "resource_link",
            uri: "fixture://preview",
            name: "Preview",
          }),
          current,
        ).fields,
      ).toHaveLength(1);
      expect(
        compilePluginForm(
          field({ type: "mcp_app_tool", name: "write" }),
          current,
        ).fields,
      ).toHaveLength(1);
      const partial = compilePluginForm(
        field({ type: "mcp_app_tool", name: "write" }),
        { ...current, previewKinds: ["resource_link"] },
      );
      expect(partial.fields).toHaveLength(1);
      expect(partial.diagnostics?.[0].code).toBe("PLUGIN_FORM_PREVIEW_DROPPED");
      expect(current.userResources).toBe(false);
    },
  );
  it("continues to refuse implicit MCP-App uploads while File resources is off", () => {
    const raw = structuredClone(schema) as any;
    raw.properties.files["x-openai-input"].selection = "implicit";
    expect(() =>
      compilePluginForm(raw, ownedPluginFormProfile(false, "mcp-app")),
    ).toThrow("PLUGIN_FORM_WEB_UPLOAD_UNSUPPORTED");
  });
  it("follows the client's File resources toggle for MCP-App uploads", () => {
    const form = (input: Record<string, unknown>) => ({
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string", format: "uri" },
          "x-openai-input": {
            type: "resource",
            options: [{ uri: "fixture://one", name: "One" }],
            ...input,
          },
        },
      },
    });
    const implicit = form({ selection: "implicit" });
    const userOptions = form({ userOptions: { kind: "file" } });
    const explicitOnly = form({ selection: "explicit" });
    for (const raw of [implicit, userOptions]) {
      // On: uploads are offered in App-requested forms.
      expect(
        compilePluginForm(raw, ownedPluginFormProfile(true, "mcp-app", true))
          .fields,
      ).toHaveLength(1);
      // Off, or absent: refused with the same code.
      expect(() =>
        compilePluginForm(raw, ownedPluginFormProfile(false, "mcp-app", true)),
      ).toThrow("PLUGIN_FORM_WEB_UPLOAD_UNSUPPORTED");
      const { fileResources: _off, ...absent } = ownedPluginFormProfile(
        true,
        "mcp-app",
        true,
      );
      expect(() => compilePluginForm(raw, absent)).toThrow(
        "PLUGIN_FORM_WEB_UPLOAD_UNSUPPORTED",
      );
      // Server-requested forms never depend on the toggle.
      expect(
        compilePluginForm(raw, ownedPluginFormProfile(false, "server", true))
          .fields,
      ).toHaveLength(1);
    }
    // Explicit selection without uploads stays available either way.
    expect(
      compilePluginForm(explicitOnly, ownedPluginFormProfile(false, "mcp-app"))
        .fields,
    ).toHaveLength(1);
  });
});

describe("form diagnostics for the Logs panel", () => {
  const choice = (options: Record<string, unknown>[]) => ({
    type: "object",
    properties: {
      part: { type: "string", oneOf: options },
    },
  });
  it("warns, without refusing, about unsafe and partial thumbnails", () => {
    const plan = compilePluginForm(
      choice([
        {
          const: "a",
          title: "A",
          "x-openai-thumbnail": { src: "http://example.invalid/a.png" },
        },
        {
          const: "b",
          title: "B",
          "x-openai-thumbnail": { src: "data:image/png;base64,AAAA" },
        },
        { const: "c", title: "C" },
      ]),
      profile,
    );
    expect(plan.fields).toHaveLength(1);
    expect(plan.diagnostics?.map((d) => d.code)).toEqual([
      "PLUGIN_FORM_THUMBNAIL_SOURCE_INVALID",
      "PLUGIN_FORM_THUMBNAIL_PARTIAL",
    ]);
    expect(plan.diagnostics?.[0].details).toEqual({
      field: "part",
      options: ["A"],
    });
    expect(
      compilePluginForm(
        choice([
          {
            const: "a",
            title: "A",
            "x-openai-thumbnail": { src: "https://example.invalid/a.png" },
          },
        ]),
        profile,
      ).diagnostics,
    ).toBeUndefined();
  });
  const resourceField = (field: Record<string, unknown>) => ({
    type: "object",
    properties: { file: field },
  });
  const options = [{ uri: "fixture://one", name: "One" }];
  it.each([
    [
      "selection on a single-select resource field",
      resourceField({
        type: "string",
        format: "uri",
        "x-openai-input": { type: "resource", options, selection: "explicit" },
      }),
    ],
    [
      "a default that is not one of the options",
      resourceField({
        type: "string",
        format: "uri",
        default: "fixture://other",
        "x-openai-input": { type: "resource", options },
      }),
    ],
    [
      "a default with implicit selection",
      resourceField({
        type: "array",
        items: { type: "string", format: "uri" },
        default: ["fixture://one"],
        "x-openai-input": { type: "resource", options, selection: "implicit" },
      }),
    ],
  ])("names the field when a form breaks a server MUST rule: %s", (_, raw) => {
    let error: unknown;
    try {
      compilePluginForm(raw, { ...profile, userResources: true });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeDefined();
    const diagnostic = pluginFormUnsupportedDiagnostic(error, raw);
    expect(diagnostic).toMatchObject({
      level: "error",
      code: "PLUGIN_FORM_UNSUPPORTED",
      title: 'Form unsupported: field "file"',
      details: expect.objectContaining({ field: "file" }),
    });
    expect(diagnostic.description).toContain('Field "file"');
  });
  it("names the field and reason for a missing host service", () => {
    let error: unknown;
    try {
      compilePluginForm(
        resourceField({
          type: "array",
          items: { type: "string", format: "uri" },
          "x-openai-input": { type: "resource", options, selection: "implicit" },
        }),
        { ...ownedPluginFormProfile(false, "mcp-app"), userResources: true },
      );
    } catch (caught) {
      error = caught;
    }
    expect(pluginFormUnsupportedDiagnostic(error)).toMatchObject({
      code: "PLUGIN_FORM_WEB_UPLOAD_UNSUPPORTED",
      title: 'Form unsupported: field "file"',
      details: { field: "file" },
    });
  });
});

describe("forms are shown whole or not at all", () => {
  it("accepts annotation-only keywords a reference server emits", () => {
    // Shaped like OpenAI's Python reference output: a form title, field
    // annotations, a closed object, and titled multi-select items that
    // restate their string type.
    const plan = compilePluginForm(
      {
        title: "PartRequest",
        description: "Pick parts",
        additionalProperties: false,
        type: "object",
        properties: {
          note: {
            type: "string",
            title: "Note",
            examples: ["spare"],
            $comment: "free text",
            deprecated: false,
            _meta: { origin: "fixture" },
          },
          parts: {
            type: "array",
            items: {
              type: "string",
              title: "Part",
              anyOf: [{ const: "bolt", title: "Bolt" }],
            },
          },
        },
      },
      profile,
    );
    expect(plan.fields.map(({ name }) => name)).toEqual(["note", "parts"]);
  });
  it.each([
    ["an unknown field keyword", { type: "string", "x-openai-color": {} }, "x-openai-color"],
    [
      "an unknown option keyword",
      { type: "string", oneOf: [{ const: "a", title: "A", "x-openai-badge": "new" }] },
      "x-openai-badge",
    ],
    ["a constraint the field type lacks", { type: "integer", pattern: "^1" }, "pattern"],
  ])("refuses %s, naming the field and keyword", (_label, field, keyword) => {
    const raw = { type: "object", properties: { name: { type: "string" }, odd: field } };
    let error: unknown;
    try {
      compilePluginForm(raw, profile);
    } catch (caught) {
      error = caught;
    }
    expect(pluginFormUnsupportedDiagnostic(error, raw)).toMatchObject({
      code: "PLUGIN_FORM_UNSUPPORTED",
      details: {
        field: "odd",
        reason: `It uses "${keyword}", which this client doesn't support.`,
      },
    });
  });
  it("names an unknown input type and an unknown field type", () => {
    for (const [field, reason] of [
      [
        { type: "string", "x-openai-input": { type: "date-range" } },
        'It asks for a "date-range" input, which this client doesn\'t support.',
      ],
      [
        { type: "object", properties: {} },
        'It has the field type "object", which this client doesn\'t support.',
      ],
    ] as const) {
      const raw = { type: "object", properties: { odd: field } };
      let error: unknown;
      try {
        compilePluginForm(raw, profile);
      } catch (caught) {
        error = caught;
      }
      expect(pluginFormUnsupportedDiagnostic(error, raw).details).toMatchObject(
        { field: "odd", reason },
      );
    }
  });
});
