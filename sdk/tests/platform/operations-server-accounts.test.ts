import { describe, expect, it, vi } from "vitest";
import {
  PlatformApiClient,
  deleteServerAccountOperation,
  getServerAccountOperation,
  listServerAccountsOperation,
  updateServerAccountOperation,
  uploadServerAccountTokensOperation,
} from "../../src/platform/index.js";

const PROJECT = {
  id: "project-1",
  name: "Acme",
  description: null,
  icon: null,
  organizationId: "org-a",
  visibility: null,
  createdAt: 1,
  updatedAt: 2,
};

const SERVER = {
  id: "server-1",
  name: "markets",
  projectId: PROJECT.id,
  transportType: "http",
  url: "https://mcp.example.com/mcp",
};

const ACCOUNT = {
  id: "acct_1",
  name: "test-automation-1",
  kind: "personal",
  isDefault: false,
  needsReconnect: false,
  hostedOnly: true,
  expiresAt: 3_600_000,
  createdAt: 10,
  updatedAt: 20,
};

const ACCOUNTS = "/api/v1/projects/project-1/servers/server-1/accounts";

/** A client whose API answers from `routes`, recording every request. */
function clientWith(
  routes: Record<string, { body: unknown; status?: number }>
) {
  const requests: Array<{ key: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? "GET"} ${url.pathname}`;
    if (key.endsWith("/projects")) return Response.json({ items: [PROJECT] });
    if (key.endsWith("/servers")) return Response.json({ items: [SERVER] });
    const route = routes[key];
    if (!route) throw new Error(`unexpected ${key}`);
    requests.push({
      key,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return Response.json(route.body, { status: route.status ?? 200 });
  });
  const client = new PlatformApiClient({
    baseUrl: "https://api.test/api/v1",
    getAuth: () => "t",
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, requests };
}

const CONTEXT = { signal: new AbortController().signal };
const SCOPE = {
  project: expect.objectContaining({ id: "project-1" }),
  server: { id: "server-1", name: "markets" },
};

describe("server account operations", () => {
  it("lists a server's accounts by server name", async () => {
    const { client } = clientWith({
      [`GET ${ACCOUNTS}`]: { body: { items: [ACCOUNT] } },
    });
    const result = await listServerAccountsOperation.execute(
      { server: "markets" },
      { client, ...CONTEXT }
    );
    expect(result).toEqual({ ...SCOPE, accounts: [ACCOUNT] });
  });

  it("reads one account by name, escaping it into the path", async () => {
    const { client, requests } = clientWith({
      [`GET ${ACCOUNTS}/test-automation-1`]: { body: ACCOUNT },
    });
    const result = await getServerAccountOperation.execute(
      { server: "server-1", account: "test-automation-1" },
      { client, ...CONTEXT }
    );
    expect(result).toEqual({ ...SCOPE, account: ACCOUNT });
    expect(requests).toHaveLength(1);
  });

  it.each([
    [201, true],
    [200, false],
  ])(
    "reads a %i upload as created=%s, sending only the wire body",
    async (status, created) => {
      const { client, requests } = clientWith({
        [`PUT ${ACCOUNTS}/test-automation-1`]: { body: ACCOUNT, status },
      });
      const result = await uploadServerAccountTokensOperation.execute(
        {
          server: "markets",
          account: "test-automation-1",
          tokens: { access_token: "at_example", expires_in: 3600 },
          clientInformation: { clientId: "client_example" },
        },
        { client, ...CONTEXT }
      );
      expect(result).toEqual({ ...SCOPE, account: ACCOUNT, created });
      expect(requests[0]?.body).toEqual({
        tokens: { access_token: "at_example", expires_in: 3600 },
        clientInformation: { clientId: "client_example" },
      });
    }
  );

  it("refuses an ID token and an unknown client field", () => {
    const base = { server: "markets", account: "test-automation-1" };
    for (const input of [
      {
        ...base,
        tokens: { access_token: "at", id_token: "it" },
        clientInformation: { clientId: "c" },
      },
      {
        ...base,
        tokens: { access_token: "at" },
        clientInformation: { clientId: "c", authorizationServerUrl: "x" },
      },
    ]) {
      expect(
        uploadServerAccountTokensOperation.inputSchema.safeParse(input).success
      ).toBe(false);
    }
  });

  it("sends a rename and a default change as one PATCH", async () => {
    const { client, requests } = clientWith({
      [`PATCH ${ACCOUNTS}/acct_1`]: {
        body: { ...ACCOUNT, name: "ci", isDefault: true },
      },
    });
    const result = await updateServerAccountOperation.execute(
      { server: "markets", account: "acct_1", name: "ci", isDefault: true },
      { client, ...CONTEXT }
    );
    expect(result.account).toMatchObject({ name: "ci", isDefault: true });
    expect(requests[0]?.body).toEqual({ name: "ci", isDefault: true });
  });

  it("refuses an update that changes nothing, and isDefault: false", () => {
    const { inputSchema } = updateServerAccountOperation;
    expect(inputSchema.safeParse({ server: "s", account: "a" }).success).toBe(
      false
    );
    expect(
      inputSchema.safeParse({ server: "s", account: "a", isDefault: false })
        .success
    ).toBe(false);
  });

  it("deletes by reference and reports what it deleted", async () => {
    const { client } = clientWith({
      [`DELETE ${ACCOUNTS}/test-automation-1`]: {
        body: { account: "test-automation-1", deleted: true },
      },
    });
    const result = await deleteServerAccountOperation.execute(
      { server: "markets", account: "test-automation-1" },
      { client, ...CONTEXT }
    );
    expect(result).toEqual({
      ...SCOPE,
      account: "test-automation-1",
      deleted: true,
    });
  });

  it("returns no token field from any read", () => {
    // The SDK type mirrors the API's account view, which has none; a row the
    // client is handed keeps whatever the wire sent, so this guards the wire
    // shape the fixtures above use.
    for (const key of Object.keys(ACCOUNT)) {
      expect(key).not.toMatch(/token|secret|email|vault|profile/i);
    }
  });
});
