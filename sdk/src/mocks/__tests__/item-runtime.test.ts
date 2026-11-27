import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
  buildMock,
  MOCK_ERROR_CODES,
  type MockDefinition,
  type MockForwardDecision,
  type MockRealServer,
} from "../index.js";
import { useItemHarness } from "./item-harness.js";
import type { Era } from "./item-harness.js";

const h = useItemHarness();

const REVISIONS: Array<[revision: string, era: Era]> = [
  ["2025-03-26", "legacy"],
  ["2025-06-18", "legacy"],
  ["2025-11-25", "legacy"],
  ["2026-07-28", "modern"],
];

const APP_HTML = "<!doctype html><button>+1</button>";
const APP_META = {
  ui: { csp: { connectDomains: ["https://api.example.test"] } },
};

describe.each(REVISIONS)(
  "families on revision %s",
  (revision: string, era: Era) => {
    it("advertises and serves what the definition adds, whichever revision asks", async () => {
      const { client } = await h.connect(
        {
          instructions: "Mock instructions.",
          prompts: {
            hello: {
              messages: [
                { role: "user", content: { type: "text", text: "Hi" } },
              ],
            },
          },
          resources: { "mem://a": { text: "a" } },
          resourceTemplates: { "mem://{id}": { text: "item {{input.id}}" } },
        },
        era,
        true,
        revision
      );
      expect(client.getServerCapabilities()).toMatchObject({
        prompts: {},
        resources: {},
      });
      expect(client.getInstructions()).toBe("Mock instructions.");
      expect((await client.listPrompts()).prompts.map((p) => p.name)).toEqual([
        "hello",
      ]);
      expect(
        (await client.listResourceTemplates()).resourceTemplates
      ).toHaveLength(1);
      expect(
        (await client.readResource({ uri: "mem://zz" })).contents[0]
      ).toMatchObject({ text: "item zz" });
    });

    it("advertises no family neither the real server nor the definition has, and answers a call to it with method not found", async () => {
      // The fixture has tools and resources but no prompts.
      const { client, handler } = await h.connect(
        { resources: { "mem://a": { text: "a" } } },
        era,
        false,
        revision
      );
      expect(client.getServerCapabilities()?.prompts).toBeUndefined();
      const refused = await h.rpc(handler, era, "prompts/list");
      expect(refused.error).toMatchObject({
        code: MOCK_ERROR_CODES.methodUnavailable,
        data: { mockCode: "mock_method_unavailable" },
      });
    });

    it("advertises neither prompts nor resources for a mock made from nothing with only a tool", async () => {
      const { client, handler } = await h.connect(
        {
          tools: {
            ping: {
              inputSchema: { type: "object", properties: {} },
              answer: {
                from: "saved",
                cases: [
                  { result: { content: [{ type: "text", text: "pong" }] } },
                ],
              },
            },
          },
        },
        era,
        true,
        revision
      );
      const capabilities = client.getServerCapabilities();
      expect(capabilities?.tools).toBeDefined();
      expect(capabilities?.prompts).toBeUndefined();
      expect(capabilities?.resources).toBeUndefined();
      for (const method of ["prompts/list", "resources/list"]) {
        expect((await h.rpc(handler, era, method)).error?.code).toBe(
          MOCK_ERROR_CODES.methodUnavailable
        );
      }
    });

    it("keeps a resource-only server tool-less, with prompts and resources of its own added", async () => {
      h.state.resourcesOnly = true;
      const { client, handler } = await h.connect(
        {
          prompts: {
            hello: {
              messages: [
                { role: "user", content: { type: "text", text: "Hi" } },
              ],
            },
          },
        },
        era,
        false,
        revision
      );
      const capabilities = client.getServerCapabilities();
      expect(capabilities?.tools).toBeUndefined();
      expect(capabilities?.prompts).toBeDefined();
      expect(capabilities?.resources).toBeDefined();
      expect((await h.rpc(handler, era, "tools/list")).error?.code).toBe(
        MOCK_ERROR_CODES.methodUnavailable
      );
      expect(
        (await client.readResource({ uri: "test://greeting" })).contents[0]
      ).toMatchObject({ text: "hello" });
    });
  }
);

