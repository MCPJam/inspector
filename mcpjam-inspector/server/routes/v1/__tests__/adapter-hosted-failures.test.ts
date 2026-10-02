import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { z } from "zod";

/**
 * `runV1ServerOp` in hosted mode (MJ-001): a failure of the connection or of
 * the MCP operation is worded from the status line, while a failure of this
 * server's own work around it — `format`, or a step the core marked as local —
 * reaches the router's ordinary error handling instead of being described as
 * the MCP server's.
 */

const { runEphemeralConnectionMock } = vi.hoisted(() => ({
  runEphemeralConnectionMock: vi.fn(),
}));

vi.mock("../../../config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../config.js")>()),
  HOSTED_MODE: true,
}));

vi.mock("../../web/auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../web/auth.js")>()),
  runEphemeralConnection: runEphemeralConnectionMock,
}));

import { runV1ServerOp } from "../adapter.js";
import { v1OnError } from "../envelope.js";
import { markLocalRouteFailure } from "../../../utils/hosted-route-failure.js";
import { HOSTED_REQUEST_TIMEOUT_DETAIL } from "../../../utils/hosted-connect-failure.js";
import { HOSTED_TRANSPORT_FAILURE_DETAIL } from "../../../utils/hosted-doctor-redaction.js";

const schema = z.object({ projectId: z.string(), serverId: z.string() });

/** Shaped like Playwright's: an Error subclass named `TimeoutError`. */
class PlaywrightTimeoutError extends Error {
  override name = "TimeoutError";
}

function appFor(
  coreFn: () => Promise<unknown>,
  format: (c: any, result: unknown) => Response | Promise<Response> = (
    c,
    result,
  ) => c.json(result),
) {
  const app = new Hono();
  app.post("/projects/:projectId/servers/:serverId/op", (c) =>
    runV1ServerOp(c, schema, coreFn, format),
  );
  app.onError((error, c) => v1OnError(error, c));
  return app;
}

async function call(app: Hono) {
  const response = await app.request("/projects/p1/servers/s1/op", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return {
    status: response.status,
    body: (await response.json()) as { code: string; message: string },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  runEphemeralConnectionMock.mockImplementation(
    async (
      _c: unknown,
      rawBody: Record<string, unknown>,
      bodySchema: { parse: (value: unknown) => unknown },
      coreFn: (manager: unknown, body: unknown) => Promise<unknown>,
    ) => coreFn({}, bodySchema.parse(rawBody)),
  );
});

describe("runV1ServerOp, hosted", () => {
  it("words an unmarked timeout as the MCP server's", async () => {
    const { body } = await call(
      appFor(async () => {
        throw new PlaywrightTimeoutError("page.waitForFunction: Timeout.");
      }),
    );
    expect(body.message).toBe(HOSTED_REQUEST_TIMEOUT_DETAIL);
  });

  it("leaves a marked local failure to the router's error handling", async () => {
    const error = new PlaywrightTimeoutError("page.waitForFunction: Timeout.");
    const { status, body } = await call(
      appFor(async () => {
        throw markLocalRouteFailure(error);
      }),
    );
    expect(body.message).not.toBe(HOSTED_REQUEST_TIMEOUT_DETAIL);
    expect(body.message).not.toMatch(/MCP server/);
    // The same answer the router gives the error when nothing projects it.
    const unprojected = new Hono();
    unprojected.post("/projects/:projectId/servers/:serverId/op", () => {
      throw error;
    });
    unprojected.onError((thrown, c) => v1OnError(thrown, c));
    expect({ status, body }).toEqual(await call(unprojected));
  });

  it("leaves a failure while formatting the result to the router", async () => {
    const { body } = await call(
      appFor(
        async () => ({ ok: true }),
        () => {
          throw new Error("format failed");
        },
      ),
    );
    expect(body.message).not.toBe(HOSTED_TRANSPORT_FAILURE_DETAIL);
    expect(body.message).not.toMatch(/MCP server/);
  });
});
