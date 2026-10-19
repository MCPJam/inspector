import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import {
  createElicitInput,
  OpenAIFormSchema,
  requestFormInput,
  type OpenAIFormRequestParams,
} from "@openai/mcp-extensions/server";
import { z } from "zod/v4";
import { extendedFormFixture } from "../../shared/plugin-extensions/testing/form-fixtures.js";

/** Opt-in synthetic supplement. Never registered by the product server. */
export function registerExtensionFormFixture(server: McpServer) {
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
        const result = await requestForm(server, context, {
          mode: "form",
          message: "Disposable form check",
          requestedSchema: OpenAIFormSchema.parse(requestedSchema),
        });
        if ("resultType" in result) return result;
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

/** The same form over either wire, as OpenAI's own helpers send it: MRTR
 * (`input_required` with the schema in `_meta["openai/elicitation"]`) on
 * 2026-07-28 connections, `openai/elicitation/create` before that. */
function requestForm(
  server: McpServer,
  context: ServerContext,
  params: OpenAIFormRequestParams,
) {
  const envelope = z
    .object({
      "io.modelcontextprotocol/protocolVersion": z.string().optional(),
    })
    .parse(context.mcpReq.envelope ?? {});
  const version =
    envelope["io.modelcontextprotocol/protocolVersion"] ??
    server.server.getNegotiatedProtocolVersion();
  if (version !== undefined && version >= "2026-07-28")
    return Promise.resolve(
      requestFormInput(context, { ...params, key: "form" }),
    );
  return createElicitInput(server)(context, params, { timeout: 300_000 });
}
