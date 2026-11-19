/** Run with: node --import tsx --test shared/__tests__/plugin-workspace-replay.browser.e2e.mjs */
import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { pluginWorkspaceReplayDocument } from "../plugin-workspace-replay.ts";

// An actual 1x1 PNG; browser decoding, not its magic prefix, is asserted below.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const recording = {
  version: 2,
  runtime: "codex",
  sequence: 1,
  droppedEvents: 0,
  instances: [],
  events: [{ sequence: 1, kind: "call-completed", instanceId: "b83ebc97-291c-4b9e-bac0-c651fa4641aa", generation: 1,
    operationId: "b83ebc97-291c-4b9e-bac0-c651fa4641ab", feature: "file-write", fidelity: "observed", outcome: "conflict" }],
};
const attribute = (text) => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

for (const javaScriptEnabled of [false, true]) {
test(`captured workspace is inert with browser JavaScript ${javaScriptEnabled ? "enabled" : "disabled"}`, async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled });
    const page = await context.newPage();
    const requests = [];
    await context.route("**/*", (route) => {
      requests.push(route.request().url());
      return route.abort();
    });
    // App-authored bytes placed after a valid raster cannot become replay HTML.
    const adversarialImage = Buffer.concat([
      Buffer.from(PNG, "base64"),
      Buffer.from('<script>window.effect=1;fetch("https://should-not-run.invalid")</script>'),
    ]).toString("base64");
    const doc = pluginWorkspaceReplayDocument(recording, adversarialImage);
    await page.setContent(`<iframe title="replay" sandbox="" referrerpolicy="no-referrer" srcdoc="${attribute(doc)}"></iframe>`);
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    assert.ok(frame);
    await frame.waitForSelector("img");
    const image = await frame.locator("img").evaluate(async (element) => {
      await element.decode();
      return { width: element.naturalWidth, height: element.naturalHeight };
    });
    assert.deepEqual(image, { width: 1, height: 1 });
    assert.equal(await frame.locator("script, form, iframe, object, embed").count(), 0);
    assert.equal(await frame.locator("body").innerText(), "");
    assert.deepEqual(requests, []);
    const screenshot = await page.locator("iframe").screenshot();
    assert.ok(screenshot.byteLength > 0);
    await context.close();
  } finally {
    await browser.close();
  }
});

}
