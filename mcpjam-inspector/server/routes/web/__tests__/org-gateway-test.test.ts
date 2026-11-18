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

vi.mock("../../../utils/checked-address-fetch.js", async (importActual) => ({
  ...(await importActual<
    typeof import("../../../utils/checked-address-fetch.js")
  >()),
  createCheckedAddressFetch: () => gatewayFetch,
}));

const { reportMock } = vi.hoisted(() => ({ reportMock: vi.fn() }));

vi.mock("../../../utils/route-error-report.js", () => ({
  reportRouteFailure: reportMock,
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

/** A Convex document-id-shaped organization id. */
const ORG_ID = "js7abc0def1ghj2klm3nop4qrs5tuv6w";

const REQUEST = {
  organizationId: ORG_ID,
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
    expect(args).toEqual({ organizationId: ORG_ID });
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
        "Only organization admins and owners can test a custom provider. Ask an admin to add it.",
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
    expect(reportMock).toHaveBeenCalledOnce();
  });

  it("answers a redacted backend failure with 502 and a report", async () => {
    // What production Convex sends for any non-ConvexError, including an
    // argument it rejected: no way to tell it from an outage.
    queryMock.mockRejectedValue(
      new Error(
        "[CONVEX Q(organizationModelProviderTest:canTestProviderConnection)] [Request ID: 7d1b] Server Error",
      ),
    );

    const res = await postTest(REQUEST);

    expect(res.status).toBe(502);
    expect(gatewayFetch).not.toHaveBeenCalled();
    expect(reportMock).toHaveBeenCalledOnce();
  });

  it("refuses a malformed organization id with 403 before asking the backend", async () => {
    const res = await postTest({ ...REQUEST, organizationId: "not-an-org" });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: "FORBIDDEN",
      message:
        "Only organization admins and owners can test a custom provider. Ask an admin to add it.",
    });
    expect(queryMock).not.toHaveBeenCalled();
    expect(gatewayFetch).not.toHaveBeenCalled();
    expect(reportMock).not.toHaveBeenCalled();
  });
});
