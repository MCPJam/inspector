import { describe, expect, it, vi } from "vitest";
import {
  appToolSourceFor,
  callViewWebmcpTool,
  discoverViewAppTools,
  listViewWebmcpTools,
  type SandboxToolsRequester,
} from "../webmcp-tools.js";

const tools = [
  {
    name: "move",
    description: "Move",
    inputSchema: { type: "object" as const },
  },
];
function requester(value: unknown = { tools }) {
  return {
    request: vi.fn().mockResolvedValue(value),
  } satisfies SandboxToolsRequester;
}

describe("WebMCP app discovery", () => {
  it("requires explicit opt-in and prefers declared legacy tools", () => {
    expect(appToolSourceFor({}, {})).toBeNull();
    expect(appToolSourceFor({}, { webmcpTools: false })).toBeNull();
    expect(appToolSourceFor({}, { webmcpTools: true })).toBe("webmcp");
    expect(appToolSourceFor({ tools: {} }, { webmcpTools: true })).toBe(
      "mcp-apps"
    );
  });

  it("lists through the reserved method and passes the signal", async () => {
    const req = requester();
    const controller = new AbortController();
    expect(
      await listViewWebmcpTools(req, { signal: controller.signal })
    ).toEqual(tools);
    expect(req.request.mock.calls[0][0]).toEqual({
      method: "ui/sandbox-list-tools",
    });
    expect(req.request.mock.calls[0][2]).toEqual({ signal: controller.signal });
  });

  it("falls back only for initial method-not-found", async () => {
    const req = requester();
    const error = Object.assign(new Error("unavailable"), { code: -32601 });
    expect(
      await discoverViewAppTools(req, "mcp-apps", true, async () => {
        throw error;
      })
    ).toEqual({ source: "webmcp", tools });
    await expect(
      discoverViewAppTools(req, "mcp-apps", false, async () => {
        throw error;
      })
    ).rejects.toBe(error);
  });

  it.each([-32602, -32603, undefined])(
    "preserves a legacy error with code %s",
    async (code) => {
      const req = requester();
      const error = Object.assign(new Error("failed"), { code });
      await expect(
        discoverViewAppTools(req, "mcp-apps", true, async () => {
          throw error;
        })
      ).rejects.toBe(error);
      expect(req.request).not.toHaveBeenCalled();
    }
  );

  it("does not interpret a successful empty legacy list as a missing method", async () => {
    const req = requester();
    expect(
      await discoverViewAppTools(req, "mcp-apps", true, async () => [])
    ).toEqual({ source: "mcp-apps", tools: [] });
    expect(req.request).not.toHaveBeenCalled();
  });

  it("rejects an incompatible descriptor", async () => {
    await expect(
      listViewWebmcpTools(
        requester({ tools: [{ ...tools[0], inputSchema: { type: "array" } }] })
      )
    ).rejects.toThrow();
  });

  it("preserves content and structured result without retrying failures", async () => {
    const output = {
      content: [{ type: "text", text: "board" }],
      structuredContent: { board: "A" },
    };
    const req = requester(output);
    expect(await callViewWebmcpTool(req, "move", { move: "e4" })).toEqual(
      output
    );
    expect(req.request).toHaveBeenCalledOnce();
  });

  it("rejects oversized structured output even if text is small", async () => {
    const req = requester({
      content: [{ type: "text", text: "ok" }],
      structuredContent: { board: "x".repeat(300000) },
    });
    await expect(callViewWebmcpTool(req, "move", {})).rejects.toThrow(
      "256 KiB"
    );
    expect(req.request).toHaveBeenCalledOnce();
  });
});
