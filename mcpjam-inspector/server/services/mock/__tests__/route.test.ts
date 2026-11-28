import { describe, expect, it, vi } from "vitest";

vi.mock("../../../routes/web/auth.js", () => ({
  buildConvexAuthHeaders: (_caller: unknown, bearer: string) => ({
    Authorization: `Bearer ${bearer}`,
  }),
}));

import { MOCK_VERSION_HEADER, serveMock, type MockDoor } from "../route.js";
import { MockRefusal } from "../refusal.js";
import { dialMock, resolvedMock } from "./helpers.js";

const door = (who: string): MockDoor => ({
  kind: "http",
  profile: { timeoutMs: 5_000 },
  bearerToken: `bearer-${who}`,
  caller: { authMethod: "workos_api_key", workosUserId: who },
});
const post = (body: unknown) =>
  new Request("https://mock.test/mock1", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });

describe("a resolved mock", () => {
  it("serves its tools and answers a call from the saved case", async () => {
    const resolve = vi.fn(async () => resolvedMock());
    const client = await dialMock((r) => serveMock(r, "mock1", door("ann"), { resolve }));
    const listed = await client.listTools("mock");
    expect(listed.tools.map((t) => [t.name, t.description])).toEqual([["greet", "Greets"]]);
    const result = (await client.executeTool("mock", "greet", { who: "x" })) as {
      content: Array<{ text: string }>;
    };
    expect(result.content[0].text).toBe("hello");
    await client.disconnectAllServers();
  });

  it("names the version it served on every response", async () => {
    const seen: Array<string | null> = [];
    const client = await dialMock(async (r) => {
      const response = await serveMock(r, "mock1", door("ann"), {
        resolve: async () => resolvedMock({ version: 7 }),
      });
      seen.push(response.headers.get(MOCK_VERSION_HEADER));
      return response;
    });
    await client.listTools("mock");
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen)).toEqual(new Set(["7"]));
    await client.disconnectAllServers();
  });

  it("asks the backend about the caller on every request, so a revoked caller is refused on the next", async () => {
    let revoked = false;
    const resolve = vi.fn(async () => {
      if (revoked) throw new MockRefusal("forbidden");
      return resolvedMock();
    });
    const first = await serveMock(post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), "mock1", door("ann"), { resolve });
    expect(first.status).toBe(200);
    revoked = true;
    const second = await serveMock(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }), "mock1", door("ann"), { resolve });
    expect(second.status).toBe(403);
    expect(await second.json()).toMatchObject({ error: { data: { mockCode: "mock_forbidden" } } });
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("advertises no tools, and answers tools/list as unknown, for a definition with none", async () => {
    const resolve = async () => resolvedMock({ definition: { instructions: "Resources only." } });
    const init = await serveMock(
      post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
      }),
      "mock1",
      door("ann"),
      { resolve },
    );
    const initBody = await init.text();
    expect(initBody).toContain("Resources only.");
    expect(initBody).not.toContain('"tools"');
    const list = await serveMock(post({ jsonrpc: "2.0", id: 2, method: "tools/list" }), "mock1", door("ann"), { resolve });
    expect(await list.text()).toContain("-32601");
  });
});

describe("refusals", () => {
  it("name the flag when it is off, and nothing of the mock", async () => {
    const response = await serveMock(post({}), "mock1", door("ann"), {
      resolve: async () => {
        throw new MockRefusal("flag_off");
      },
    });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.data.mockCode).toBe("mock_servers_disabled");
    expect(body.error.message).toContain("mock-servers-enabled");
  });

  it("turn an unexpected failure into a generic unavailable answer", async () => {
    const response = await serveMock(post({}), "mock1", door("ann"), {
      resolve: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.5:5432");
      },
    });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("10.0.0.5");
  });
});
