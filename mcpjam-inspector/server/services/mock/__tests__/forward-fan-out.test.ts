/**
 * The in-process door's fan-out limit: one caller's forwards to real servers
 * are held to an allowance, a limited forward never reaches the real server,
 * and another caller's allowance is untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config.js")>()),
  HOSTED_MODE: true,
}));
vi.mock("../../../routes/web/auth.js", () => ({
  buildConvexAuthHeaders: (_caller: unknown, bearer: string) => ({ Authorization: `Bearer ${bearer}` }),
  createAuthorizedManager: vi.fn(),
}));

import { MCPClientManager } from "@mcpjam/sdk";
import { startTicketHttp, type RunningTicketServer } from "../../../routes/mcp/__tests__/helpers/ticket-server.js";
import type { OpenReal } from "../connection.js";
import { MOCK_FORWARDS_PER_MINUTE, resetMockForwardFanOutForTests } from "../forward-fan-out.js";
import { serveMock, type MockDoor } from "../route.js";
import { dialMock, resolvedMock } from "./helpers.js";

let ticket: RunningTicketServer & { url: string };

const open: OpenReal = async () => ({
  manager: new MCPClientManager({}, { lazyConnect: true }),
  config: { url: ticket.url },
});

const inProcess = (who: string): MockDoor => ({
  kind: "in-process",
  grant: "grant",
  bearerToken: `bearer-${who}`,
  caller: { authMethod: "workos_api_key", workosUserId: who },
  projectId: "proj1",
  profile: { timeoutMs: 5_000 },
});
const httpDoor = (who: string): MockDoor => ({
  kind: "http",
  bearerToken: who,
  caller: { authMethod: "workos_api_key", workosUserId: who },
  profile: { timeoutMs: 5_000 },
});

const serve = (door: MockDoor) => (request: Request) =>
  serveMock(request, "mock1", door, {
    resolve: async () => resolvedMock({ definition: {}, baseServerId: "real1" }),
    open,
    check: async () => ({ allowed: true }),
  });

type Result = { isError?: boolean; content: Array<{ text: string }> };

/** Calls the real `echo` `times` times through one dialer; every call is a forward. */
async function forward(door: MockDoor, times: number): Promise<Result[]> {
  const client = await dialMock(serve(door));
  try {
    const results: Result[] = [];
    for (let i = 0; i < times; i += 1) results.push((await client.executeTool("mock", "echo", { message: "hi" })) as Result);
    return results;
  } finally {
    await client.disconnectAllServers();
  }
}

beforeEach(async () => {
  ticket = await startTicketHttp();
  resetMockForwardFanOutForTests();
});
afterEach(async () => {
  await ticket.close();
});

describe("forwards from the in-process door", () => {
  it("stops one caller at its allowance, with a tool error that says to wait, and dispatches nothing more", async () => {
    const results = await forward(inProcess("ann"), MOCK_FORWARDS_PER_MINUTE + 1);
    expect(results.slice(0, MOCK_FORWARDS_PER_MINUTE).every((r) => !r.isError)).toBe(true);
    const limited = results[MOCK_FORWARDS_PER_MINUTE];
    expect(limited.isError).toBe(true);
    expect(limited.content[0].text).toMatch(/too fast.*wait \d+ seconds/i);
    expect(ticket.dispatchCount()).toBe(MOCK_FORWARDS_PER_MINUTE);
  }, 60_000);

  it("leaves another caller's allowance alone", async () => {
    await forward(inProcess("ann"), MOCK_FORWARDS_PER_MINUTE + 1);
    const before = ticket.dispatchCount();
    const [result] = await forward(inProcess("bob"), 1);
    expect(result.isError).toBeFalsy();
    expect(ticket.dispatchCount()).toBe(before + 1);
  }, 60_000);

  it("does not meter the HTTP door, which has its own limits", async () => {
    await forward(inProcess("ann"), MOCK_FORWARDS_PER_MINUTE);
    const [result] = await forward(httpDoor("ann"), 1);
    expect(result.isError).toBeFalsy();
  }, 60_000);
});
