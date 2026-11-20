import { describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";
import {
  DEFAULT_MCP_DIALECT,
  omitImpliedDialect,
  withImpliedDialect,
} from "../src/tools/impliedDialect.js";
import { createSessionToolRegistrar } from "../src/tools/sessionToolRegistrar.js";

const target = { target: "draft-2020-12" } as const;

describe("omitImpliedDialect", () => {
  it("drops a 2020-12 $schema from a schema that reads the same under draft-07", () => {
    expect(
      omitImpliedDialect({
        $schema: DEFAULT_MCP_DIALECT,
        type: "object",
        properties: { project: { type: "string", minLength: 1 } },
        additionalProperties: false,
      })
    ).toEqual({
      type: "object",
      properties: { project: { type: "string", minLength: 1 } },
      additionalProperties: false,
    });
  });

  it("keeps it when a keyword means something else under draft-07", () => {
    const tuple = {
      $schema: DEFAULT_MCP_DIALECT,
      type: "object",
      properties: {
        origins: {
          type: "array",
          prefixItems: [{ type: "string" }],
          items: { type: "string" },
        },
      },
    };
    expect(omitImpliedDialect(tuple)).toBe(tuple);
    const withRef = {
      $schema: DEFAULT_MCP_DIALECT,
      type: "object",
      $defs: { id: { type: "string" } },
      properties: { a: { $ref: "#/$defs/id", description: "kept beside $ref" } },
    };
    expect(omitImpliedDialect(withRef)).toBe(withRef);
  });

  it("keeps any other declared dialect", () => {
    const draft7 = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
    };
    expect(omitImpliedDialect(draft7)).toBe(draft7);
  });
});

describe("withImpliedDialect", () => {
  const schema = z.object({ project: z.string().min(1).optional() });

  it("lists the input schema without the implied dialect", () => {
    const listed = withImpliedDialect(schema)["~standard"].jsonSchema.input(target);
    expect(listed).not.toHaveProperty("$schema");
    expect(listed).toMatchObject({
      type: "object",
      properties: { project: { type: "string", minLength: 1 } },
    });
  });

  it("validates exactly as the schema it wraps", async () => {
    const wrapped = withImpliedDialect(schema)["~standard"];
    expect(await wrapped.validate({ project: "demo" })).toEqual({
      value: { project: "demo" },
    });
    const refused = await wrapped.validate({ project: "" });
    expect(refused).toHaveProperty("issues");
  });

  it("is what the session registrar hands the SDK", () => {
    const server = new McpServer({ name: "test", version: "1.0.0" });
    const registered: unknown[] = [];
    const register = server.registerTool.bind(server);
    server.registerTool = ((name, config, callback) => {
      registered.push(config.inputSchema);
      return register(name, config, callback);
    }) as typeof server.registerTool;
    createSessionToolRegistrar(server).registerTool(
      "list_things",
      { description: "Lists things.", inputSchema: schema },
      async () => ({ content: [{ type: "text", text: "ok" }] })
    );
    const [listed] = registered as (typeof schema)[];
    expect(listed["~standard"].jsonSchema.input(target)).not.toHaveProperty(
      "$schema"
    );
  });
});
