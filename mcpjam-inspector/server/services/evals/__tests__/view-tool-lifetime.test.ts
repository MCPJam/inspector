import { build } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import { McpAppBrowserHarness } from "../../../utils/mcp-app-browser-harness.js";
import { createToolPolicyGate } from "../tool-policy-gate.js";
import { evalWidgetServerCall } from "../view-tool-policy.js";

describe("eval widget server-call policy lifetime", () => {
  it("blocks render, delayed and idle calls in a real view without a view-tool action", async () => {
    const bundle = await build({
      stdin: {
        contents: `
      import { App } from '@modelcontextprotocol/ext-apps';
      const app = new App({name:'policy-fixture',version:'1'});
      await app.connect();
      document.body.textContent='Policy fixture';
      await app.callServerTool({name:'delete',arguments:{stage:'render'}});
      setTimeout(() => app.callServerTool({name:'delete',arguments:{stage:'timer'}}), 50);
      setTimeout(() => app.callServerTool({name:'delete',arguments:{stage:'idle'}}), 400);
    `,
        resolveDir: process.cwd(),
        loader: "ts",
      },
      bundle: true,
      write: false,
      format: "esm",
      target: "es2022",
    });
    const executeTool = vi.fn(async () => ({ content: [] }));
    const gate = createToolPolicyGate({
      policy: { mode: "readOnly" },
      annotations: new Map(),
    });
    const dispatch = evalWidgetServerCall(gate, { executeTool });
    const stages: unknown[] = [];
    const harness = new McpAppBrowserHarness({
      enableViewTools: true,
      readResource: async () => ({ contents: [] }),
      callTool: async (server, name, args) => {
        stages.push(args.stage);
        return dispatch(server, name, args);
      },
      budgets: {
        renderTimeoutMs: 3000,
        paintTimeoutMs: 1000,
        settleTimeoutMs: 300,
        toolCallDrainTimeoutMs: 1000,
      },
    });
    try {
      await harness.renderWidget({
        toolCallId: "A",
        toolName: "board",
        serverId: "server",
        html: `<html><body><script type="module">${bundle.outputFiles[0].text}</script></body></html>`,
        keepMounted: true,
      });
      await vi.waitFor(
        () => expect(stages).toEqual(["render", "timer", "idle"]),
        { timeout: 3000 },
      );
      expect(executeTool).not.toHaveBeenCalled();
      expect(gate.blocks).toHaveLength(3);
      expect(harness.viewTools.drainRecords()).toEqual([]);
    } finally {
      await harness.dispose();
    }
  }, 30000);
});