describe.each<Era>(["legacy", "modern"])(
  "a backed server's prompts (%s era)",
  (era) => {
    it("serves an edited prompt's listing, omits a hidden one, and passes an untouched one through", async () => {
      h.state.withPrompts = true;
      const edited = await h.connect(
        { prompts: { greet: { title: "Say hello" } } },
        era
      );
      expect((await edited.client.listPrompts()).prompts).toMatchObject([
        { name: "greet", title: "Say hello", description: "Greets someone." },
      ]);
      // No messages of its own, so the real server answers.
      expect(
        (
          await edited.client.getPrompt({
            name: "greet",
            arguments: { who: "Ada" },
          })
        ).messages[0]
      ).toMatchObject({ content: { text: "Greet Ada." } });

      const hidden = await h.connect(
        { prompts: { greet: { hidden: true } } },
        era
      );
      expect((await hidden.client.listPrompts()).prompts).toEqual([]);
      await expect(
        hidden.client.getPrompt({ name: "greet", arguments: { who: "Ada" } })
      ).rejects.toMatchObject({
        message: expect.stringContaining("not found"),
      });
    });

    it("serves an app resource's `_meta` to the client, in the listing and in what it reads", async () => {
      const { client } = await h.connect(
        {
          tools: {
            open_counter: {
              description: "Open the counter.",
              _meta: { ui: { resourceUri: "ui://counter/app.html" } },
              answer: {
                from: "saved",
                cases: [
                  {
                    result: {
                      content: [{ type: "text", text: "Opened." }],
                      _meta: { shown: true },
                    },
                  },
                ],
              },
            },
          },
          resources: {
            "ui://counter/app.html": { text: APP_HTML, _meta: APP_META },
          },
        },
        era,
        true
      );
      const listed = (await client.listResources()).resources[0];
      expect(listed).toMatchObject({
        mimeType: "text/html;profile=mcp-app",
        _meta: APP_META,
      });
      expect(
        (await client.readResource({ uri: "ui://counter/app.html" }))
          .contents[0]
      ).toMatchObject({
        text: APP_HTML,
        mimeType: "text/html;profile=mcp-app",
        _meta: APP_META,
      });
      const called = await client.callTool({ name: "open_counter" });
      expect(called._meta).toMatchObject({ shown: true });
      expect((await client.listTools()).tools[0]?._meta).toEqual({
        ui: { resourceUri: "ui://counter/app.html" },
      });
    });
  }
);

/** A real server that serves lists in pages and counts what the mock dispatched to it. */
function pagedReal(
  decide: () => MockForwardDecision = () => ({ allowed: true })
): MockRealServer & { dispatched: string[]; asked: string[] } {
  const resources = ["a", "b", "c", "d", "e"].map((n) => ({
    uri: `mem://${n}`,
    name: n,
  }));
  const dispatched: string[] = [];
  const asked: string[] = [];
  return {
    dispatched,
    asked,
    describe: async () => ({
      serverInfo: { name: "paged", version: "1.0.0" },
      capabilities: { resources: {}, prompts: {} },
    }),
    listTools: async () => [],
    authorizeForward: async (request) => {
      asked.push(request.kind === "request" ? request.method : request.tool);
      return decide();
    },
    callTool: async () => {
      throw new Error("not used");
    },
    request: async ({ method, params }) => {
      dispatched.push(method);
      if (method === "resources/list") {
        const start = Number(params?.cursor ?? 0);
        const page = resources.slice(start, start + 2);
        return {
          resources: page,
          ...(start + 2 < resources.length && {
            nextCursor: String(start + 2),
          }),
        };
      }
      if (method === "resources/read")
        return {
          contents: [
            { uri: String(params?.uri), text: "from the real server" },
          ],
        };
      if (method === "prompts/list")
        return { prompts: [{ name: "greet", description: "Greets." }] };
      if (method === "prompts/get")
        return {
          messages: [
            { role: "user", content: { type: "text", text: "real greet" } },
          ],
        };
      return {};
    },
    onListChanged: () => () => {},
  };
}

