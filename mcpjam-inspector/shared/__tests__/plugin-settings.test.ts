import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/client";
import { DialectAwareJsonSchemaValidator } from "@mcpjam/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSettings } from "@openai/mcp-extensions/server";
import {
  pluginSettingsCapability,
  parsePluginSettingsDocument,
  parsePluginSettingsUpdate,
  validatePluginSettingValue,
  parsePluginSettingsSet,
} from "../plugin-settings";
import { settingsFixture } from "./plugin-settings-fixture";

describe("native settings capability", () => {
  const value = { readTool: "read", updateTool: "save" };
  it("reads extensions in both protocols and uses experimental only for legacy", () => {
    for (const transport of ["legacy", "mrtr"] as const)
      expect(
        pluginSettingsCapability(
          { extensions: { "openai/settings": value } },
          transport,
        ),
      ).toEqual(value);
    expect(
      pluginSettingsCapability(
        { experimental: { "openai/settings": value } },
        "legacy",
      ),
    ).toEqual(value);
    expect(
      pluginSettingsCapability(
        { experimental: { "openai/settings": value } },
        "mrtr",
      ),
    ).toBeUndefined();
    expect(pluginSettingsCapability({}, "legacy")).toBeUndefined();
  });
  it.each([
    null,
    {},
    { readTool: " ", updateTool: "save" },
    { readTool: "read", updateTool: "read" },
    { readTool: "a".repeat(257), updateTool: "save" },
  ])("rejects malformed declarations: %j", (invalid) => {
    expect(() =>
      pluginSettingsCapability(
        {
          extensions: { "openai/settings": invalid },
          experimental: { "openai/settings": value },
        },
        "legacy",
      ),
    ).toThrow("PLUGIN_SETTINGS_INVALID_CAPABILITY");
  });
  it("refuses conflicting legacy and primary declarations", () => {
    expect(() =>
      pluginSettingsCapability(
        {
          extensions: { "openai/settings": value },
          experimental: {
            "openai/settings": { ...value, updateTool: "other" },
          },
        },
        "legacy",
      ),
    ).toThrow("PLUGIN_SETTINGS_AMBIGUOUS_CAPABILITY");
  });
});

