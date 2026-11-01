import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import {
  McpAppBrowserHarness,
  isChromiumInstalled,
} from "../mcp-app-browser-harness";

/**
 * Tool data delivery against a real widget: the guest runs the real ext-apps
 * App SDK, so "accepted" and "rejected" below are the SDK's own verdicts, not
 * the harness's guess. Each case separates four facts that the old status
 * conflated: the widget accepted its data, the data updated, the widget
 * painted, and the send failed.
 *
 * The guest writes what its SDK did onto the harness page, which outlives the
 * widget iframe, so a case can read it even after a failed render tore the
 * widget down.
 */
function dataGuestSource(opts: { paint: boolean; breakResultSend: boolean }) {
  return `
import { App } from "@modelcontextprotocol/ext-apps";
const report = (key, value) => {
  window.parent.document.body.dataset[key] = value;
};
${
  // The host sends by calling postMessage on this window; throwing for the
  // tool result is what a closed transport looks like from the host. Other
  // messages are re-delivered as from the host: calling the real postMessage
  // from here would make this window their source, which the SDK ignores.
  opts.breakResultSend
    ? `window.postMessage = (message) => {
  if (message && message.method === "ui/notifications/tool-result") {
    throw new Error("fixture transport closed");
  }
  const data = structuredClone(message);
  setTimeout(() =>
    window.dispatchEvent(new MessageEvent("message", { data, source: window.parent })),
  );
};`
    : ""
}
const app = new App({ name: "fixture-data", version: "1.0.0" });
app.addEventListener("toolresult", (result) => {
  report("fixtureAccepted", "true");
  const label = document.createElement("p");
  label.textContent = String(result.structuredContent?.label ?? "");
  ${opts.paint ? 'label.style.cssText = "font-size:32px;padding:40px";' : "label.hidden = true;"}
  document.body.appendChild(label);
  report("fixtureData", label.textContent);
});
app.onerror = (error) => report("fixtureRejected", String(error).slice(0, 160));
${
  opts.paint
    ? `const title = document.createElement("h1");
title.textContent = "Scene viewer";
title.style.cssText = "font-size:40px;padding:40px";
document.body.appendChild(title);`
    : ""
}
app.connect().catch((error) => report("fixtureConnectError", String(error)));
`;
}

async function guestHtml(source: string): Promise<string> {
  const bundle = await build({
    stdin: { contents: source, resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    write: false,
    logLevel: "silent",
  });
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${bundle.outputFiles[0].text}</script></body></html>`;
}

const VALID_RESULT = {
  content: [{ type: "text", text: "Scene saved" }],
  structuredContent: { label: "scene-42" },
};
// The F18 case: the Claude Code adapter hands the widget hook an MCP tool's
// text content flattened to a string, bare or where the content array goes.
const CLAUDE_FLATTENED_TEXT = "Shared the scene at https://example.test/s/42";

const CHROMIUM_AVAILABLE = await isChromiumInstalled();

let paintingGuest = "";
let blankGuest = "";
let brokenSendGuest = "";
beforeAll(async () => {
  paintingGuest = await guestHtml(
    dataGuestSource({ paint: true, breakResultSend: false }),
  );
  blankGuest = await guestHtml(
    dataGuestSource({ paint: false, breakResultSend: false }),
  );
  brokenSendGuest = await guestHtml(
    dataGuestSource({ paint: true, breakResultSend: true }),
  );
}, 60_000);

const harnesses: McpAppBrowserHarness[] = [];
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.dispose();
});

async function render(html: string, toolOutput: unknown) {
  const harness = new McpAppBrowserHarness({
    callTool: vi.fn(async () => ({ content: [] })),
    readResource: vi.fn(),
    budgets: { renderTimeoutMs: 1200, settleTimeoutMs: 1200, paintTimeoutMs: 800 },
  });
  harnesses.push(harness);
  const observation = await harness.renderWidget({
    toolCallId: "tc-data",
    toolName: "share_scene",
    serverId: "s1",
    html,
    toolInput: { scene: 42 },
    toolOutput,
  });
  const guest: Record<string, string | undefined> = await harness["page"]!.evaluate(
    () => ({ ...document.body.dataset }),
  );
  return { observation, guest };
}

describe.skipIf(!CHROMIUM_AVAILABLE)("McpAppBrowserHarness — tool data delivery", () => {
  it("renders a widget that accepted its data, updated and painted", async () => {
    const { observation, guest } = await render(paintingGuest, VALID_RESULT);
    expect(guest).toMatchObject({ fixtureAccepted: "true", fixtureData: "scene-42" });
    expect(guest.fixtureRejected).toBeUndefined();
    expect(observation.status).toBe("rendered");
    expect(observation.consoleErrors).toBeUndefined();
  }, 30_000);

  it.each([
    ["bare flattened text", CLAUDE_FLATTENED_TEXT],
    ["string content", { content: CLAUDE_FLATTENED_TEXT }],
  ])(
    "does not count Claude's %s as rendered when the widget rejects it but paints",
    async (_label, toolOutput) => {
      const { observation, guest } = await render(paintingGuest, toolOutput);
      // The real SDK refused it and the data never reached the widget...
      expect(guest.fixtureRejected).toBeDefined();
      expect(guest.fixtureAccepted).toBeUndefined();
      expect(guest.fixtureData).toBeUndefined();
      // ...though the widget painted, which used to be enough for "rendered".
      expect(observation.bridgeInitialized).toBe(true);
      expect(observation.screenshotBase64).toBeTruthy();
      expect(observation.status).toBe("render_error");
      expect(observation.consoleErrors?.[0]).toMatch(
        /^The widget rejected this tool result because it does not match the MCP Apps tool result format \(/,
      );
    },
    30_000,
  );

  it("keeps a widget that accepted its data but painted nothing blank", async () => {
    const { observation, guest } = await render(blankGuest, VALID_RESULT);
    expect(guest).toMatchObject({ fixtureAccepted: "true", fixtureData: "scene-42" });
    expect(observation.status).toBe("blank_screenshot");
    expect(observation.consoleErrors).toBeUndefined();
  }, 30_000);

  it("records a failed send instead of reporting the painted widget as rendered", async () => {
    const { observation, guest } = await render(brokenSendGuest, VALID_RESULT);
    expect(guest.fixtureAccepted).toBeUndefined();
    expect(observation.status).toBe("render_error");
    expect(observation.consoleErrors?.[0]).toBe(
      "The tool result could not be sent to the widget (fixture transport closed).",
    );
  }, 30_000);
});
