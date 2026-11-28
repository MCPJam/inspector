import { describe, expect, it } from "vitest";
import type { MockDefinition } from "../index.js";
import { useItemHarness } from "./item-harness.js";
import type { Era } from "./item-harness.js";

const h = useItemHarness();

const prompt = {
  description: "Summarize a topic.",
  arguments: [{ name: "topic", required: true }],
  messages: [
    {
      role: "user" as const,
      content: {
        type: "text",
        text: "Summarize {{input.topic}} in three lines.",
      },
    },
  ],
};
const APP = "<!doctype html><button>+1</button>";

describe.each<Era>(["legacy", "modern"])(
  "prompts, resources and apps (%s era)",
  (era) => {
    it("adds a prompt, a resource and an app beside the real server's own", async () => {
      const { client } = await h.connect(
        {
          prompts: { summarize: prompt },
          resources: {
            "test://notes": {
              name: "notes",
              mimeType: "text/plain",
              text: "my notes",
            },
            "ui://counter/app.html": { text: APP },
          },
        },
        era
      );
      // The real server lacks prompts, so the mock declares them; it has resources already.
      const capabilities = client.getServerCapabilities();
      expect(capabilities?.prompts).toBeDefined();
      expect(capabilities?.resources).toBeDefined();

      expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual([
        "summarize",
      ]);
      const got = await client.getPrompt({
        name: "summarize",
        arguments: { topic: "tides" },
      });
      expect(got.messages).toEqual([
        {
          role: "user",
          content: { type: "text", text: "Summarize tides in three lines." },
        },
      ]);

      const resources = await client.listResources();
      expect(resources.resources.map((r) => r.uri)).toEqual([
        "test://greeting",
        "test://notes",
        "ui://counter/app.html",
      ]);
      expect(
        resources.resources.find((r) => r.uri === "ui://counter/app.html")
          ?.mimeType
      ).toBe("text/html;profile=mcp-app");
      const read = async (uri: string) =>
        (await client.readResource({ uri })).contents[0];
      expect(await read("test://notes")).toMatchObject({
        text: "my notes",
        mimeType: "text/plain",
      });
      expect(await read("ui://counter/app.html")).toMatchObject({
        text: APP,
        mimeType: "text/html;profile=mcp-app",
      });
      // The real server's own resource still answers.
      expect(await read("test://greeting")).toMatchObject({ text: "hello" });
    });

    it("hides and renames a tool and fixes a hidden parameter, and refuses an unmapped input change", async () => {
      const definition: MockDefinition = {
        tools: {
          working: { hidden: true },
          say: { description: "Say it.", answer: { tool: "echo" } },
          echo: { hidden: true },
          add: { params: { mode: { hidden: true } } },
        },
      };
      const { client } = await h.connect(definition, era);
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(["add", "say"]);
      const said = await client.callTool({
        name: "say",
        arguments: { message: "hi" },
      });
      expect(said.content).toEqual([{ type: "text", text: "echo: hi" }]);
      expect(h.state.calls).toEqual([
        { name: "echo", args: { message: "hi" } },
      ]);
    });

    it("edits a real resource's listing, hides another, and keeps reading the rest from the real server", async () => {
      const { client } = await h.connect(
        {
          resources: {
            "test://greeting": { description: "A friendly hello." },
          },
        },
        era
      );
      const listed = await client.listResources();
      expect(listed.resources).toMatchObject([
        { uri: "test://greeting", description: "A friendly hello." },
      ]);
      expect(
        (await client.readResource({ uri: "test://greeting" })).contents[0]
      ).toMatchObject({ text: "hello" });

      const hidden = await h.connect(
        {
          resources: {
            "test://greeting": { hidden: true },
            "test://x": { text: "x" },
          },
        },
        era
      );
      expect(
        (await hidden.client.listResources()).resources.map((r) => r.uri)
      ).toEqual(["test://x"]);
      await expect(
        hidden.client.readResource({ uri: "test://greeting" })
      ).rejects.toMatchObject({
        message: expect.stringContaining("not found"),
      });
    });

    it("refuses to list when an edit points at a resource the real server no longer lists, naming it", async () => {
      const { handler } = await h.connect(
        { resources: { "test://gone": { description: "edited" } } },
        era
      );
      const list = await h.rpc(handler, era, "resources/list");
      expect(list.error).toMatchObject({
        message: expect.stringContaining('"test://gone"'),
        data: {
          mockCode: "mock_edited_item_missing",
          kind: "resource",
          items: ["test://gone"],
        },
      });
    });

    it("a mock from nothing answers its tools, a prompt, a resource and an app", async () => {
      const definition: MockDefinition = {
        serverInfo: { name: "counter", version: "1.0.0" },
        instructions: "A counter with an app.",
        tools: {
          add: {
            description: "Add two numbers.",
            inputSchema: {
              type: "object",
              properties: { a: { type: "number" }, b: { type: "number" } },
              required: ["a", "b"],
            },
            answer: {
              from: "saved",
              cases: [
                {
                  when: { a: 1, b: 1 },
                  result: { content: [{ type: "text", text: "2" }] },
                },
              ],
            },
          },
          open_counter: {
            description: "Open the counter.",
            _meta: { ui: { resourceUri: "ui://counter/app.html" } },
            answer: {
              from: "saved",
              cases: [
                { result: { content: [{ type: "text", text: "Opened." }] } },
              ],
            },
          },
        },
        prompts: { summarize: prompt },
        resources: {
          "test://notes": { name: "notes", text: "my notes" },
          "ui://counter/app.html": { text: APP },
        },
      };
      const { client } = await h.connect(definition, era, true);
      expect(client.getServerVersion()?.name).toBe("counter");
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["add", "open_counter"]);
      expect(tools[1]?._meta).toEqual({
        ui: { resourceUri: "ui://counter/app.html" },
      });
      expect(
        (await client.callTool({ name: "add", arguments: { a: 1, b: 1 } }))
          .content
      ).toEqual([{ type: "text", text: "2" }]);
      expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual([
        "summarize",
      ]);
      expect(
        (
          await client.getPrompt({
            name: "summarize",
            arguments: { topic: "x" },
          })
        ).messages
      ).toHaveLength(1);
      // With no real server there is nothing but the definition's own.
      expect(
        (await client.listResources()).resources.map((r) => r.uri)
      ).toEqual(["test://notes", "ui://counter/app.html"]);
      expect(
        (await client.readResource({ uri: "ui://counter/app.html" }))
          .contents[0]
      ).toMatchObject({ mimeType: "text/html;profile=mcp-app" });
      await expect(
        client.readResource({ uri: "test://greeting" })
      ).rejects.toMatchObject({
        message: expect.stringContaining("not found"),
      });
      await expect(client.getPrompt({ name: "nope" })).rejects.toMatchObject({
        message: expect.stringContaining("not found"),
      });
    });

    it("pages the lists it builds itself, with the one page size", async () => {
      const resources = Object.fromEntries(
        ["a", "b", "c"].map((n) => [`mem://${n}`, { text: n }])
      );
      const { handler } = await h.connect(
        { pageSize: 2, resources },
        era,
        true
      );
      const uris = (page: { result?: Record<string, any> }) =>
        page.result?.resources.map((r: { uri: string }) => r.uri);
      const first = await h.rpc(handler, era, "resources/list");
      expect(uris(first)).toEqual(["mem://a", "mem://b"]);
      const second = await h.rpc(handler, era, "resources/list", {
        cursor: first.result?.nextCursor,
      });
      expect(uris(second)).toEqual(["mem://c"]);
      expect(second.result?.nextCursor).toBeUndefined();
    });
  }
);
