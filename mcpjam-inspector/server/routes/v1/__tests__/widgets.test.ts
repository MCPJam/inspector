import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

/**
 * `POST /v1/projects/:p/servers/:s/widgets/render`.
 *
 * The browser is stubbed at the render core, so this pins the ROUTE's
 * decisions rather than Chromium's:
 *
 *   1. PAYLOAD DEFAULTS ARE REVERSED from the local Inspector route — snapshot
 *      on, screenshot off. This endpoint's caller is usually a model, and a
 *      base64 image it may not be able to see is the most expensive possible
 *      way to say nothing. A regression here is invisible in a test that only
 *      checks the status code and expensive in production.
 *   2. A TOOL WITH NO WIDGET IS REFUSED, not reported as a successful render
 *      of nothing.
 *   3. THE HARNESS IS ALWAYS DISPOSED. A leaked Chromium is the failure that
 *      takes a replica out.
 *   4. BLOCKED REQUESTS SURVIVE a successful render: a widget that renders
 *      while every fetch is blocked photographs perfectly and is broken.
 */

const { runEphemeralConnectionMock, renderWidgetMock, validateGuestTokenMock } =
  vi.hoisted(() => ({
    runEphemeralConnectionMock: vi.fn(),
    renderWidgetMock: vi.fn(),
    validateGuestTokenMock: vi.fn(),
  }));

vi.mock("../../../services/guest-token.js", () => ({
  validateGuestTokenDetailedAsync: validateGuestTokenMock,
}));

vi.mock("../../web/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../web/auth.js")>(
    "../../web/auth.js",
  );
  return { ...actual, runEphemeralConnection: runEphemeralConnectionMock };
});

vi.mock("../../../utils/widget-render-core.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../utils/widget-render-core.js")
  >("../../../utils/widget-render-core.js");
  return { ...actual, renderWidgetForRequest: renderWidgetMock };
});

import v1Routes from "../index.js";

function makeApp(): Hono {
  const app = new Hono();
  app.route("/api/v1", v1Routes);
  return app;
}

const disposeMock = vi.fn().mockResolvedValue(undefined);

/** A rendered observation with every diagnostic populated. */
function renderedResult(overrides: Record<string, unknown> = {}) {
  return {
    observation: {
      toolCallId: "tc_1",
      toolName: "show_map",
      serverId: "s1",
      status: "rendered",
      resourceUri: "ui://widget/map",
      bridgeInitialized: true,
      screenshotBase64: "aW1hZ2U=",
      consoleErrors: ["TypeError: x is not a function"],
      blockedRequests: ["https://cdn.example.com/tiles.js"],
      elapsedMs: 120,
      ts: Date.now(),
      ...overrides,
    },
    snapshot: {
      mode: "a11y",
      tree: '- button "Zoom in"',
      elements: [{ role: { role: "button", name: "Zoom in" } }],
      capturedAt: 1,
    },
    harness: { dispose: disposeMock },
  };
}

function post(body: Record<string, unknown> = { toolName: "show_map" }) {
  return makeApp().request("/api/v1/projects/p1/servers/s1/widgets/render", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer tok",
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  validateGuestTokenMock.mockResolvedValue({ valid: false });
  disposeMock.mockResolvedValue(undefined);
  // Faithful to the real `runEphemeralConnection`: it PARSES the body against
  // the route's schema before calling the core. A mock that skipped that would
  // make every validation test here a test of the mock — the route's own
  // rejections would never run.
  runEphemeralConnectionMock.mockImplementation(
    async (
      _c: unknown,
      rawBody: Record<string, unknown>,
      schema: { parse: (value: unknown) => unknown },
      coreFn: (m: unknown, b: unknown) => Promise<unknown>,
    ) => {
      const { parseWithSchema } = await import("../../web/errors.js");
      return coreFn({}, parseWithSchema(schema as never, rawBody));
    },
  );
});

