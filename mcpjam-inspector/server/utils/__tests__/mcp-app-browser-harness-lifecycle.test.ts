import { describe, expect, it, vi } from "vitest";
import type { Browser } from "playwright";
import { McpAppBrowserHarness } from "../mcp-app-browser-harness";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const started = deferred(),
    released = deferred();
  const page = {
    on: vi.fn(),
    exposeBinding: vi.fn(async () => {
      started.resolve();
      await released.promise;
    }),
    setContent: vi.fn(),
    addScriptTag: vi.fn(),
    video: () => ({ path: async () => "/nonexistent/widget-lifecycle.webm" }),
  };
  const context = {
    route: vi.fn(),
    newPage: vi.fn(async () => page),
    on: vi.fn(),
    close: vi.fn(async () => {}),
  };
  const browser = {
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => {}),
  };
  const launch = vi.fn(async () => browser as unknown as Browser);
  class TestHarness extends McpAppBrowserHarness {
    protected async loadChromium() {
      return { executablePath: () => process.execPath, launch };
    }
  }
  const harness = new TestHarness({ callTool: vi.fn() });
  const render = (id: string) =>
    harness.renderWidget({
      toolCallId: id,
      toolName: "test",
      serverId: "server",
      html: "",
    });
  return { harness, render, page, context, browser, launch, started, released };
}
describe("widget browser lifecycle", () => {
  it("shares initialization and waits for bindings across concurrent renders", async () => {
    const f = fixture();
    const renders = [f.render("a"), f.render("b"), f.render("c")];
    try {
      await f.started.promise;
      expect(f.launch).toHaveBeenCalledTimes(1);
      expect(f.context.newPage).toHaveBeenCalledTimes(1);
      f.released.resolve();
      expect((await Promise.all(renders)).map((r) => r.status)).toEqual([
        "no_ui_resource",
        "no_ui_resource",
        "no_ui_resource",
      ]);
      expect(f.page.exposeBinding).toHaveBeenCalledTimes(2);
    } finally {
      f.released.resolve();
      await f.harness.dispose();
    }
  });
  it.each(["dispose", "collectVideo"] as const)(
    "%s waits for binding installation before closing the page",
    async (method) => {
      const f = fixture();
      const render = f.render("a").catch((e) => e);
      await f.started.promise;
      const close = f.harness[method]();
      await Promise.resolve();
      expect(f.context.close).not.toHaveBeenCalled();
      f.released.resolve();
      await close;
      expect(f.context.close).toHaveBeenCalledTimes(1);
      expect(await render).toBeInstanceOf(Error);
      await expect(f.render("late")).rejects.toThrow("closing");
      await f.harness.dispose();
      expect(f.launch).toHaveBeenCalledTimes(1);
    },
  );
  it("joins concurrent disposal and never launches queued renders after shutdown", async () => {
    const f = fixture();
    const render = f.render("a").catch((e) => e);
    await f.started.promise;
    const queued = f.render("b").catch((e) => e);
    const first = f.harness.dispose(),
      second = f.harness.dispose();
    expect(first).toBe(second);
    f.released.resolve();
    await Promise.all([first, second, render, queued]);
    expect(f.context.close).toHaveBeenCalledTimes(1);
    expect(f.browser.close).toHaveBeenCalledTimes(1);
    expect(f.launch).toHaveBeenCalledTimes(1);
  });
});

// Exercise Playwright's real in-process protocol: mocked pages alone cannot
// catch the out-of-band dispatcher exception from the incident.
it.runIf(
  await (await import("../mcp-app-browser-harness")).isChromiumInstalled(),
)(
  "initializes one real Chromium for ten simultaneous renders and closes cleanly",
  async () => {
    let launches = 0;
    class RealHarness extends McpAppBrowserHarness {
      protected async loadChromium() {
        launches++;
        return super.loadChromium();
      }
    }
    const harness = new RealHarness({ callTool: vi.fn() });
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          harness.renderWidget({
            toolCallId: String(index),
            toolName: "test",
            serverId: "server",
            html: "",
          }),
        ),
      );
      expect(launches).toBe(1);
      expect(results.every((r) => r.status === "no_ui_resource")).toBe(true);
      await Promise.all([harness.collectVideo(), harness.dispose()]);
      await expect(
        harness.renderWidget({
          toolCallId: "late",
          toolName: "test",
          serverId: "server",
          html: "",
        }),
      ).rejects.toThrow("closing");
    } finally {
      await harness.dispose();
    }
  },
  30_000,
);
