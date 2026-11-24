import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../routes/web/auth.js", () => ({
  buildConvexAuthHeaders: (_caller: unknown, bearer: string) => ({
    Authorization: `Bearer ${bearer}`,
  }),
  createAuthorizedManager: vi.fn(),
}));

import { mockConnectionPool } from "../connection.js";
import { MOCK_LISTING_HASH_HEADER, MOCK_VERSION_HEADER, serveMock } from "../route.js";
import { MockRefusal } from "../refusal.js";
import { dialMock, resolvedMock, stubRealServer, type StubReal } from "./helpers.js";
import type { MockDoor } from "../route.js";

const profile = { timeoutMs: 5_000 };
const inProcess = (who: string, extra: Partial<MockDoor> = {}): MockDoor =>
  ({
    kind: "in-process",
    grant: `grant-for-${who}`,
    bearerToken: `bearer-${who}`,
    caller: { authMethod: "authkit_jwt", workosUserId: who },
    projectId: "proj1",
    profile,
    ...extra,
  }) as MockDoor;

let stub: StubReal;
beforeEach(() => {
  stub = stubRealServer();
});
afterEach(async () => {
  await mockConnectionPool.clear();
});

const deps = () => ({
  open: stub.open,
  resolve: vi.fn(async () => resolvedMock()),
});

