import type { PageDriver } from "./page-driver.js";
import { RealUiError, cssString, needsSignIn, pageChanged, waitVisibleUnlessBlocked, type StepContext, type RealUiStep } from "./page-module.js";

export const CHATGPT_CHALLENGE = 'iframe[src*="arkoselabs"], iframe[src*="challenges.cloudflare.com"]';
/** The composer the live site showed a signed-in account. */
export const CHATGPT_COMPOSER = '[contenteditable="true"][aria-label="Ask ChatGPT"]';

export const exactRole = (kind: string, name: string) => `role=${kind}[name="${cssString(name)}"s]`;
export const waitForControl = (driver: PageDriver, selector: string, ctx: StepContext, what: string, step: RealUiStep) =>
  waitVisibleUnlessBlocked(driver, selector, ctx, { what, step, challengeSelectors: [CHATGPT_CHALLENGE] });

/** Settings exposes the account identity in the hosted browser's supported page UI. */
export async function readChatGptAccount(driver: PageDriver, ctx: StepContext) {
  const profile = exactRole("button", "Open profile menu");
  if ((await driver.readText(profile)) === undefined) {
    const sidebar = exactRole("button", "Show sidebar");
    await waitForControl(driver, sidebar, ctx, "the account sidebar", "sign_in_check");
    await driver.click(sidebar);
  }
  await waitForControl(driver, profile, ctx, "the account menu", "sign_in_check");
  await driver.click(profile);
  const settings = exactRole("menuitem", "Settings");
  await waitForControl(driver, settings, ctx, "Settings", "sign_in_check");
  await driver.click(settings);
  const account = `role=dialog >> ${exactRole("button", "Account")}`;
  await waitForControl(driver, account, ctx, "Account settings", "sign_in_check");
  await driver.click(account);
  const identity = "role=dialog >> text=/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/";
  await waitForControl(driver, identity, ctx, "the signed-in account email", "sign_in_check");
  const email = await driver.readText(identity);
  if (!email) throw pageChanged("sign_in_check", "ChatGPT did not show the account email.");
  await driver.click(exactRole("button", "Close dialog"));
  return { email };
}

/** Plugins lists installed connectors. A plugin's Settings shows its actual server URL. */
export async function ensureChatGptPlugin(driver: PageDriver, connector: { name: string; url: string }, ctx: StepContext) {
  await driver.navigate("https://chatgpt.com/plugins");
  const add = exactRole("button", "Add");
  await waitForControl(driver, add, ctx, "the plugins list", "connector");
  const installed = exactRole("link", connector.name);
  if ((await driver.readText(installed)) !== undefined) {
    await driver.click(installed);
    const settings = exactRole("link", "Settings");
    await waitForControl(driver, settings, ctx, "plugin settings", "connector");
    await driver.click(settings);
    await waitForControl(driver, exactRole("link", "View details"), ctx, "the installed plugin settings", "connector");
    if ((await driver.readText(`main >> text="${cssString(connector.url)}"`)) !== undefined) return;
    throw new RealUiError({ kind: "connector_failed", step: "connector",
      message: `Check the server address for ${connector.name} in ChatGPT's plugin settings before running again.` });
  }
  await driver.click(add);
  const custom = exactRole("menuitem", "Add custom MCP server");
  await waitForControl(driver, custom, ctx, "Add custom MCP server", "connector");
  await driver.click(custom);
  const name = `role=dialog >> ${exactRole("textbox", "Name")}`;
  await waitForControl(driver, name, ctx, "the new plugin form", "connector");
  await driver.type(name, connector.name);
  await driver.type(`role=dialog >> ${exactRole("textbox", "Server URL")}`, connector.url);
  if ((await driver.readText('role=dialog >> role=checkbox[name="I understand and want to continue"s][checked=false]')) !== undefined) {
    throw needsSignIn("consent", "connector", "Review the server in ChatGPT, confirm that you trust it, and finish creating the plugin.");
  }
  await driver.click(`role=dialog >> ${exactRole("button", "Create as a plugin")}`);
  await waitForControl(driver, installed, ctx, "the installed plugin", "connector");
}
