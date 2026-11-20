import { describe, expect, it } from "vitest";
import { z } from "zod";
import { omitDeprecatedProperties } from "../src/tools/deprecatedProperties.js";
import { withListedInputSchema } from "../src/tools/listedInputSchema.js";

const target = { target: "draft-2020-12" } as const;

describe("omitDeprecatedProperties", () => {
  it("drops an alias marked deprecated and keeps the name it was renamed to", () => {
    expect(
      omitDeprecatedProperties({
        type: "object",
        properties: {
          study: { type: "string", description: "Study id." },
          scenario: { type: "string", description: "Study id.", deprecated: true },
        },
        required: ["scenario", "window"],
      })
    ).toEqual({
      type: "object",
      properties: { study: { type: "string", description: "Study id." } },
      required: ["window"],
    });
  });

  it("drops a deprecated alias inside a nested object", () => {
    const listed = omitDeprecatedProperties({
      type: "object",
      properties: {
        compose: {
          type: "object",
          properties: {
            client: { type: "string" },
            host: { type: "string", deprecated: true },
          },
        },
      },
    });
    expect(listed.properties).toEqual({
      compose: { type: "object", properties: { client: { type: "string" } } },
    });
  });

  it("keeps a property that is only named like a keyword", () => {
    const listed = omitDeprecatedProperties({
      type: "object",
      properties: { deprecated: { type: "boolean" } },
    });
    expect(listed.properties).toEqual({ deprecated: { type: "boolean" } });
  });
});

describe("withListedInputSchema and deprecated aliases", () => {
  const schema = z.object({
    study: z.string().min(1).optional().describe("Study id."),
    scenario: z
      .string()
      .min(1)
      .optional()
      .describe("Study id. DEPRECATED: use `study`.")
      .meta({ deprecated: true }),
  });

  it("lists only the current name", () => {
    const listed = withListedInputSchema(schema)["~standard"].jsonSchema.input(target);
    expect(Object.keys(listed.properties as object)).toEqual(["study"]);
  });

  it("still accepts the alias", async () => {
    const result = await withListedInputSchema(schema)["~standard"].validate({
      scenario: "s1",
    });
    expect(result).toEqual({ value: { scenario: "s1" } });
  });
});
