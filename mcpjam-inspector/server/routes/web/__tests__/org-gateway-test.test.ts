import { Hono } from "hono";
import { getFunctionName, type FunctionReference } from "convex/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestLogContextMiddleware } from "../../../middleware/request-log-context.js";
import orgGatewayTest from "../org-gateway-test.js";

const { createConvexClientMock, queryMock, gatewayFetch } = vi.hoisted(() => {
  const queryMock = vi.fn();
  return {
    queryMock,
    createConvexClientMock: vi.fn(() => ({ query: queryMock })),
    gatewayFetch: vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      const body =
        path === "/v1/models" ? { data: [{ id: "claude-sonnet-4-5" }] } : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  };
});

vi.mock("../../../services/evals/route-helpers.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../services/evals/route-helpers.js")
  >()),
  createConvexClient: createConvexClientMock,
}));

vi.mock("../../../utils/hosted-egress-guard.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../utils/hosted-egress-guard.js")
  >()),
  createGuardedFetch: () => gatewayFetch,
}));

function postTest(body: Record<string, unknown>) {
  const app = new Hono();
  app.use("/api/*", requestLogContextMiddleware);
  app.route("/api/web/org-gateway-test", orgGatewayTest);
  return app.request("/api/web/org-gateway-test", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer caller-token",
    },
    body: JSON.stringify(body),
  });
}

const REQUEST = {
  organizationId: "org_1",
  baseUrl: "https://litellm.acme.example",
  secret: "sk-test",
  apis: ["chatCompletions"],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/web/org-gateway-test", () => {
  it("probes the gateway once the backend says the caller is an admin", async () => {
    queryMock.mockResolvedValue(true);

    const res = await postTest(REQUEST);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      reachable: true,
      origin: "inspector",
    });
    // Asked as the caller, with the request's own bearer.
    expect(createConvexClientMock).toHaveBeenCalledWith(
      "caller-token",
      expect.any(AbortSignal),
    );
    const [ref, args] = queryMock.mock.calls[0] as [
      FunctionReference<"query">,
      unknown,
    ];
    expect(getFunctionName(ref)).toBe(
      "organizationModelProviderTest:canTestProviderConnection",
    );
    expect(args).toEqual({ organizationId: "org_1" });
    expect(gatewayFetch).toHaveBeenCalledWith(
      "https://litellm.acme.example/v1/models",
      expect.anything(),
    );
  });

  it("refuses a member with 403 and never dials the gateway", async () => {
    queryMock.mockResolvedValue(false);

    const res = await postTest(REQUEST);

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: "FORBIDDEN",
      message:
        "Only organization admins and owners can test a gateway. Ask an admin to add it.",
    });
    expect(gatewayFetch).not.toHaveBeenCalled();
  });

  it("fails closed when the backend can't answer", async () => {
    queryMock.mockRejectedValue(new TypeError("fetch failed"));

    const res = await postTest(REQUEST);

    expect(res.status).toBe(502);
    await expect(res.json()).resolves.toMatchObject({
      message: "Couldn't check your role in this organization. Try again.",
    });
    expect(gatewayFetch).not.toHaveBeenCalled();
  });
});
