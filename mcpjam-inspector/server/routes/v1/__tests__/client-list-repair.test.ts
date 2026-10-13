import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { ConvexError } from "convex/values";
import { getFunctionName, type FunctionReference } from "convex/server";
const { query, mutation } = vi.hoisted(() => ({
  query: vi.fn(),
  mutation: vi.fn(),
}));
vi.mock("../../../utils/v1-convex-token.js", () => ({
  getConvexBearerForRequest: async () => "token",
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: vi.fn(function () {
    return { setAuth: vi.fn(), query, mutation };
  }),
}));
import clients from "../clients.js";
import { v1OnError } from "../envelope.js";

const PROJECT_ID = "p1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const CLIENT = {
  hostId: "h1",
  name: "MCPJam",
  hostConfigId: "hc1",
  modelId: "anthropic/claude-haiku-5.5",
  serverCount: 0,
  ownerScope: null,
  createdAt: 1,
  updatedAt: 2,
};
const PRIVATE_BACKING = {
  ...CLIENT,
  hostId: "h9",
  name: "Backing",
  ownerScope: { type: "user_testing" },
};

function app() {
  const root = new Hono();
  root.route("/api/v1", clients);
  root.onError((error, c) => v1OnError(error, c));
  return root;
}

async function listClients(surface = "clients") {
  const response = await app().request(
    `/api/v1/projects/${PROJECT_ID}/${surface}`,
  );
  return { status: response.status, body: await response.json() };
}

function ensureCalls() {
  return mutation.mock.calls.map(([ref, args]) => [
    getFunctionName(ref as FunctionReference<"mutation">),
    args,
  ]);
}

describe("GET /projects/:projectId/clients on a project with no client", () => {
  beforeEach(() => {
    vi.stubEnv("CONVEX_URL", "https://backend.test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
  });

  it("gives the project its default client and lists it", async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([CLIENT]);
    mutation.mockResolvedValue({ hostId: "h1", created: true });

    const { status, body } = await listClients();

    expect(status).toBe(200);
    expect(body.items.map((item: { id: string }) => item.id)).toEqual(["h1"]);
    expect(ensureCalls()).toEqual([
      ["projectClients:ensureProjectClient", { projectId: PROJECT_ID }],
    ]);
  });

  it("repairs a project whose only client is a private backing one", async () => {
    query
      .mockResolvedValueOnce([PRIVATE_BACKING])
      .mockResolvedValueOnce([PRIVATE_BACKING, CLIENT]);
    mutation.mockResolvedValue({ hostId: "h1", created: true });

    const { body } = await listClients();

    expect(body.items.map((item: { id: string }) => item.id)).toEqual(["h1"]);
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it("repairs the deprecated /hosts list too", async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([CLIENT]);
    mutation.mockResolvedValue({ hostId: "h1", created: true });

    const { status, body } = await listClients("hosts");

    expect(status).toBe(200);
    expect(body.items.map((item: { id: string }) => item.id)).toEqual(["h1"]);
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it("leaves a project that has a client alone", async () => {
    query.mockResolvedValue([CLIENT]);

    await listClients();

    expect(mutation).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("re-reads when a concurrent caller created the client first", async () => {
    query.mockResolvedValueOnce([]).mockResolvedValueOnce([CLIENT]);
    mutation.mockResolvedValue({ hostId: "h1", created: false });

    const { body } = await listClients();

    expect(body.items.map((item: { id: string }) => item.id)).toEqual(["h1"]);
  });

  it("surfaces a failed repair instead of an empty list", async () => {
    query.mockResolvedValue([]);
    mutation.mockRejectedValue(
      new ConvexError({
        code: "rate_limited",
        message: "Too many setups created right now.",
        retryAfterMs: 5_000,
      }),
    );

    const { status } = await listClients();

    expect(status).toBe(429);
  });

  it.each([
    ["a FORBIDDEN refusal", new ConvexError({ code: "FORBIDDEN" })],
    [
      "an authorization refusal",
      new ConvexError({ kind: "forbidden", message: "No access" }),
    ],
    ["a production-masked role refusal", new Error("Server Error")],
    [
      "a backend without the function",
      new Error(
        "[CONVEX M(projectClients:ensureProjectClient)] Could not find public function for 'projectClients:ensureProjectClient'",
      ),
    ],
  ])("lists what is there after %s", async (_case, error) => {
    query.mockResolvedValue([]);
    mutation.mockRejectedValue(error);

    const { status, body } = await listClients();

    expect(status).toBe(200);
    expect(body.items).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
