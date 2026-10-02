import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which render failures are the renderer's own. The render phase still talks
 * to the MCP server, so only a failure that shows nothing of that is marked
 * local; the hosted routes word everything else as the server's (MJ-001).
 */

const { renderMock, disposeMock } = vi.hoisted(() => ({
  renderMock: vi.fn(),
  disposeMock: vi.fn(),
}));

vi.mock("../mcp-app-render-observation", () => ({
  renderMcpAppToolResult: renderMock,
  isRenderableMcpAppTool: () => true,
}));

vi.mock("../mcp-app-browser-harness", () => ({
  ChromiumNotInstalledError: class ChromiumNotInstalledError extends Error {},
  McpAppBrowserHarness: class {
    dispose = disposeMock;
  },
}));

import { renderWidgetForRequest } from "../widget-render-core.js";
import { isLocalRouteFailure } from "../hosted-route-failure.js";

/** Shaped like Playwright's: an Error subclass named `TimeoutError`. */
class PlaywrightTimeoutError extends Error {
  override name = "TimeoutError";
}

class StreamableHTTPError extends Error {
  constructor(readonly code: number) {
    super("UNEXPECTED_MARKER_TEXT");
  }
}

function manager(executeTool = vi.fn().mockResolvedValue({ content: [] })) {
  return {
    listTools: vi.fn().mockResolvedValue({ tools: [{ name: "show" }] }),
    executeTool,
  } as never;
}

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the render to fail");
}

function render(mcpClientManager = manager()) {
  return renderWidgetForRequest({
    mcpClientManager,
    serverId: "s1",
    toolName: "show",
    parameters: {},
    injectOpenAiCompat: false,
    keepMounted: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  disposeMock.mockResolvedValue(undefined);
});

describe("renderWidgetForRequest failures", () => {
  it("marks a headless browser failure as local and disposes the harness", async () => {
    renderMock.mockRejectedValue(
      new PlaywrightTimeoutError("page.waitForFunction: Timeout."),
    );
    const error = await failureOf(render);
    expect(isLocalRouteFailure(error)).toBe(true);
    expect(disposeMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["a transport error", new StreamableHTTPError(405)],
    [
      "an MCP error",
      Object.assign(new Error("x"), { name: "McpError", code: -32602 }),
    ],
    [
      "a failed fetch",
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
      }),
    ],
  ])("leaves %s during the render to the server's account", async (_k, e) => {
    renderMock.mockRejectedValue(e);
    const error = await failureOf(render);
    expect(error).toBe(e);
    expect(isLocalRouteFailure(error)).toBe(false);
  });

  it("does not mark a failure of the tool call before the render", async () => {
    const failure = new Error("tool call failed");
    const error = await failureOf(() =>
      render(manager(vi.fn().mockRejectedValue(failure))),
    );
    expect(error).toBe(failure);
    expect(isLocalRouteFailure(error)).toBe(false);
    expect(renderMock).not.toHaveBeenCalled();
  });
});