describe("native settings semantic admission", () => {
  it("bounds read and update envelopes even when a field has no length constraint", () => {
    const input = {
      schema: {
        type: "object",
        properties: { text: { type: "string", title: "Text" } },
      },
      values: { text: "" },
    };
    const fields = parsePluginSettingsDocument(input).fields;
    const values = { text: "x".repeat(512 * 1024) };
    expect(() => parsePluginSettingsDocument({ ...input, values })).toThrow(
      "PLUGIN_SETTINGS_LIMIT",
    );
    expect(() => parsePluginSettingsUpdate(fields, { values })).toThrow(
      "PLUGIN_SETTINGS_LIMIT",
    );
  });
  it("refuses __proto__ explicitly before envelope parsing can silently lose a field or value", () => {
    const input = {
      schema: {
        type: "object",
        properties: Object.fromEntries([
          ["__proto__", { type: "string", title: "Unsafe key" }],
        ]),
      },
      values: Object.fromEntries([["__proto__", "value"]]),
    };
    expect(() => parsePluginSettingsDocument(input)).toThrow(
      "PLUGIN_SETTINGS_UNSUPPORTED_SCHEMA",
    );
    const fields = parsePluginSettingsDocument(settingsFixture()).fields;
    expect(() =>
      parsePluginSettingsUpdate(fields, {
        values: { ...settingsFixture().values, ...input.values },
      }),
    ).toThrow();
  });

  it("admits real pinned-helper read/update results and output schemas over a legacy MCP wire", async () => {
    const server = new McpServer({
      name: "disposable-native-settings",
      version: "0.0.0",
    });
    let values = { enabled: false, label: "", rate: 0.3, count: 2 };
    let writes = 0;
    createSettings(server).register({
      fields: {
        enabled: { title: "Enabled", schema: z.boolean() },
        label: { title: "Label", schema: z.string().max(20) },
        rate: {
          title: "Rate",
          schema: z.number().min(0).max(10).multipleOf(0.1),
        },
        count: { title: "Count", schema: z.number().int().min(0) },
      },
      read: () => values,
      update: (set) => {
        writes++;
        values = { ...values, ...set };
        return values;
      },
    });
    const client = new Client(
      { name: "fixture-host", version: "0.0.0" },
      {
        supportedProtocolVersions: ["2025-11-25"],
        jsonSchemaValidator: new DialectAwareJsonSchemaValidator(),
      },
    );
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(a), client.connect(b)]);
      const capability = pluginSettingsCapability(
        client.getServerCapabilities(),
        "legacy",
      )!;
      const tools = (await client.listTools()).tools;
      expect(
        tools.find((tool) => tool.name === capability.readTool)?.outputSchema,
      ).toBeDefined();
      expect(
        tools.find((tool) => tool.name === capability.updateTool)?.outputSchema,
      ).toBeDefined();
      const result = await client.callTool({
        name: capability.readTool,
        arguments: {},
      });
      const document = parsePluginSettingsDocument(result.structuredContent);
      expect(document.values).toEqual(values);
      const updated = await client.callTool({
        name: capability.updateTool,
        arguments: { set: { count: 4 } },
      });
      expect(
        parsePluginSettingsUpdate(document.fields, updated.structuredContent),
      ).toEqual({ ...values, count: 4 });
      // The pinned helper's Zod multipleOf is tolerant: it persists this near-multiple.
      // The host must admit typed set values before dispatch and fence invalid returned values.
      await expect(
        client.callTool({
          name: capability.updateTool,
          arguments: { set: { rate: 0.30000000000000004 } },
        }),
      ).rejects.toThrow(/output schema/);
      expect(writes).toBe(2);
    } finally {
      await Promise.allSettled([client.close(), server.close()]);
    }
  });

  it.each(["constructor", "prototype"])(
    "handles prototype-like property %s without mutating object prototypes or losing keys",
    (name) => {
      const input = {
        schema: {
          type: "object",
          properties: Object.fromEntries([
            [name, { type: "string", title: "Safe name" }],
          ]),
        },
        values: Object.fromEntries([[name, "value"]]),
      };
      const document = parsePluginSettingsDocument(input);
      expect(document.fields.map((field) => field.name)).toEqual([name]);
      expect(Object.hasOwn(document.values, name)).toBe(true);
      expect(Object.getPrototypeOf(document.values)).toBeNull();
      expect(({} as Record<string, unknown>)[name]).not.toBe("value");
    },
  );
  it("preserves effective false/empty/numeric values and ordered groups with Other settings", () => {
    const document = parsePluginSettingsDocument(settingsFixture());
    expect(document.values).toEqual(settingsFixture().values);
    expect(document.groups.map(({ title }) => title)).toEqual([
      "Appearance",
      "Other settings",
    ]);
    expect(document.groups[0].items[1]).toMatchObject({
      kind: "tool",
      tool: "reset",
    });
    expect(
      document.groups[1].items.map(
        (item) => item.kind === "property" && item.property,
      ),
    ).toEqual(["enabled", "label", "rate", "count"]);
  });
  it.each([
    { type: "object", title: "Nested" },
    { type: "array", title: "Array" },
    { type: "string" },
    { type: "string", title: " " },
    { type: "string", title: "Default", default: "x" },
    { type: "string", title: "Ref", $ref: "#/defs/x" },
    { type: "string", title: "Union", anyOf: [{ type: "string" }] },
    { type: "boolean", title: "Enum", enum: ["yes"] },
    { type: "string", title: "Empty", enum: [] },
    { type: "string", title: "Duplicate", enum: ["x", "x"] },
    { type: "string", title: "Type", minimum: 0 },
    { type: "integer", title: "Type", minLength: 0 },
    { type: "number", title: "Multiple", multipleOf: 0 },
    { type: "number", title: "Bounds", minimum: 2, maximum: 1 },
    { type: "string", title: "Bounds", minLength: 2, maxLength: 1 },
    { type: "string", title: "Pattern", pattern: "[" },
    { type: "string", title: "Unsafe", pattern: "(?=x)x" },
    { type: "string", title: "Unsupported", format: "email" },
  ])("rejects the whole form for an unsupported definition: %j", (field) => {
    const input = settingsFixture();
    Reflect.set(input.schema.properties, "label", field);
    expect(() => parsePluginSettingsDocument(input)).toThrow(
      "PLUGIN_SETTINGS_UNSUPPORTED_SCHEMA",
    );
  });
  it.each([
    { enabled: "false" },
    { rate: "0.3" },
    { rate: 0.30000000000000004 },
    { count: 2.5 },
    { theme: "other" },
    { label: null },
    { count: Infinity },
    { extra: "unknown" },
  ])("rejects untyped, invalid or unknown effective values: %j", (values) => {
    const input = settingsFixture();
    Object.assign(input.values, values);
    expect(() => parsePluginSettingsDocument(input)).toThrow();
  });
  it("requires every effective value even for schema-optional fields", () => {
    const input = settingsFixture();
    input.schema.required = [];
    Reflect.deleteProperty(input.values, "count");
    expect(() => parsePluginSettingsDocument(input)).toThrow();
  });
  it("rejects unknown or duplicate layout and required references", () => {
    const input = settingsFixture();
    input.layout[0].items.push({ kind: "property", property: "theme" });
    expect(() => parsePluginSettingsDocument(input)).toThrow();
    input.layout = [];
    input.schema.required = ["missing"];
    expect(() => parsePluginSettingsDocument(input)).toThrow();
  });
  it("uses Unicode code points and unanchored safe patterns", () => {
    const field = {
      name: "emoji",
      type: "string" as const,
      title: "Emoji",
      minLength: 1,
      maxLength: 1,
      pattern: "😀",
    };
    expect(validatePluginSettingValue(field, "😀")).toBeNull();
    expect(validatePluginSettingValue(field, "😀😀")).not.toBeNull();
  });
  it("validates a complete update atomically and isolates output values", () => {
    const input = settingsFixture();
    const fields = parsePluginSettingsDocument(input).fields;
    const values = parsePluginSettingsUpdate(fields, { values: input.values });
    expect(values).toEqual(input.values);
    values.count = 8;
    expect(input.values.count).toBe(2);
    expect(() =>
      parsePluginSettingsUpdate(fields, { values: { count: 2 } }),
    ).toThrow();
    expect(() =>
      parsePluginSettingsUpdate(fields, {
        values: { ...input.values, rate: "0.4" },
      }),
    ).toThrow();
  });

  it("admits only a nonempty, typed subset of known set keys at the execution boundary", () => {
    const fields = parsePluginSettingsDocument(settingsFixture()).fields;
    expect(
      parsePluginSettingsSet(fields, { set: { label: "", rate: 0.3 } }),
    ).toEqual({ set: { label: "", rate: 0.3 } });
    for (const input of [
      { set: {} },
      { set: { unknown: 3 } },
      { set: { rate: "0.3" } },
      { set: { rate: 0.30000000000000004 } },
      { set: { count: 2.5 } },
      { set: { enabled: "false" } },
      { set: { count: 3 }, extra: "ignored" },
      { set: Object.fromEntries([["__proto__", true]]) },
    ])
      expect(() => parsePluginSettingsSet(fields, input)).toThrow(
        "PLUGIN_SETTINGS_INVALID_EDIT",
      );
  });
});