async function connectTo(
  definition: MockDefinition,
  real: MockRealServer
): Promise<{ client: Client; handler: ReturnType<typeof buildMock> }> {
  const handler = buildMock(definition, real);
  const client = new Client({ name: "mock-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://mock.local/mcp"), {
      fetch: (input, init) =>
        handler.fetch(new Request(input as string | URL, init)),
    })
  );
  return { client, handler };
}

describe("a resource the mock does not serve", () => {
  // 2026-07-28 changed the code from -32002 to -32602 (SEP-2164).
  it("is refused with invalid params on 2026-07-28", async () => {
    const { client } = await h.connect(
      {
        resources: {
          "mem://own": { text: "own" },
          "mem://gone": { hidden: true },
        },
      },
      "modern",
      true
    );
    await expect(
      client.readResource({ uri: "mem://gone" })
    ).rejects.toMatchObject({
      code: -32602,
      data: { mockCode: "mock_resource_not_found", uri: "mem://gone" },
    });
  });
});

describe("paged listings", () => {
  // The client walks every page on its own, so read one page at a time.
  const page = async (
    handler: ReturnType<typeof buildMock>,
    cursor?: string
  ) => {
    const { result } = await h.rpc(
      handler,
      "legacy",
      "resources/list",
      cursor === undefined ? {} : { cursor }
    );
    return {
      uris: (result?.resources as Array<{ uri: string }>).map((r) => r.uri),
      description: (result?.resources as Array<{ description?: string }>).map(
        (r) => r.description
      ),
      nextCursor: result?.nextCursor as string | undefined,
    };
  };

  it("follows the real server's page size, with the definition laid over each page", async () => {
    const { handler } = await connectTo(
      {
        resources: {
          "mem://b": { hidden: true },
          "mem://c": { description: "Edited." },
          "mem://z": { text: "added" },
        },
      },
      pagedReal()
    );
    const first = await page(handler);
    expect(first.uris).toEqual(["mem://a", "mem://c"]);
    expect(first.description[1]).toBe("Edited.");
    const second = await page(handler, first.nextCursor);
    expect(second.uris).toEqual(["mem://d", "mem://e"]);
    const third = await page(handler, second.nextCursor);
    expect(third.uris).toEqual(["mem://z"]);
    expect(third.nextCursor).toBeUndefined();
  });

  it("lists an unchanged list in the real server's pages", async () => {
    const { handler } = await connectTo(
      { resources: { "mem://a": { description: "Edited." } } },
      pagedReal()
    );
    const first = await page(handler);
    expect(first.uris).toEqual(["mem://a", "mem://b"]);
    expect(first.nextCursor).toBeDefined();
  });

  it("uses the definition's page size over the real server's", async () => {
    const { handler } = await connectTo(
      { pageSize: 4, resources: { "mem://a": { description: "Edited." } } },
      pagedReal()
    );
    const first = await page(handler);
    expect(first.uris).toHaveLength(4);
    const second = await page(handler, first.nextCursor);
    expect(second.uris).toEqual(["mem://e"]);
  });
});

