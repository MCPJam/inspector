import { build } from "esbuild";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { PluginWorkspaceRecorder } from "../plugin-workspace-recorder.js";
import {
  McpAppBrowserHarness,
  isChromiumInstalled,
} from "../mcp-app-browser-harness.js";
import { parsePluginWorkspaceRecording } from "../../../shared/plugin-workspace-recording.js";
import { pluginWorkspaceReplayDocument } from "../../../shared/plugin-workspace-replay.js";
import {
  serializeBrowserStepsForBackend,
  toBrowserStepPayload,
} from "../../services/browser-artifact-serialization.js";

const privateKey = "private-server/path/token";
describe("bounded host-owned workspace recording", () => {
  it("records stable opaque identities, bounded history and immutable snapshots", () => {
    const recorder = new PluginWorkspaceRecorder();
    recorder.open(privateKey);
    const initial = recorder.snapshot("chatgpt")!;
    const finish = recorder.beginCall(privateKey);
    finish(true);
    finish(false);
    recorder.close(privateKey);
    const result = recorder.snapshot("chatgpt")!;
    expect(parsePluginWorkspaceRecording(result)).toEqual(result);
    expect(initial.events.map((event) => event.kind)).toEqual([
      "opened",
      "shown",
    ]);
    expect(result.events.map((event) => event.kind)).toEqual([
      "opened",
      "shown",
      "call-started",
      "call-completed",
      "hidden",
      "closed",
    ]);
    expect(result.instances[0].instanceId).toBe(
      initial.instances[0].instanceId,
    );
    expect(JSON.stringify(result)).not.toContain(privateKey);
    for (let i = 0; i < 200; i++) {
      recorder.open(String(i));
      recorder.beginCall(String(i))(false);
      recorder.close(String(i));
    }
    const bounded = recorder.snapshot("codex")!;
    expect(bounded.instances).toHaveLength(64);
    expect(bounded.events).toHaveLength(128);
    expect(bounded.droppedEvents).toBeGreaterThan(0);
    expect(parsePluginWorkspaceRecording(bounded)).toEqual(bounded);
    expect(recorder.snapshot("unknown-host")).toBeUndefined();
  });

  it("rejects an artifact recording containing private or app-authored fields", async () => {
    const recorder = new PluginWorkspaceRecorder();
    recorder.open(privateKey);
    const recording = {
      ...recorder.snapshot("chatgpt")!,
      privatePayload: privateKey,
    };
    await expect(
      serializeBrowserStepsForBackend(
        [
          {
            toolCallId: "call",
            stepIndex: 0,
            promptIndex: 0,
            action: "left_click",
            elapsedMs: 1,
            ts: 1,
            pluginWorkspace: recording,
          },
        ],
        undefined,
      ),
    ).rejects.toThrow("PLUGIN_RECORDING_INVALID");
  });
});

it.runIf(await isChromiumInstalled())(
  "captures a real guest interaction and replays its artifact without executing it",
  async () => {
    const guest = await build({
      stdin: {
        contents: `
      import { App } from "@modelcontextprotocol/ext-apps";
      const app = new App({ name: "private-app-label", version: "1" });
      await app.connect();
      const button = document.createElement("button");
      button.textContent = "Apply";
      button.onclick = async () => {
        await app.callServerTool({ name: "private-tool-name", arguments: { secret: "private-input" } });
        button.textContent = "Applied";
      };
      document.body.append(button);
    `,
        loader: "ts",
        resolveDir: process.cwd(),
      },
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
    });
    let effects = 0;
    const harness = new McpAppBrowserHarness({
      callTool: async () => {
        effects++;
        return { content: [{ type: "text", text: "private-result" }] };
      },
      readResource: async () => ({ contents: [] }),
      getWorkspacePresentation: () => ({ hostStyle: "chatgpt" }),
      budgets: {
        renderTimeoutMs: 5000,
        settleTimeoutMs: 1500,
        paintTimeoutMs: 1200,
      },
    });
    const browser = await chromium.launch({ headless: true });
    try {
      const input = {
        toolCallId: "private-routing-id",
        toolName: "private-entrypoint",
        serverId: "private-server",
        html: `<html><body><script type="module">${guest.outputFiles[0].text}</script></body></html>`,
        resourceUri: "ui://private/path",
        keepMounted: true,
      };
      const opened = await harness.renderWidget(input);
      expect(opened.status).toBe("rendered");
      const changed = await harness.runScriptedStep({
        toolCallId: input.toolCallId,
        step: {
          kind: "click",
          target: { role: { role: "button", name: "Apply" } },
        },
      });
      expect(changed.ok).toBe(true);
      expect(effects).toBe(1);
      expect((await harness.captureSnapshot(input.toolCallId)).tree).toContain(
        "Applied",
      );
      const capture = changed.pluginWorkspace;
      expect(capture).toBeDefined();
      expect(capture?.events.map((event) => event.kind)).toEqual([
        "opened",
        "shown",
        "call-started",
        "call-completed",
      ]);
      expect(opened.pluginWorkspace?.events).toHaveLength(2);
      const serialized = await serializeBrowserStepsForBackend(
        [
          {
            ...changed,
            toolCallId: input.toolCallId,
            stepIndex: 0,
            promptIndex: 0,
            action: "left_click",
            ts: 1,
          },
        ],
        undefined,
      );
      const artifact = toBrowserStepPayload(serialized[0]);
      expect(artifact.pluginWorkspace).toEqual(capture);
      expect(JSON.stringify(artifact.pluginWorkspace)).not.toMatch(
        /private|secret|Applied|Apply/,
      );
      const repeated = await harness.renderWidget(input);
      expect(effects).toBe(1);
      expect(repeated.pluginWorkspace?.instances[0].instanceId).toBe(
        capture?.instances[0].instanceId,
      );
      for (const javaScriptEnabled of [false, true]) {
        const context = await browser.newContext({ javaScriptEnabled });
        const page = await context.newPage();
        const requests: string[] = [];
        await context.route("**/*", (route) => {
          requests.push(route.request().url());
          return route.abort();
        });
        const doc = pluginWorkspaceReplayDocument(
          artifact.pluginWorkspace,
          changed.screenshotBase64,
        );
        const escaped = doc
          .replaceAll("&", "&amp;")
          .replaceAll('"', "&quot;")
          .replaceAll("<", "&lt;");
        await page.setContent(
          `<iframe sandbox="" srcdoc="${escaped}"></iframe>`,
        );
        const frame = page
          .frames()
          .find((value) => value !== page.mainFrame())!;
        const dimensions = await frame
          .locator("img")
          .evaluate(async (image) => {
            if (!(image instanceof HTMLImageElement))
              throw new Error("Missing replay image");
            await image.decode();
            return [image.naturalWidth, image.naturalHeight];
          });
        expect(dimensions.every((value) => value > 0)).toBe(true);
        expect(
          await frame.locator("script,form,iframe,object,embed").count(),
        ).toBe(0);
        expect(requests).toEqual([]);
        expect(effects).toBe(1);
        await context.close();
      }
    } finally {
      await harness.dispose();
      await browser.close();
    }
  },
  45000,
);
