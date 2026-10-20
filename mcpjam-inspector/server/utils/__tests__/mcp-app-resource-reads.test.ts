import { afterEach, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import {
  McpAppBrowserHarness,
  isChromiumInstalled,
} from "../mcp-app-browser-harness";

const harnesses: McpAppBrowserHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});

async function widgetHtml(force = false) {
  const bundle = await build({
    stdin: {
      contents: `
      import { App } from "@modelcontextprotocol/ext-apps";
      const app = new App({name: "resource-test", version: "1"});
      (async () => {
        await app.connect();
        const supported = !!app.getHostCapabilities()?.serverResources;
        document.body.innerHTML = '<button>Read resource</button><p id="status">' + (supported ? 'Supported' : 'Disabled') + '</p>';
        document.querySelector('button').onclick = async () => {
          try {
            const result = await app.readServerResource({uri: 'box://fixture/document', _meta: {page: 2}});
            document.querySelector('#status').textContent = JSON.stringify(result.contents);
          } catch (error) { document.querySelector('#status').textContent = String(error); }
        };
        if (${force}) {
          try { await window.parent.__mcpjamHostReadResource({widgetId:'preview',params:{uri:'box://fixture/document'}}); }
          catch (error) { document.querySelector('#status').textContent += ' ' + String(error); }
        }
      })();`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
  });
  return `<html><body><script>${bundle.outputFiles[0].text}</script></body></html>`;
}

async function open(harness: McpAppBrowserHarness, force = false) {
  harnesses.push(harness);
  const result = await harness.renderWidget({
    toolCallId: "preview",
    toolName: "get_file_preview",
    serverId: "box-origin",
    html: await widgetHtml(force),
    keepMounted: true,
  });
  expect(result.status).toBe("rendered");
  return result;
}
async function visible(harness: McpAppBrowserHarness, text: string) {
  expect(
    (
      await harness.runScriptedStep({
        toolCallId: "preview",
        step: { kind: "assert", assertion: { type: "textVisible", text } },
      })
    ).ok,
  ).toBe(true);
}
async function click(harness: McpAppBrowserHarness) {
  expect(
    (
      await harness.runScriptedStep({
        toolCallId: "preview",
        step: {
          kind: "click",
          target: { role: { role: "button", name: "Read resource" } },
        },
      })
    ).ok,
  ).toBe(true);
}

describe.runIf(await isChromiumInstalled())(
  "app resource reads through the real browser bridge",
  () => {
    it.each([
      {
        uri: "box://fixture/document",
        mimeType: "text/plain",
        text: "Page two checkpoints",
      },
      {
        uri: "box://fixture/document",
        mimeType: "application/pdf",
        blob: "JVBERi0xLjQ=",
      },
    ])(
      "relays resource contents from the originating authenticated connection: $mimeType",
      async (content) => {
        const readResource = vi.fn().mockResolvedValue({ contents: [content] });
        const harness = new McpAppBrowserHarness({
          callTool: vi.fn(),
          readResource,
          hostCapabilities: { serverResources: {} },
        });
        const result = await open(harness);
        expect(result.consoleErrors ?? []).toEqual([]);
        await visible(harness, "Supported");
        await click(harness);
        await visible(harness, JSON.stringify([content]));
        expect(readResource).toHaveBeenCalledWith("box-origin", {
          uri: "box://fixture/document",
          _meta: { page: 2 },
        });
      },
    );

    it("does not advertise or proxy disabled resources even if a widget invokes the binding directly", async () => {
      const readResource = vi.fn();
      const harness = new McpAppBrowserHarness({
        callTool: vi.fn(),
        readResource,
        hostCapabilities: {},
      });
      await open(harness, true);
      await visible(harness, "Disabled");
      await visible(harness, "Resource reads disabled by client profile");
      expect(readResource).not.toHaveBeenCalled();
    });

    it("returns upstream read failures to the widget without a fallback connection", async () => {
      const readResource = vi
        .fn()
        .mockRejectedValue(new Error("Resource not found"));
      const harness = new McpAppBrowserHarness({
        callTool: vi.fn(),
        readResource,
        hostCapabilities: { serverResources: {} },
      });
      await open(harness);
      await click(harness);
      await visible(harness, "Resource not found");
      expect(readResource).toHaveBeenCalledTimes(1);
      expect(readResource.mock.calls[0][0]).toBe("box-origin");
    });
  },
);
