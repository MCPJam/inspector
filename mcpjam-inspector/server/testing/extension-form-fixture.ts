import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  ServerRequest,
  ServerNotification,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  createElicitInput,
  OpenAIFormSchema,
} from "@openai/mcp-extensions/server";
import { z } from "zod/v4";
import { extendedFormFixture } from "../../shared/plugin-extensions/testing/form-fixtures.js";

/** Opt-in synthetic supplement. Never registered by the product server. */
export function registerExtensionFormFixture(
  server: McpServer,
  options: {
    requestClient?: (
      context: RequestHandlerExtra<ServerRequest, ServerNotification>,
    ) => Parameters<typeof createElicitInput>[0]["server"];
  } = {},
) {
  const schemas = {
    "fixture.formEdges": extendedFormFixture,
    "fixture.largeForm": {
      ...extendedFormFixture,
      properties: {
        ...extendedFormFixture.properties,
        note: {
          ...extendedFormFixture.properties.note,
          description: "Synthetic schema metadata. ".repeat(2000),
        },
      },
    },
    "fixture.uploadForm": {
      type: "object",
      required: ["files"],
      properties: {
        files: {
          type: "array",
          items: { type: "string", format: "uri" },
          "x-openai-input": {
            type: "resource",
            selection: "implicit",
            options: [],
            userOptions: { kind: "file", accept: [".txt"] },
          },
        },
      },
    },
  } as const;
  for (const [name, requestedSchema] of Object.entries(schemas)) {
    server.registerTool(
      name,
      {
        description:
          "Synthetic form coverage supplement; uses only disposable input.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, destructiveHint: false },
      },
      async (_args, context) => {
        const elicit = createElicitInput({
          server: options.requestClient?.(context) ?? server.server,
        });
        const result = await elicit(
          {
            mode: "form",
            message: "Disposable form check",
            requestedSchema: OpenAIFormSchema.parse(requestedSchema),
          },
          { timeout: 300_000 },
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      },
    );
  }
  server.registerResource(
    "fixture-preview",
    "fixture://preview",
    { mimeType: "text/plain" },
    async () => ({
      contents: [
        {
          uri: "fixture://preview",
          mimeType: "text/plain",
          text: "Disposable preview: <script>inert text</script>",
        },
      ],
    }),
  );
}
