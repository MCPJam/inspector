/**
 * The request-log backstop: every Ask MCPJam response ≥400 reaches Sentry
 * exactly once, and every Ask MCPJam response says whether it did.
 *
 * It exists for the failures no route catch holds — the bearer 401 and the
 * guest/passthrough 429s are answered by middleware in front of the route —
 * and it decides from the RECORDED capture outcome, never from the capture
 * stamp, which a decline sets too.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

vi.mock("@axiomhq/js", () => ({
  Axiom: vi.fn().mockImplementation(() => ({
    ingest: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("../../utils/logger.js", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn(),
    event: vi.fn(),
    systemEvent: vi.fn(),
  },
  captureOriginErrorToSentry: vi.fn(),
}));

import {
  FAILURE_CAPTURED_HEADER,
  requestLogContextMiddleware,
} from "../request-log-context.js";
import { captureOriginErrorToSentry } from "../../utils/logger.js";

const capture = vi.mocked(captureOriginErrorToSentry);

function captureTags(index = 0) {
  return (capture.mock.calls[index]?.[1] as { tags: Record<string, string> })
    .tags;
}

function app(register: (app: Hono) => void, prefix: "/api/*" = "/api/*"): Hono {
  const hono = new Hono();
  hono.use(prefix, requestLogContextMiddleware);
  register(hono);
  return hono;
}

const AGENT = "/api/web/mcpjam-agent";

describe("request-log backstop for Ask MCPJam", () => {
  beforeEach(() => {
    capture.mockClear();
  });

  it("captures a bearer 401 nothing else held, as routine", async () => {
    const res = await app((a) =>
      a.post(AGENT, (c) => c.json({ error: "Unauthorized" }, 401)),
    ).request(AGENT, { method: "POST" });

    expect(res.status).toBe(401);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(captureTags()).toMatchObject({
      surface: "mcpjam_agent",
      page_class: "routine",
    });
    expect(res.headers.get(FAILURE_CAPTURED_HEADER)).toBe("1");
  });

  it("captures a 400 validation error once, as routine", async () => {
    const res = await app((a) =>
      a.post(AGENT, (c) => {
        c.set("webErrorMeta", {
          status: 400,
          code: "VALIDATION_ERROR",
          message: "Invalid request body",
        });
        return c.json({ code: "VALIDATION_ERROR" }, 400);
      }),
    ).request(AGENT, { method: "POST" });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(captureTags()).toMatchObject({
      page_class: "routine",
      agent_failure_code: "VALIDATION_ERROR",
    });
    expect(res.headers.get(FAILURE_CAPTURED_HEADER)).toBe("1");
  });

  it("captures a guest rate-limit 429 from middleware in front of the route", async () => {
    const res = await app((a) => {
      a.use(AGENT, async (c) => {
        c.set("webErrorMeta", {
          status: 429,
          code: "RATE_LIMITED",
          message: "Too many requests",
        });
        return c.json({ code: "RATE_LIMITED" }, 429);
      });
      a.post(AGENT, (c) => c.json({ ok: true }));
    }).request(AGENT, { method: "POST" });

    expect(res.status).toBe(429);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(captureTags().page_class).toBe("routine");
  });

  it("captures a 5xx as an incident", async () => {
    await app((a) =>
      a.post(AGENT, (c) => c.json({ code: "INTERNAL_ERROR" }, 500)),
    ).request(AGENT, { method: "POST" });

    expect(captureTags().page_class).toBe("incident");
  });

  it("does not re-capture an error the route already captured", async () => {
    const res = await app((a) =>
      a.post(AGENT, (c) => {
        c.set("webErrorMeta", {
          status: 500,
          code: "INTERNAL_ERROR",
          message: "boom",
          captured: true,
        });
        return c.json({ code: "INTERNAL_ERROR" }, 500);
      }),
    ).request(AGENT, { method: "POST" });

    expect(capture).not.toHaveBeenCalled();
    expect(res.headers.get(FAILURE_CAPTURED_HEADER)).toBe("1");
  });

  it("DOES capture an error the route declined", async () => {
    // The origin policy said "not ours" and stamped it. The stamp means a
    // decision was made, not that anyone captured it.
    const res = await app((a) =>
      a.post(AGENT, (c) => {
        c.set("webErrorMeta", {
          status: 502,
          code: "SERVER_UNREACHABLE",
          message: "docs server down",
          origin: "user_server",
          captured: false,
        });
        return c.json({ code: "SERVER_UNREACHABLE" }, 502);
      }),
    ).request(AGENT, { method: "POST" });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(res.headers.get(FAILURE_CAPTURED_HEADER)).toBe("1");
  });

  it("does not re-capture what a request-scoped stream reporter captured", async () => {
    const res = await app((a) =>
      a.post(AGENT, (c) => {
        c.set("failureCaptured", true);
        return c.json({ code: "INTERNAL_ERROR" }, 500);
      }),
    ).request(AGENT, { method: "POST" });

    expect(capture).not.toHaveBeenCalled();
    expect(res.headers.get(FAILURE_CAPTURED_HEADER)).toBe("1");
  });

  it("covers the v1 agent route too", async () => {
    await app((a) =>
      a.post("/api/v1/projects/:projectId/agent", (c) =>
        c.json({ code: "INTERNAL_ERROR" }, 500),
      ),
    ).request("/api/v1/projects/p1/agent", { method: "POST" });

    expect(capture).toHaveBeenCalledTimes(1);
  });

  it("says 0 on a success and captures nothing", async () => {
    const res = await app((a) =>
      a.post(AGENT, (c) => c.json({ ok: true })),
    ).request(AGENT, { method: "POST" });

    expect(capture).not.toHaveBeenCalled();
    expect(res.headers.get(FAILURE_CAPTURED_HEADER)).toBe("0");
  });

  it("says 0 on a stream, whose failures report themselves", async () => {
    const res = await app((a) =>
      a.post(
        AGENT,
        () =>
          new Response("data: {}\n\n", {
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    ).request(AGENT, { method: "POST" });

    expect(res.headers.get(FAILURE_CAPTURED_HEADER)).toBe("0");
    expect(capture).not.toHaveBeenCalled();
  });

  it("leaves a 499 alone: that is the client going away", async () => {
    await app((a) => a.post(AGENT, (c) => c.body(null, 499 as never))).request(
      AGENT,
      { method: "POST" },
    );

    expect(capture).not.toHaveBeenCalled();
  });

  it("leaves a request the caller aborted alone, whatever it answered", async () => {
    // The v1 agent answers a caller disconnect with 504 TIMEOUT.
    const stop = new AbortController();
    stop.abort();
    await app((a) =>
      a.post(AGENT, (c) => c.json({ code: "TIMEOUT" }, 504)),
    ).request(AGENT, { method: "POST", signal: stop.signal });

    expect(capture).not.toHaveBeenCalled();
  });

  it("leaves every other route exactly as it was", async () => {
    const res = await app((a) =>
      a.post("/api/web/chat-v2", (c) => c.json({ error: "no" }, 401)),
    ).request("/api/web/chat-v2", { method: "POST" });

    expect(capture).not.toHaveBeenCalled();
    expect(res.headers.get(FAILURE_CAPTURED_HEADER)).toBeNull();
  });
});
