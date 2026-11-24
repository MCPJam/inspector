import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../routes/web/auth.js", () => ({
  buildConvexAuthHeaders: (_caller: unknown, bearer: string) => ({
    Authorization: `Bearer ${bearer}`,
  }),
  createAuthorizedManager: vi.fn(),
}));

import { mockConnectionPool } from "../connection.js";
import { MOCK_ANSWERED_HEADER, serveMock } from "../route.js";
import {
  recordUnmatchedCalls,
  resetUnmatchedReportsForTests,
} from "../unmatched.js";
import {
  dialMock,
  resolvedMock,
  stubRealServer,
  type StubReal,
} from "./helpers.js";
import type { MockDoor } from "../route.js";

const door = (who: string): MockDoor => ({
  kind: "in-process",
  grant: `grant-for-${who}`,
  bearerToken: `bearer-${who}`,
  caller: { authMethod: "authkit_jwt", workosUserId: who },
  projectId: "proj1",
  profile: { timeoutMs: 5_000 },
});

const saved = resolvedMock({
  definition: {
    tools: {
      echo: {
        answer: {
          from: "saved",
          cases: [
            {
              when: { message: "hello" },
              result: {
                content: [{ type: "text", text: "saved: {{input.message}}" }],
              },
            },
          ],
        },
      },
    },
  },
});

let stub: StubReal;
beforeEach(() => {
  stub = stubRealServer();
  resetUnmatchedReportsForTests();
  vi.stubEnv("CONVEX_HTTP_URL", "https://convex.test");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await mockConnectionPool.clear();
});

describe("V9 at the route", () => {
  it("a matching call is answered by the mock, marked on the response header only, and the real server hears nothing", async () => {
    const deps = {
      open: stub.open,
      resolve: vi.fn(async () => saved),
      recordUnmatched: vi.fn(),
    };
    const marks: Array<string | null> = [];
    const client = await dialMock(async (r) => {
      const response = await serveMock(r, "mock1", door("ann"), deps);
      marks.push(response.headers.get(MOCK_ANSWERED_HEADER));
      return response;
    });
    const result = (await client.executeTool("mock", "echo", {
      message: "hello",
    })) as {
      content: Array<{ text: string }>;
    };
    expect(result.content).toEqual([{ type: "text", text: "saved: hello" }]);
    expect(JSON.stringify(result)).not.toContain("mock");
    expect(stub.echoes).toEqual([]);
    expect(marks).toContain("echo=saved");
    expect(deps.recordUnmatched).not.toHaveBeenCalled();
    await client.disconnectAllServers();
  });

  it("a call no case matched reaches the real server once and is recorded for the mock", async () => {
    const deps = {
      open: stub.open,
      resolve: vi.fn(async () => saved),
      recordUnmatched: vi.fn(async () => {}),
    };
    const client = await dialMock((r) =>
      serveMock(r, "mock1", door("ann"), deps),
    );
    const result = (await client.executeTool("mock", "echo", {
      message: "other",
    })) as {
      content: Array<{ text: string }>;
    };
    expect(result.content[0].text).toBe("echo: other");
    expect(stub.echoes).toEqual(["other"]);
    await vi.waitFor(() =>
      expect(deps.recordUnmatched).toHaveBeenCalledTimes(1),
    );
    expect(deps.recordUnmatched).toHaveBeenCalledWith(
      expect.objectContaining({
        bearerToken: "bearer-ann",
        calls: [
          {
            mockId: "mock1",
            version: 2,
            tool: "echo",
            arguments: { message: "other" },
          },
        ],
      }),
    );
    await client.disconnectAllServers();
  });
});

describe("recordUnmatchedCalls", () => {
  const caller = { authMethod: "authkit_jwt" as const, workosUserId: "ann" };
  const call = {
    mockId: "m",
    version: 1,
    tool: "echo",
    arguments: { message: "x" },
  };

  it("posts each distinct call once a minute, with the caller's bearer", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const input = {
      caller,
      bearerToken: "tok",
      calls: [call, call, { ...call, arguments: { message: "y" } }],
    };
    await recordUnmatchedCalls(input, { fetch: fetchMock as never });
    await recordUnmatchedCalls(input, { fetch: fetchMock as never });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://convex.test/web/mock/unmatched");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tok",
    );
    expect(JSON.parse(init.body as string)).toMatchObject({
      mockId: "m",
      version: 1,
      tool: "echo",
      arguments: { message: "x" },
    });
  });

  it("logs a failure and never throws", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("down");
    });
    await expect(
      recordUnmatchedCalls(
        { caller, bearerToken: "tok", calls: [call] },
        { fetch: fetchMock as never },
      ),
    ).resolves.toBeUndefined();
  });

  it("sends no input when it is too big to keep", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    await recordUnmatchedCalls(
      {
        caller,
        bearerToken: "tok",
        calls: [{ ...call, arguments: { big: "x".repeat(9_000) } }],
      },
      { fetch: fetchMock as never },
    );
    const body = JSON.parse(
      (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(body.arguments).toEqual({});
  });
});

describe("V10 at the route: a mock from nothing, in process", () => {
  const nothing = resolvedMock({
    baseServerId: null,
    definition: {
      tools: {
        add: {
          inputSchema: {
            type: "object",
            properties: { a: { type: "number" } },
          },
          answer: {
            from: "saved",
            cases: [{ result: { content: [{ type: "text", text: "2" }] } }],
          },
        },
      },
      prompts: {
        summarize: {
          arguments: [{ name: "topic" }],
          messages: [
            {
              role: "user",
              content: { type: "text", text: "Summarize {{input.topic}}." },
            },
          ],
        },
      },
      resources: {
        "skill://triage/SKILL.md": {
          text: "---\nname: triage\ndescription: Sort.\n---\nBody",
        },
        "ui://counter/app.html": { text: "<button>+1</button>" },
      },
    },
  });

  it("lists and answers every family with no real server and no request beyond the route", async () => {
    const deps = {
      resolve: vi.fn(async () => nothing),
      recordUnmatched: vi.fn(),
    };
    const client = await dialMock((r) =>
      serveMock(r, "mock1", door("ann"), deps),
    );
    expect((await client.listTools("mock")).tools.map((t) => t.name)).toEqual([
      "add",
    ]);
    expect(
      (
        (await client.executeTool("mock", "add", { a: 1 })) as {
          content: unknown[];
        }
      ).content,
    ).toEqual([{ type: "text", text: "2" }]);
    expect(
      (await client.listPrompts("mock")).prompts.map((p) => p.name),
    ).toEqual(["summarize"]);
    const prompt = await client.getPrompt("mock", {
      name: "summarize",
      arguments: { topic: "tides" },
    });
    expect(prompt.messages[0]).toMatchObject({
      content: { text: "Summarize tides." },
    });
    expect(
      (await client.listResources("mock")).resources.map((r) => r.uri),
    ).toEqual(["skill://triage/SKILL.md", "ui://counter/app.html"]);
    const app = await client.readResource("mock", {
      uri: "ui://counter/app.html",
    });
    expect(app.contents[0]).toMatchObject({
      text: "<button>+1</button>",
      mimeType: "text/html;profile=mcp-app",
    });
    expect(deps.recordUnmatched).not.toHaveBeenCalled();
    await client.disconnectAllServers();
  });
});
