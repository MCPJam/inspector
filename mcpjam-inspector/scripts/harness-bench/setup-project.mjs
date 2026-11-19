#!/usr/bin/env node
/**
 * One-time setup of a Jamroom workspace for bench.mjs: Auto-connect on in this
 * browser origin, the hosted harness clients created, and the seeded server
 * connected for each client that can speak its protocol.
 *
 *   node scripts/harness-bench/setup-project.mjs <storage-state.json> <client url> <projectId> [--clients]
 *
 * Without --clients it only turns Auto-connect on (each instance's origin keeps
 * its own), which a second instance on the same workspace needs.
 */
import { createRequire } from "node:module";

const require = createRequire(new URL("../../package.json", import.meta.url));
const { chromium } = require("playwright");
const [storage, client, project, ...flags] = process.argv.slice(2);
const CLIENTS = ["Claude Code", "Codex CLI", "GitHub Copilot CLI", "OpenCode"];
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
// Best-effort UI steps: a miss is reported, not fatal, and the turn's own
// checks decide the outcome.
const bestEffort = (step) => (error) => {
  if (process.env.BENCH_DEBUG) console.error(`[bench] ${step} skipped: ${error.message.split("\n")[0]}`);
};

const browser = await chromium.launch();
const context = await browser.newContext({ storageState: storage, viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
try {
  await page.goto(`${client}/p/${project}/servers`, { waitUntil: "domcontentloaded" });
  const autoConnect = page.locator('[role="switch"][aria-label="Auto-connect servers on this device"]');
  await autoConnect.waitFor({ timeout: 60_000 });
  if ((await autoConnect.getAttribute("aria-checked")) !== "true") await autoConnect.click();
  await sleep(8_000);
  console.log("auto-connect", await autoConnect.getAttribute("aria-checked"));
  if (flags.includes("--clients")) {
    await page.goto(`${client}/p/${project}/playground`, { waitUntil: "domcontentloaded" });
    await page.locator("textarea").first().waitFor({ timeout: 60_000 });
    await sleep(4_000);
    await page.getByRole("button", { name: "Got it" }).first().click({ timeout: 2_000 }).catch(bestEffort("dismiss the tip"));
    // A new workspace can open in compare mode: leave it for one client.
    if (!(await page.locator('button[aria-label^="Client: "]').count())) {
      await page.locator("textarea").first().locator("xpath=ancestor::form[1]").locator("button").filter({ hasText: /\S/ }).last().click();
      await page.getByRole("button", { name: "Use only MCPJam" }).first().click();
      await sleep(2_000);
    }
    for (const name of CLIENTS) {
      const exact = new RegExp(`^\\s*${name}\\s*$`);
      await page.locator('button[aria-label^="Client: "]').first().click();
      const option = page.locator('[role="option"]').filter({ hasText: exact });
      if (await option.first().isVisible({ timeout: 3_000 }).catch(() => false)) {
        await option.first().click();
      } else {
        await page.getByRole("button", { name: "Add clients" }).click();
        await page.getByRole("button", { name, exact: true }).click();
        await page.getByRole("button", { name: "Create", exact: true }).click();
      }
      await sleep(3_000);
      if (await page.getByText("No server connected yet").first().isVisible().catch(() => false)) {
        await page.getByRole("button", { name: "Connect a server" }).first().click();
        await page.getByRole("button", { name: "Connect stateless" }).first().click().catch(bestEffort("connect the server"));
        await sleep(8_000);
      }
      const connected = !(await page.getByText("No server connected yet").first().isVisible().catch(() => false));
      console.log(name, connected ? "server connected" : "no server (protocol or connect refused)");
      await page.keyboard.press("Escape").catch(bestEffort("close the picker"));
    }
  }
} finally {
  await context.storageState({ path: storage });
  await browser.close();
}
