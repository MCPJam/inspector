import { afterEach, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { OpenAIFormParamsSchema } from "../../../../shared/plugin-extensions/wire.js";
import { registerExtensionFormFixture } from "../../../testing/extension-form-fixture.js";
const close: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(close.splice(0).map((fn) => fn()));
});
it("serves missing field, large-schema and upload cases through actual reverse MCP requests", async () => {
  const server = new McpServer({ name: "disposable-forms", version: "1" });
  registerExtensionFormFixture(server);
  const client = new Client(
    { name: "fixture-check", version: "1" },
    { capabilities: { extensions: { "openai/elicitation": { form: {} } } } },
  );
  const seen: unknown[] = [];
  client.setRequestHandler(
    z.object({
      method: z.literal("openai/elicitation/create"),
      params: OpenAIFormParamsSchema,
    }),
    async (request) => {
      seen.push(request.params.requestedSchema);
      return { action: "decline" };
    },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  close.push(
    () => client.close(),
    () => server.close(),
  );
  for (const name of [
    "fixture.formEdges",
    "fixture.largeForm",
    "fixture.uploadForm",
  ]) {
    const result = await client.callTool({ name, arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify({ action: "decline" }) },
    ]);
  }
  expect(seen).toHaveLength(3);
  expect(JSON.stringify(seen[1]).length).toBeGreaterThan(32 * 1024);
  expect(
    (await client.readResource({ uri: "fixture://preview" })).contents[0],
  ).toMatchObject({ text: "Disposable preview: <script>inert text</script>" });
});
