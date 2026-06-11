import { describe, expect, it, vi, beforeEach } from "vitest";
import { Hono } from "hono";

const runPredicatesMock = vi.hoisted(() => vi.fn());

vi.mock("../../../services/checks/run-predicates-on-chat-session.js", () => ({
  runPredicatesOnChatSession: runPredicatesMock,
}));

vi.mock("../../../services/evals/route-helpers.js", () => ({
  createConvexClient: vi.fn(() => ({ __mockConvexClient: true })),
}));

vi.mock("../auth.js", () => {
  class WebRouteError extends Error {
    status: number;
    code: string;
    details?: Record<string, unknown>;
    constructor(
      status: number,
      code: string,
      message: string,
      details?: Record<string, unknown>,
    ) {
      super(message);
      this.status = status;
      this.code = code;
      this.details = details;
    }
  }

  return {
    handleRoute: async (c: any, handler: () => Promise<any>) => {
      try {
        const result = await handler();
        return c.json(result, 200);
      } catch (error: any) {
        if (error && typeof error.status === "number" && error.code) {
          return c.json(
            { code: error.code, message: error.message },
            error.status,
          );
        }
        return c.json({ code: "INTERNAL_ERROR", message: error.message }, 500);
      }
    },
    parseWithSchema: (schema: any, body: unknown) => schema.parse(body),
    readJsonBody: async (c: any) => await c.req.json(),
    WebRouteError,
  };
});

vi.mock("../errors.js", () => {
  class WebRouteError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    WebRouteError,
    ErrorCode: { UNAUTHORIZED: "UNAUTHORIZED" },
    assertBearerToken: (c: any) => {
      const auth = c.req.header("authorization");
      if (!auth || !auth.startsWith("Bearer ")) {
        throw new WebRouteError(401, "UNAUTHORIZED", "Missing bearer token");
      }
      return auth.slice("Bearer ".length);
    },
  };
});

let app: Hono;

beforeEach(async () => {
  vi.resetModules();
  runPredicatesMock.mockReset();
  const checksModule = await import("../checks.js");
  app = new Hono();
  app.route("/", checksModule.default);
});

describe("POST /run-predicates", () => {
  it("rejects without a bearer token", async () => {
    const res = await app.request("/run-predicates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chatSessionId: "cs_1",
        predicates: [],
        setKind: "ad_hoc",
      }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ code: "UNAUTHORIZED", message: "Missing bearer token" });
    expect(runPredicatesMock).not.toHaveBeenCalled();
  });

  it("rejects invalid body shape", async () => {
    const res = await app.request("/run-predicates", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer abc",
      },
      body: JSON.stringify({
        // chatSessionId missing
        predicates: [],
        setKind: "ad_hoc",
      }),
    });
    expect(res.status).toBe(500);
    expect(runPredicatesMock).not.toHaveBeenCalled();
  });

  it("rejects invalid setKind enum", async () => {
    const res = await app.request("/run-predicates", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer abc",
      },
      body: JSON.stringify({
        chatSessionId: "cs_1",
        predicates: [],
        setKind: "not_a_real_kind",
      }),
    });
    expect(res.status).toBe(500);
    expect(runPredicatesMock).not.toHaveBeenCalled();
  });

  it("forwards a valid request to runPredicatesOnChatSession", async () => {
    runPredicatesMock.mockResolvedValue({
      checkRunId: "chk_1",
      results: [{ predicate: { type: "noToolErrors" }, passed: true, reason: "ok" }],
    });

    const res = await app.request("/run-predicates", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer xyz",
      },
      body: JSON.stringify({
        chatSessionId: "cs_1",
        predicates: [{ type: "noToolErrors" }],
        setKind: "suite_defaults",
        setRef: "suite_42",
        setVersion: 3,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      checkRunId: "chk_1",
      results: [{ predicate: { type: "noToolErrors" }, passed: true, reason: "ok" }],
    });

    expect(runPredicatesMock).toHaveBeenCalledTimes(1);
    const call = runPredicatesMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      authHeader: "Bearer xyz",
      chatSessionId: "cs_1",
      predicates: [{ type: "noToolErrors" }],
      setKind: "suite_defaults",
      setRef: "suite_42",
      setVersion: 3,
    });
  });

  it("omits optional fields from the orchestrator args when not in body", async () => {
    runPredicatesMock.mockResolvedValue({ checkRunId: "chk_2", results: [] });

    const res = await app.request("/run-predicates", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer xyz",
      },
      body: JSON.stringify({
        chatSessionId: "cs_2",
        predicates: [{ type: "noToolErrors" }],
        setKind: "ad_hoc",
      }),
    });

    expect(res.status).toBe(200);
    const call = runPredicatesMock.mock.calls[0]?.[0];
    expect(call).not.toHaveProperty("setRef");
    expect(call).not.toHaveProperty("setVersion");
    expect(call).not.toHaveProperty("triggeredBy");
  });

  it("propagates errors from the orchestrator as 500", async () => {
    runPredicatesMock.mockRejectedValue(
      new Error("ChatSession not found or unauthorized"),
    );

    const res = await app.request("/run-predicates", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        authorization: "Bearer xyz",
      },
      body: JSON.stringify({
        chatSessionId: "cs_x",
        predicates: [{ type: "noToolErrors" }],
        setKind: "ad_hoc",
      }),
    });

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.message).toContain("ChatSession not found or unauthorized");
  });
});
