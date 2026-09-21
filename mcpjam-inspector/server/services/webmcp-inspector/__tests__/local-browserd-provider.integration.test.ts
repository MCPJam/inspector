import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { localBrowserdWebMcpProvider } from "../local-browserd-provider";
import type { WebMcpBrowserSession } from "../provider";

const enabled = process.env.RUN_BROWSER_NAVIGATION_INTEGRATION === "1";
let browser: WebMcpBrowserSession | undefined;
let server: Server | undefined;
afterEach(async () => {
  await browser?.dispose();
  if (server)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
});

describe.skipIf(!enabled)("managed WebMCP browser in Chromium", () => {
  it("adopts the actual popup, follows it, returns to its opener, and navigates history", async () => {
    server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(
        `<title>${req.url}</title><body style="background:${req.url === "/child" ? "green" : "red"}"><a href="/child" target="_blank" style="display:block;width:300px;height:200px">Open popup</a><script>if (window.opener) window.opener.popupWasAdopted = true;</script></body>`,
      );
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/parent`;
    const frames: string[] = [];
    browser = await localBrowserdWebMcpProvider.createSession({
      url,
      viewportMode: "embedded",
      callbacks: {
        onToolsChanged() {},
        onNavigated() {},
        onPopupOpened() {},
        onExternalInvocation() {},
        onActivityObserved() {},
        onCrashed(message) {
          throw new Error(message);
        },
        onFrame(frame) {
          frames.push(frame.data);
        },
      },
    });
    const initial = await browser.browserState!();
    expect(initial?.tabs).toHaveLength(1);
    await browser.setScreencast(true);
    await browser.dispatchInput([
      { kind: "mouse_down", x: 50, y: 50, button: "left", clickCount: 1 },
      { kind: "mouse_up", x: 50, y: 50, button: "left", clickCount: 1 },
    ]);
    await expect
      .poll(async () => (await browser!.browserState!())?.tabs.length)
      .toBe(2);
    const opened = await browser.browserState!();
    const popup = opened!.tabs.find((tab) => tab.id === opened!.activeTabId)!;
    expect(popup.url).toContain("/child");
    expect(popup.openerId).toBe(initial!.activeTabId);
    await browser.browserCommand!({ op: "close_tab", tabId: popup.id });
    expect((await browser.browserState!())!.activeTabId).toBe(
      initial!.activeTabId,
    );
    await browser.browserCommand!({
      op: "navigate",
      url: `http://127.0.0.1:${port}/next`,
    });
    await browser.browserCommand!({ op: "back" });
    expect((await browser.browserState!())!.tabs[0].url).toBe(url);
    await expect.poll(() => frames.length).toBeGreaterThan(0);
  }, 60_000);
});
