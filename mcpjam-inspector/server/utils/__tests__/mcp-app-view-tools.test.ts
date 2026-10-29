import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { McpAppBrowserHarness } from "../mcp-app-browser-harness.js";

let html: string;
const harnesses: McpAppBrowserHarness[] = [];
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
    import { App } from '@modelcontextprotocol/ext-apps';
    const app = new App({name:'view-fixture',version:'1'});
    await app.connect();
    document.body.textContent = 'Board';
    if (document.modelContext) await document.modelContext.registerTool({
      name:'move',description:'Move',inputSchema:{type:'object',properties:{move:{type:'string'},delay:{type:'number'},hang:{type:'boolean'}},required:['move']},
      execute: async (input, {signal}) => {
        if(input.hang) return new Promise(()=>{});
        if(input.delay) await new Promise(resolve => setTimeout(resolve,input.delay));
        await app.callServerTool({name:'record',arguments:{move:input.move}});
        return {move:input.move};
      }
    });`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
  });
  html = `<html><head></head><body><script type="module">${bundle.outputFiles[0].text}</script></body></html>`;
}, 60000);
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
});

function fixture(enabled = true) {
  const calls: string[] = [];
  const harness = new McpAppBrowserHarness({
    enableViewTools: enabled,
    readResource: async () => ({ contents: [] }),
    callTool: async (_server, _name, args) => {
      calls.push(String(args.move));
      return { content: [] };
    },
    budgets: {
      paintTimeoutMs: 1000,
      renderTimeoutMs: 3000,
      settleTimeoutMs: 500,
    },
  });
  harnesses.push(harness);
  const render = (id: string) =>
    harness.renderWidget({
      toolCallId: id,
      toolName: "board",
      serverId: "server",
      html,
      keepMounted: true,
    });
  return { harness, calls, render };
}
describe("harness view tools", () => {
  it("lists, validates, executes and attributes real view tools", async () => {
    const { harness, calls, render } = fixture();
    expect((await render("A")).status).toBe("rendered");
    expect(
      (await harness.viewTools.list())?.tools.map((tool) => tool.name),
    ).toEqual(["move"]);
    await expect(harness.viewTools.call("A", "move", {})).rejects.toThrow(
      "arguments",
    );
    expect(calls).toEqual([]);
    const result = await harness.viewTools.call("A", "move", { move: "e4" });
    expect(result.structuredContent).toEqual({ move: "e4" });
    expect(calls).toEqual(["e4"]);
    expect(harness.viewTools.drainRecords()).toMatchObject([
      {
        viewId: "A",
        rawName: "move",
        ok: true,
        widgetToolCalls: [{ name: "record" }],
      },
    ]);
  }, 30000);
  it("serializes two calls and refuses old views after replacement", async () => {
    const { harness, calls, render } = fixture();
    await render("A");
    await harness.viewTools.list();
    await Promise.all([
      harness.viewTools.call("A", "move", { move: "first", delay: 100 }),
      harness.viewTools.call("A", "move", { move: "second" }),
    ]);
    expect(calls).toEqual(["first", "second"]);
    const records = harness.viewTools.drainRecords();
    expect(
      records.map((record) =>
        record.widgetToolCalls.map((call) => call.args.move),
      ),
    ).toEqual([["first"], ["second"]]);
    await render("B");
    await expect(
      harness.viewTools.call("A", "move", { move: "stale" }),
    ).rejects.toThrow("replaced");
    expect(calls).toEqual(["first", "second"]);
  }, 30000);
  it("rejects in-flight work when a replacement mounts and keeps its results separate", async () => {
    const { harness, calls, render } = fixture();
    await render("A");
    await harness.viewTools.list();
    const outcome = harness.viewTools.call("A", "move", { move: "old", delay: 500 }).catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 50));
    await render("B");
    expect(await outcome).toBeInstanceOf(Error);
    expect((await harness.viewTools.list())?.viewId).toBe("B");
    await harness.viewTools.call("B", "move", { move: "new" });
    expect(calls).toEqual(["new"]);
  }, 30000);
  it("aborts a hung handler, dismisses its view and settles the caller", async () => {
    const { harness, render } = fixture();
    await render("A");
    await harness.viewTools.list();
    const controller = new AbortController();
    const call = harness.viewTools.call(
      "A",
      "move",
      { move: "e4", hang: true },
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error("cancelled")), 100);
    await expect(call).rejects.toThrow("cancelled");
    expect(harness.getMountedWidgetId()).toBeNull();
  }, 30000);
  it("keeps the non-opted-in harness without view tools", async () => {
    const { harness, render } = fixture(false);
    await render("A");
    expect(await harness.viewTools.list()).toBeNull();
    expect(harness.viewTools.available).toBe(false);
  }, 30000);
});
