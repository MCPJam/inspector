import { describe, expect, it, vi } from "vitest";
import {
  redactBrowserScreenshots,
  wrapBrowserToolsForEvidence,
  type BrowserScreenshotEvidence,
} from "../browser-tool-evidence";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString(
  "base64",
);
const pointer = { turnId: "turn", toolCallId: "call", stepIndex: 0 };
describe("browser tool evidence", () => {
  it("keeps the model image and stores its format, identity, and acknowledged URL", async () => {
    const result = { page: { screenshot: png, url: "https://example.com" } };
    const persist = vi.fn(async () => "https://storage.example/image");
    const evidence: BrowserScreenshotEvidence[] = [];
    const tools = wrapBrowserToolsForEvidence(
      { browser_observe: { execute: async () => result } } as never,
      { turnId: "turn", promptIndex: 2, persist, evidence },
    );
    const returned = await tools.browser_observe.execute!(
      {},
      { toolCallId: "call", messages: [] },
    );
    expect(returned).toBe(result);
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({
        ...pointer,
        toolName: "browser_observe",
        source: "browser_tool",
        promptIndex: 2,
        screenshotBase64: png,
      }),
    );
    expect(evidence[0]).toMatchObject({
      ...pointer,
      status: "ready",
      mediaType: "image/png",
      url: "https://storage.example/image",
    });
  });
  it("does not claim pending or lose tool results when persistence fails", async () => {
    const evidence: BrowserScreenshotEvidence[] = [];
    const result = { screenshot: png };
    const tools = wrapBrowserToolsForEvidence(
      { browser_observe: { execute: async () => result } } as never,
      {
        turnId: "turn",
        promptIndex: 0,
        persist: async () => {
          throw new Error("storage down");
        },
        evidence,
      },
    );
    expect(
      await tools.browser_observe.execute!(
        {},
        { toolCallId: "call", messages: [] },
      ),
    ).toBe(result);
    expect(evidence[0].status).toBe("unavailable");
  });
  it("removes screenshot bytes at all supported nesting locations without mutation", () => {
    const raw = {
      screenshot: png,
      page: { screenshot: png },
      result: {
        output: {
          screenshotBase64: png,
          content: [{ type: "image-data", data: png, mediaType: "image/png" }],
        },
      },
    };
    const persisted = redactBrowserScreenshots(raw, pointer);
    expect(JSON.stringify(persisted)).not.toContain(png);
    expect(raw.page.screenshot).toBe(png);
    expect(persisted).toMatchObject({
      screenshot: pointer,
      page: { screenshot: pointer },
    });
  });
});
