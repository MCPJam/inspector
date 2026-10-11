export function settingsFixture() {
  return {
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean", title: "Enabled" },
        label: { type: "string", title: "Label", maxLength: 20 },
        theme: { type: "string", title: "Theme", enum: ["", "light", "dark"] },
        rate: {
          type: "number",
          title: "Rate",
          minimum: 0,
          maximum: 10,
          multipleOf: 0.1,
        },
        count: { type: "integer", title: "Count", minimum: 0 },
      },
      required: ["enabled", "label", "theme", "rate", "count"],
    },
    layout: [
      {
        kind: "group",
        title: "Appearance",
        items: [
          { kind: "property", property: "theme" },
          { kind: "tool", tool: "reset", title: "Reset" },
        ],
      },
    ],
    values: { enabled: false, label: "", theme: "light", rate: 0.3, count: 2 },
  };
}