describe("POST /v1/projects/:projectId/servers/:serverId/widgets/render", () => {
  it("returns the tree by default and withholds the screenshot", async () => {
    renderWidgetMock.mockResolvedValue(renderedResult());
    const response = await post();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.snapshot.elements).toEqual([
      { role: { role: "button", name: "Zoom in" } },
    ]);
    // The screenshot EXISTS on the observation and is deliberately not
    // returned: the caller did not ask, and it is the largest field here.
    expect(body.screenshot).toBeUndefined();
    expect(renderWidgetMock.mock.calls[0]![0]).toMatchObject({
      captureSnapshot: true,
      keepMounted: false,
    });
  });

  it("returns the screenshot only when asked", async () => {
    renderWidgetMock.mockResolvedValue(renderedResult());
    const body = await (
      await post({ toolName: "show_map", includeScreenshot: true })
    ).json();
    expect(body.screenshot).toEqual({
      mimeType: "image/png",
      base64: "aW1hZ2U=",
    });
  });

  it("skips the snapshot when explicitly disabled", async () => {
    renderWidgetMock.mockResolvedValue({
      ...renderedResult(),
      snapshot: undefined,
    });
    await post({ toolName: "show_map", includeSnapshot: false });
    expect(renderWidgetMock.mock.calls[0]![0]).not.toHaveProperty(
      "captureSnapshot",
    );
  });

  it("keeps the console and network evidence on a SUCCESSFUL render", async () => {
    renderWidgetMock.mockResolvedValue(renderedResult());
    const body = await (await post()).json();
    // A widget that renders while every fetch is blocked looks perfect in a
    // screenshot. These two fields are how an agent finds that out.
    expect(body.consoleErrors).toEqual(["TypeError: x is not a function"]);
    expect(body.blockedRequests).toEqual(["https://cdn.example.com/tiles.js"]);
  });

  it("refuses a tool that declares no widget instead of reporting an empty render", async () => {
    renderWidgetMock.mockResolvedValue({
      observation: {
        toolCallId: "tc_2",
        toolName: "plain_tool",
        serverId: "s1",
        status: "no_ui_resource",
        elapsedMs: 3,
        ts: Date.now(),
      },
      harness: null,
    });
    const response = await post({ toolName: "plain_tool" });
    expect(response.status).toBe(422);
    expect((await response.json()).message).toMatch(/UI resource/);
  });

  it("disposes the harness even when the render is refused", async () => {
    renderWidgetMock.mockResolvedValue(
      renderedResult({ status: "browser_unavailable" }),
    );
    const response = await post();
    expect(response.status).not.toBe(200);
    // A leaked Chromium is the failure that takes a replica out, so teardown
    // must not be conditional on the happy path.
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it("disposes the harness on the happy path too", async () => {
    renderWidgetMock.mockResolvedValue(renderedResult());
    await post();
    expect(disposeMock).toHaveBeenCalledTimes(1);
  });

  it("labels a re-encoded screenshot as JPEG, not PNG", async () => {
    // The harness re-shoots as progressively lower-quality JPEG when the PNG
    // is over its byte budget — the common path for photographic widgets — so
    // a hardcoded image/png mislabels exactly the screenshots most likely to
    // be re-encoded, and a client that trusts the type fails to render a
    // perfectly good image. `/9j/` is base64 for JPEG's SOI marker.
    renderWidgetMock.mockResolvedValue(
      renderedResult({ screenshotBase64: "/9j/4AAQSkZJRg==" }),
    );
    const body = await (
      await post({ toolName: "show_map", includeScreenshot: true })
    ).json();
    expect(body.screenshot.mimeType).toBe("image/jpeg");
  });

  it("rejects a malformed body without touching the renderer", async () => {
    for (const body of [
      { toolName: "" },
      { toolName: "show_map", parameters: null },
      { toolName: "show_map", viewport: { width: 0, height: 100 } },
      { toolName: "show_map", viewport: { width: 99_999, height: 100 } },
      {},
    ]) {
      const response = await post(body as Record<string, unknown>);
      expect(response.status).toBe(400);
    }
    // Nothing invalid should ever reach a browser launch.
    expect(renderWidgetMock).not.toHaveBeenCalled();
  });

  it("surfaces a renderer failure as a 5xx rather than a partial 200", async () => {
    renderWidgetMock.mockRejectedValue(new Error("listTools exploded"));
    const response = await post();
    expect(response.status).toBeGreaterThanOrEqual(500);
  });

  it("gives up on a render that outruns the wall clock", async () => {
    // The first cut set a timer that only logged, and `runV1ServerOp`'s
    // timeoutMs bounds the MCP manager rather than the Playwright render — so
    // a stuck widget held its request, its Chromium and its concurrency slot
    // indefinitely, past the wall clock the module advertises.
    vi.useFakeTimers();
    try {
      renderWidgetMock.mockImplementation(() => new Promise(() => {}) as never);
      const pending = post();
      await vi.advanceTimersByTimeAsync(46_000);
      const response = await pending;
      expect(response.status).toBe(504);
    } finally {
      vi.useRealTimers();
    }
  });
});
