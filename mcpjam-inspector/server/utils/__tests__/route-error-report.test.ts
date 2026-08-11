import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

const mockIngest = vi.fn();
vi.mock("@axiomhq/js", () => ({
  Axiom: vi.fn().mockImplementation(() => ({
    ingest: mockIngest,
    flush: vi.fn().mockResolvedValue(undefined),
  })),
}));

import * as Sentry from "@sentry/node";
import {
  ClientInputError,
  markUserServerHop,
  readRequestJson,
  reportRouteFailure,
} from "../route-error-report.js";

const captureException = vi.mocked(Sentry.captureException);

/**
 * The failure a dead user MCP server produces. `describeError` resolves this to
 * `transport/econnrefused`, whose origin is `user_config`.
 */
function deadServerError(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:3000"), {
    code: "ECONNREFUSED",
  });
}

beforeEach(() => {
  captureException.mockClear();
  mockIngest.mockClear();
  // `logger` builds its Axiom client lazily on first ingest and memoizes it,
  // so these must be present before the first report in this file runs.
  process.env.AXIOM_TOKEN = "test-token";
  process.env.AXIOM_DATASET = "test-dataset";
  delete process.env.DO_NOT_TRACK;
});

describe("reportRouteFailure", () => {
  it("does not page for a dead user MCP server on a user_server_hop", () => {
    // The regression this whole sweep exists to prevent: before it, every one
    // of these catch-sites called `logger.error`, which captures
    // unconditionally, so somebody else's server being down paged the team.
    const { normalized } = reportRouteFailure(
      "Error fetching resources",
      deadServerError(),
      {
        source: "mcp.resources.list",
        hop: "user_server_hop",
        context: { serverId: "srv_1" },
      },
    );

    expect(normalized.slug).toBe("transport/econnrefused");
    expect(captureException).not.toHaveBeenCalled();
  });

  it("does not page for a dead user MCP server even under an internal boundary", () => {
    // A boundary declaration says "the hop was ours". It must not overrule a
    // slug that positively identifies the user's configuration.
    reportRouteFailure("Error reaching backend", deadServerError(), {
      source: "mcp.models.fetch",
      hop: "mcpjam_internal",
    });

    expect(captureException).not.toHaveBeenCalled();
  });

  it("pages for an unrecognized failure on an MCPJam-internal hop", () => {
    reportRouteFailure("Failed to materialize plugin bundle", new Error("kaboom"), {
      source: "mcp.plugins.materialize",
      hop: "mcpjam_internal",
    });

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0]![1]).toMatchObject({
      tags: expect.objectContaining({
        error_origin: "mcpjam",
        capture_source: "route:mcp.plugins.materialize",
      }),
    });
  });

  it("does NOT page for an unrecognized failure on a user-server hop", () => {
    // `internal/unknown` is where every unclassifiable failure from an
    // arbitrary user server lands. Paging on it would rebuild the noise
    // problem, which is why only a declared-internal boundary promotes it.
    reportRouteFailure("Error listing tasks", new Error("kaboom"), {
      source: "mcp.tasks.list",
      hop: "user_server_hop",
    });

    expect(captureException).not.toHaveBeenCalled();
  });

  it("keeps the Axiom row for a declined failure, with the verdict on it", () => {
    // Not paging is not the same as not recording. The `origin`/`slug`/
    // `captured` fields are what make "should this bucket page?" answerable
    // from data rather than from argument.
    reportRouteFailure("Error fetching resources", deadServerError(), {
      source: "mcp.resources.list",
      hop: "user_server_hop",
      context: { serverId: "srv_1" },
    });

    expect(mockIngest).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          level: "error",
          message: "Error fetching resources",
          source: "mcp.resources.list",
          hop: "user_server_hop",
          origin: "user_config",
          slug: "transport/econnrefused",
          captured: false,
          serverId: "srv_1",
        }),
      ],
    );
  });

  it("does not page for a declined PRIMITIVE throw", () => {
    // `throw "failure"` is legal and a primitive cannot carry the capture
    // stamp, so the decision made by the report would be invisible to the
    // `logger.error` right after it — and a user-fault failure would page
    // anyway, through the exact side door this design closes.
    reportRouteFailure("Error listing tasks", "server exploded", {
      source: "mcp.tasks.list",
      hop: "user_server_hop",
    });

    expect(captureException).not.toHaveBeenCalled();
  });

  it("captures a primitive throw on an internal hop exactly once", () => {
    reportRouteFailure("Unhandled error", "kaboom", {
      source: "app.onError",
      hop: "mcpjam_internal",
    });

    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("keeps a primitive throw's text in the Axiom row", () => {
    // Wrapping must not cost the diagnostic. `String(value)` is preserved as
    // the wrapper's message, so the row reads identically to the raw throw.
    reportRouteFailure("Error listing tasks", "server exploded", {
      source: "mcp.tasks.list",
      hop: "user_server_hop",
    });

    expect(mockIngest).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({ error: "server exploded" }),
    ]);
  });

  it("survives a null rejection", () => {
    expect(() =>
      reportRouteFailure("Error listing tasks", null, {
        source: "mcp.tasks.list",
        hop: "user_server_hop",
      }),
    ).not.toThrow();
  });

  it("reports the EFFECTIVE origin, including the internal promotion", () => {
    // Recomputing from the catalog would say `ambiguous` for a failure Sentry
    // was just paged for as `mcpjam`, so the response body and the Axiom row
    // would contradict the alert.
    const { origin } = reportRouteFailure("Unhandled error", new Error("kaboom"), {
      source: "app.onError",
      hop: "mcpjam_internal",
    });

    expect(origin).toBe("mcpjam");
  });

  it("never promotes a malformed request body to an MCPJam failure", () => {
    // Several handlers parse the request inside the same try whose catch
    // declares an internal hop. Without this rule, anyone with a session could
    // page the on-call by POSTing invalid JSON.
    const { origin } = reportRouteFailure(
      "Error counting tokens",
      new ClientInputError("Invalid JSON body"),
      { source: "mcp.tokenizer.tools", hop: "mcpjam_internal" },
    );

    expect(origin).toBe("ambiguous");
    expect(captureException).not.toHaveBeenCalled();
  });

  it("STILL captures a SyntaxError that did not come from the request", () => {
    // Deliberately not `error instanceof SyntaxError`: that cannot tell a
    // request body from a response body, and `models.ts` parses our own Convex
    // backend's JSON inside an internal catch. Malformed output from our
    // backend is our problem, and a type-based rule would have silently
    // stopped capturing it.
    reportRouteFailure(
      "[models] Convex backend error",
      new SyntaxError("Unexpected token < in JSON at position 0"),
      { source: "mcp.models.fetch", hop: "mcpjam_internal" },
    );

    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("does not page for a marked user-server hop under an internal boundary", () => {
    // The chat route's outer catch genuinely wraps MCPJam-owned work, but it
    // also receives whatever `prepareChatV2` threw — and the first thing that
    // awaits is a tool listing against the user's own servers. The mark is how
    // one catch block declares two hops.
    const { origin } = reportRouteFailure(
      "[mcp/chat-v2] failed to process chat request",
      markUserServerHop(new Error("Unknown MCP server")),
      { source: "mcp.chat-v2.request", hop: "mcpjam_internal" },
    );

    expect(origin).toBe("ambiguous");
    expect(captureException).not.toHaveBeenCalled();
  });

  it("finds the user-server mark through a cause chain", () => {
    const marked = markUserServerHop(new Error("tool listing failed"));
    const wrapper = new Error("chat request failed", { cause: marked });

    reportRouteFailure("[mcp/chat-v2] failed", wrapper, {
      source: "mcp.chat-v2.request",
      hop: "mcpjam_internal",
    });

    expect(captureException).not.toHaveBeenCalled();
  });

  it("survives a self-referential cause chain on the user-server walk", () => {
    const looping = new Error("loops");
    Object.defineProperty(looping, "cause", { value: looping });

    expect(() =>
      reportRouteFailure("Unhandled error", looping, {
        source: "app.onError",
        hop: "mcpjam_internal",
      }),
    ).not.toThrow();
  });

  it("still reports a genuine internal failure on the same route", () => {
    reportRouteFailure("Error counting tokens", new Error("kaboom"), {
      source: "mcp.tokenizer.tools",
      hop: "mcpjam_internal",
    });

    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it("does not page for a frozen user-server error", () => {
    const frozen = Object.freeze(deadServerError());

    reportRouteFailure("Error fetching resources", frozen, {
      source: "mcp.resources.list",
      hop: "user_server_hop",
    });

    expect(captureException).not.toHaveBeenCalled();
  });
  it("captures a paged failure exactly once, even though it also logs", () => {
    // `logger.error` still captures by default; it must skip an error the
    // report already ruled on, or every MCPJam-fault error would be
    // double-counted.
    reportRouteFailure("Unhandled error", new Error("kaboom"), {
      source: "app.onError",
      hop: "mcpjam_internal",
    });

    expect(captureException).toHaveBeenCalledTimes(1);
  });
});

describe("readRequestJson", () => {
  it("marks a malformed body so the internal boundary cannot promote it", async () => {
    const c = {
      req: {
        json: () => Promise.reject(new SyntaxError("Unexpected token <")),
      },
    };

    await expect(readRequestJson(c)).rejects.toBeInstanceOf(ClientInputError);
  });

  it("keeps the underlying parse error as the cause", async () => {
    const underlying = new SyntaxError("Unexpected token <");
    const c = { req: { json: () => Promise.reject(underlying) } };

    await expect(readRequestJson(c)).rejects.toMatchObject({
      cause: underlying,
    });
  });

  it("rejects a null body, which would TypeError at destructure", async () => {
    // `null` PARSES fine and then blows up on the caller's `const {x} = body`,
    // as an unmarked TypeError an internal hop would happily promote to a
    // page. Rejecting here closes that for every call site at once.
    const c = { req: { json: () => Promise.resolve(null) } };

    await expect(readRequestJson(c)).rejects.toBeInstanceOf(ClientInputError);
  });

  it.each([[42], ["a string"], [true]])(
    "lets a scalar body (%p) through so the route's own 400 still fires",
    async (body) => {
      // `const {serverId} = 42` does NOT throw — it yields `undefined`, the
      // handler's required-field check fires, and the caller gets a precise
      // 400. Rejecting these here would convert every one of those into a
      // generic 500.
      const c = { req: { json: () => Promise.resolve(body) } };

      await expect(readRequestJson(c)).resolves.toEqual(body);
    },
  );

  it("lets an array through — a handler that wants one still validates it", async () => {
    const c = { req: { json: () => Promise.resolve([1, 2]) } };

    await expect(readRequestJson(c)).resolves.toEqual([1, 2]);
  });

  it("passes a well-formed body straight through", async () => {
    const c = { req: { json: () => Promise.resolve({ serverId: "srv_1" }) } };

    await expect(readRequestJson(c)).resolves.toEqual({ serverId: "srv_1" });
  });
});