describe("a backed passthrough the host refuses", () => {
  const refuse = (): MockForwardDecision => ({
    allowed: false,
    reason: "blocked_by_policy",
    message:
      "Live calls are off for this workspace. Ask an admin to allow them.",
  });
  const blockedError = {
    code: MOCK_ERROR_CODES.forwardBlocked,
    message: expect.stringContaining("Live calls are off"),
    data: { mockCode: "mock_forward_blocked", reason: "blocked_by_policy" },
  };

  it.each([
    ["resources/list", {}],
    ["resources/templates/list", {}],
    ["resources/read", { uri: "mem://a" }],
    ["prompts/list", {}],
    ["prompts/get", { name: "greet", arguments: {} }],
  ])("refuses %s before anything is dispatched", async (method, params) => {
    const real = pagedReal(refuse);
    const { handler } = await connectTo(
      {
        prompts: { extra: { description: "edit" } },
        resources: { "mem://zz": { text: "own" } },
      },
      real
    );
    const answer = await h.rpc(handler, "legacy", method, params);
    // The two lists and two reads the definition edits are the mock's to
    // answer, but each reads the real server first, so each is refused.
    expect(answer.error).toMatchObject(blockedError);
    expect(real.dispatched).toEqual([]);
  });

  it("still answers a resource the definition states itself, with nothing dispatched", async () => {
    const real = pagedReal(refuse);
    const { client } = await connectTo(
      { resources: { "mem://zz": { text: "own" } } },
      real
    );
    expect(
      (await client.readResource({ uri: "mem://zz" })).contents[0]
    ).toMatchObject({ text: "own" });
    expect(real.dispatched).toEqual([]);
  });

  it("refuses a skill the real server serves, and each page of a list it asks for", async () => {
    const real = pagedReal(refuse);
    const describeReal = real.describe.bind(real);
    real.describe = async () => {
      const info = await describeReal();
      return {
        ...info,
        capabilities: {
          ...info.capabilities,
          extensions: { "io.modelcontextprotocol/skills": {} },
        },
      };
    };
    const { handler } = await connectTo(
      {
        resources: {
          "skill://own/SKILL.md": { text: "---\nname: own\n---\n" },
        },
      },
      real
    );
    const answer = await h.rpc(handler, "legacy", "skills/list");
    expect(answer.error).toMatchObject(blockedError);
    expect(real.dispatched).toEqual([]);
  });

  it("lists what the version pinned for prompts, resources and templates, with nothing dispatched", async () => {
    const real = pagedReal(refuse);
    real.pinnedListing = async (family) =>
      ({
        prompts: [{ name: "greet", description: "Pinned greeting." }],
        resources: [{ uri: "mem://pinned", name: "pinned" }],
        resourceTemplates: [{ uriTemplate: "mem://t/{id}", name: "t" }],
        tools: [],
      })[family] as never;
    const { handler } = await connectTo(
      {
        prompts: { extra: { description: "edit", messages: [] } },
        resources: { "mem://zz": { text: "own" } },
        resourceTemplates: { "mem://own/{id}": { text: "own {id}" } },
      },
      real
    );
    const prompts = await h.rpc(handler, "legacy", "prompts/list");
    expect(prompts.result?.prompts.map((p: { name: string }) => p.name)).toEqual(
      ["greet", "extra"]
    );
    const resources = await h.rpc(handler, "legacy", "resources/list");
    expect(
      resources.result?.resources.map((r: { uri: string }) => r.uri)
    ).toEqual(["mem://pinned", "mem://zz"]);
    const templates = await h.rpc(handler, "legacy", "resources/templates/list");
    expect(
      templates.result?.resourceTemplates.map(
        (t: { uriTemplate: string }) => t.uriTemplate
      )
    ).toEqual(["mem://t/{id}", "mem://own/{id}"]);
    expect(real.dispatched).toEqual([]);
  });

  it("still refuses a list when the mock has no base to pin from", async () => {
    const real = pagedReal(() => ({
      allowed: false,
      reason: "no_base",
      message: "This mock has no real server.",
    }));
    real.pinnedListing = async () => [{ uri: "mem://pinned" }] as never;
    const { handler } = await connectTo(
      { resources: { "mem://zz": { text: "own" } } },
      real
    );
    const answer = await h.rpc(handler, "legacy", "resources/list");
    expect(answer.result?.resources).toBeUndefined();
    expect(real.dispatched).toEqual([]);
  });

  it("asks the host before each page it reads, and again for the read itself", async () => {
    const real = pagedReal();
    const { client, handler } = await connectTo(
      { resources: { "mem://a": { description: "Edited." } } },
      real
    );
    await h.rpc(handler, "legacy", "resources/list");
    await client.readResource({ uri: "mem://b" });
    expect(real.asked).toEqual([
      "resources/list",
      "resources/list",
      "resources/list",
      "resources/read",
    ]);
    expect(real.dispatched).toEqual(real.asked);
  });
});