describe("a mock served in process", () => {
  it("lists the real server's tools with the definition's edit, and calls the same real tool", async () => {
    const d = deps();
    const client = await dialMock((r) => serveMock(r, "mock1", inProcess("ann"), d));
    const listed = await client.listTools("mock");
    expect(listed.tools.map((t) => [t.name, t.description])).toEqual([
      ["echo", "MOCKED echo"],
      ["other", "Another tool."],
    ]);
    const result = (await client.executeTool("mock", "echo", { message: "hi" })) as {
      content: Array<{ text: string }>;
    };
    expect(result.content[0].text).toBe("echo: hi");
    expect(stub.echoes).toEqual(["hi"]);
    await client.disconnectAllServers();
  });

  it("answers each tools/list with the version served and the hash of the real listing", async () => {
    const d = deps();
    const seen: Headers[] = [];
    const client = await dialMock(async (r) => {
      const response = await serveMock(r, "mock1", inProcess("ann"), d);
      seen.push(response.headers);
      return response;
    });
    await client.listTools("mock");
    const withHash = seen.find((h) => h.get(MOCK_LISTING_HASH_HEADER));
    expect(withHash?.get(MOCK_LISTING_HASH_HEADER)).toMatch(/^[0-9a-f]{64}$/);
    expect(seen.every((h) => h.get(MOCK_VERSION_HEADER) === "2")).toBe(true);
    await client.disconnectAllServers();
  });

  it("changes the hash when the real listing changes, whatever the mock edits", async () => {
    const d = deps();
    const hashes: string[] = [];
    const client = await dialMock(async (r) => {
      const response = await serveMock(r, "mock1", inProcess("ann"), d);
      const hash = response.headers.get(MOCK_LISTING_HASH_HEADER);
      if (hash) hashes.push(hash);
      return response;
    });
    await client.listTools("mock");
    stub.hideTools.add("other");
    await client.listTools("mock");
    expect(hashes.length).toBeGreaterThanOrEqual(2);
    expect(new Set(hashes).size).toBe(2);
    await client.disconnectAllServers();
  });

  it("refuses to list when an edited tool is gone, and names the tool and no address", async () => {
    const d = deps();
    stub.hideTools.add("echo");
    const client = await dialMock((r) => serveMock(r, "mock1", inProcess("ann"), d));
    const failure = await client.listTools("mock").catch((error: Error) => error);
    expect(String((failure as Error).message)).toContain('"echo"');
    expect(String((failure as Error).message)).not.toMatch(/real\.test|mock\.mcpjam/);
    await client.disconnectAllServers();
  });

  it("refuses a grant minted for another project", async () => {
    const response = await serveMock(
      new Request("https://mock.mcpjam.invalid/mock1", { method: "POST", body: "{}" }),
      "mock1",
      inProcess("ann", { projectId: "other-project" } as Partial<MockDoor>),
      deps(),
    );
    expect(response.status).toBe(403);
  });

  it("serves a mock made from nothing with no real server", async () => {
    const d = {
      open: stub.open,
      resolve: vi.fn(async () =>
        resolvedMock({
          baseServerId: null,
          definition: { tools: {} },
        }),
      ),
    };
    const client = await dialMock((r) => serveMock(r, "mock1", inProcess("ann"), d));
    expect((await client.listTools("mock")).tools).toEqual([]);
    expect(stub.opens).toBe(0);
    await client.disconnectAllServers();
  });

  it("answers a real server it cannot open as a handshake error that names nothing", async () => {
    const d = {
      open: vi.fn(async () => {
        throw Object.assign(new Error("Server Acme at https://secret.example/mcp refused"), {
          status: 401,
        });
      }),
      resolve: vi.fn(async () => resolvedMock()),
    };
    const response = await serveMock(
      new Request("https://mock.mcpjam.invalid/mock1", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
      "mock1",
      inProcess("ann"),
      d,
    );
    const text = await response.text();
    expect(text).toContain("mock_real_unreachable");
    expect(text).not.toMatch(/secret\.example|Acme/);
  });
});

describe("two callers on one mock in one process", () => {
  it("each reaches the real server with its own credentials, over its own connection", async () => {
    const d = deps();
    const ann = await dialMock((r) => serveMock(r, "mock1", inProcess("ann"), d));
    const bob = await dialMock((r) => serveMock(r, "mock1", inProcess("bob"), d));
    for (let round = 0; round < 3; round += 1) {
      await ann.executeTool("mock", "echo", { message: `ann-${round}` });
      await bob.executeTool("mock", "echo", { message: `bob-${round}` });
    }
    expect(stub.echoes).toEqual(["ann-0", "bob-0", "ann-1", "bob-1", "ann-2", "bob-2"]);
    // One connection each, kept between calls, never shared.
    expect(stub.opens).toBe(2);
    const seen = new Set(stub.credentials);
    expect(seen).toEqual(new Set(["ann:bearer-ann", "bob:bearer-bob"]));
    await ann.disconnectAllServers();
    await bob.disconnectAllServers();
  });

  it("keys the connection by the bearer too, so one user's two tokens do not share it", async () => {
    const d = deps();
    const first = await dialMock((r) => serveMock(r, "mock1", inProcess("ann"), d));
    const second = await dialMock((r) =>
      serveMock(r, "mock1", inProcess("ann", { bearerToken: "another-token" } as Partial<MockDoor>), d),
    );
    await first.executeTool("mock", "echo", { message: "a" });
    await second.executeTool("mock", "echo", { message: "b" });
    expect(stub.opens).toBe(2);
    expect(new Set(stub.credentials)).toEqual(new Set(["ann:bearer-ann", "ann:another-token"]));
    await first.disconnectAllServers();
    await second.disconnectAllServers();
  });
});

describe("refusals", () => {
  it("name the reason in JSON-RPC and nothing of the real server", async () => {
    const response = await serveMock(
      new Request("https://mock.mcpjam.invalid/mock1", { method: "POST", body: "{}" }),
      "mock1",
      inProcess("ann"),
      {
        open: stub.open,
        resolve: vi.fn(async () => {
          throw new MockRefusal("forbidden");
        }),
      },
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      error: { data: { mockCode: "mock_forbidden" } },
    });
    expect(JSON.stringify(body)).not.toMatch(/real1|proj1|bearer-ann|grant-for/);
  });

  it("answer 503 with a retry hint at the HTTP door while mocks are paused", async () => {
    const response = await serveMock(
      new Request("https://mock.mcpjam.invalid/mock1", { method: "POST", body: "{}" }),
      "mock1",
      {
        kind: "http",
        bearerToken: "bearer-ann",
        caller: { authMethod: "workos_api_key", workosUserId: "ann" },
        profile,
      } as MockDoor,
      {
        open: stub.open,
        resolve: vi.fn(async () => {
          throw new MockRefusal("paused");
        }),
      },
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    const body = await response.json();
    expect(body).toMatchObject({ error: { data: { mockCode: "mock_serving_paused" } } });
    expect(body.error.message).toContain("paused mock servers");
    expect(stub.opens).toBe(0);
  });

  it("give a dialer an error it can show while mocks are paused", async () => {
    const response = await serveMock(
      new Request("https://mock.mcpjam.invalid/mock1", { method: "POST", body: "{}" }),
      "mock1",
      inProcess("ann"),
      {
        open: stub.open,
        resolve: vi.fn(async () => {
          throw new MockRefusal("paused");
        }),
      },
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    const body = await response.json();
    expect(body.error.message).toBe(
      "MCPJam has paused mock servers. Try again in a few minutes; your own servers are not affected.",
    );
    expect(stub.opens).toBe(0);
  });

  it("turn an unexpected failure into a generic unavailable answer", async () => {
    const response = await serveMock(
      new Request("https://mock.mcpjam.invalid/mock1", { method: "POST", body: "{}" }),
      "mock1",
      inProcess("ann"),
      {
        open: stub.open,
        resolve: vi.fn(async () => {
          throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
        }),
      },
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("10.0.0.5");
  });
});
