/**
 * A turn on the fixture vendor, in a real browser: the order of the steps,
 * the send that happens exactly once, the app's approval prompt answered with
 * Always allow, and the typed failures that stop a run before it sends.
 *
 * Evidence: fixture (local test doubles), not a live vendor.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import {
  startFixtureUpstream,
  type FixtureUpstream,
} from "../../../../test/support/web-clients/fixture-upstream";
import {
  startFixtureVendor,
  type FixtureVendor,
} from "../../../../test/support/web-clients/fixture-vendor";
import { createMemorySendJournal, driveRealUiTurn } from "../drive-turn";
import { createFixtureWebPageModule } from "../fixture-web";
import { RealUiError } from "../page-module";
import { createPlaywrightDriver } from "../playwright-driver";

let browser: Browser;
let context: BrowserContext;
let vendor: FixtureVendor;
let upstream: FixtureUpstream;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});
beforeEach(async () => {
  vendor = await startFixtureVendor();
  upstream = await startFixtureUpstream();
  context = await browser.newContext();
});
afterEach(async () => {
  await context.close();
  await vendor.close();
  await upstream.close();
});

async function signedInDriver() {
  const page = await context.newPage();
  await page.goto(`${vendor.url}/sign-in?as=runner@example.com`);
  return createPlaywrightDriver(page, { sites: [vendor.url] });
}

function turn(driver: Awaited<ReturnType<typeof signedInDriver>>, journal = createMemorySendJournal()) {
  return driveRealUiTurn({
    module: createFixtureWebPageModule(vendor.url),
    driver,
    connector: { name: "MCPJam fixture", url: upstream.url },
    prompt: "say hello",
    journal,
    turnKey: "turn-1",
    stepTimeoutMs: 10_000,
    replyTimeoutMs: 20_000,
  });
}

// A real browser under a loaded test runner: each turn gets room to finish.
describe("driveRealUiTurn on the fixture vendor", { timeout: 90_000 }, () => {
  it("adds the connector, sends once, answers the app's approval and reads the saved chat", async () => {
    const steps: string[] = [];
    const driver = await signedInDriver();
    const result = await driveRealUiTurn({
      module: createFixtureWebPageModule(vendor.url),
      driver,
      connector: { name: "MCPJam fixture", url: upstream.url },
      prompt: "say hello",
      journal: createMemorySendJournal(),
      turnKey: "turn-1",
      stepTimeoutMs: 10_000,
      replyTimeoutMs: 20_000,
      onStep: (step) => steps.push(step),
    });
    expect(steps).toEqual([
      "sign_in_check",
      "connector",
      "new_chat",
      "enable_connector",
      "send",
      "reply",
      "read_conversation",
    ]);
    expect(result.account).toEqual({ email: "runner@example.com", workspace: "Fixture workspace" });
    expect(result.approvalsAnswered).toBe(1);
    expect(result.resumed).toBe(false);
    expect(vendor.sends).toEqual(["say hello"]);
    expect(vendor.connectors.get("MCPJam fixture")).toBe(upstream.url);
    expect(result.conversation.replyText).toBe("echo said: echo: say hello");
    const [call] = result.conversation.toolCalls;
    expect(call).toMatchObject({ toolName: "echo", toolUseId: expect.stringMatching(/^toolu_fixture_/) });
    const received = upstream.received.find((entry) => entry.method === "tools/call");
    expect(received?.params?._meta).toMatchObject({ "claudecode/toolUseId": call!.toolUseId });
  });

  it("replaces a connector that points somewhere else instead of reusing it", async () => {
    vendor.connectors.set("MCPJam fixture", "http://127.0.0.1:9/elsewhere");
    await turn(await signedInDriver());
    expect(vendor.connectors.get("MCPJam fixture")).toBe(upstream.url);
  });

  it("continues in the chat an earlier attempt already sent, without sending again", async () => {
    const journal = createMemorySendJournal();
    await turn(await signedInDriver(), journal);
    expect(vendor.sends).toHaveLength(1);
    const again = await turn(await signedInDriver(), journal);
    expect(again.resumed).toBe(true);
    expect(vendor.sends).toHaveLength(1);
  });

  it("stops as send_ambiguous when the journal says sending and no chat holds the prompt", async () => {
    const journal = createMemorySendJournal();
    await journal.write("turn-1", { state: "sending", at: new Date().toISOString() });
    const failure = await turn(await signedInDriver(), journal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RealUiError);
    expect((failure as RealUiError).failure).toMatchObject({ kind: "send_ambiguous", step: "send" });
    expect(vendor.sends).toEqual([]);
  });

  it("returns needs_sign_in on a human check and never sends", async () => {
    const driver = await signedInDriver();
    vendor.challenge = true;
    const failure = await turn(driver).catch((error: unknown) => error);
    expect((failure as RealUiError).failure).toMatchObject({
      kind: "needs_sign_in",
      reason: "human_check",
      step: "sign_in_check",
    });
    expect(vendor.sends).toEqual([]);
  });

  it("returns needs_sign_in with the pending step when another account is signed in", async () => {
    const failure = await driveRealUiTurn({
      module: createFixtureWebPageModule(vendor.url),
      driver: await signedInDriver(),
      connector: { name: "MCPJam fixture", url: upstream.url },
      prompt: "say hello",
      journal: createMemorySendJournal(),
      turnKey: "turn-1",
      expectedEmail: "saved@example.com",
      stepTimeoutMs: 10_000,
    }).catch((error: unknown) => error);
    expect((failure as RealUiError).failure).toMatchObject({
      kind: "needs_sign_in",
      reason: "wrong_account",
    });
    expect((failure as RealUiError).pendingStep).toMatchObject({
      stepId: "sign_in_check",
      turnId: "turn-1",
      startedAt: expect.any(String),
    });
    expect(vendor.sends).toEqual([]);
  });

  it("returns needs_sign_in when the account is signed out", async () => {
    const page = await context.newPage();
    const driver = await createPlaywrightDriver(page, { sites: [vendor.url] });
    const failure = await turn(driver).catch((error: unknown) => error);
    expect((failure as RealUiError).failure).toMatchObject({
      kind: "needs_sign_in",
      reason: "signed_out",
    });
    expect(vendor.sends).toEqual([]);
  });

  it("keeps the signed-in browser on its own sites", async () => {
    const page = await context.newPage();
    const driver = await createPlaywrightDriver(page, { sites: [vendor.url] });
    await expect(driver.navigate(upstream.url)).rejects.toMatchObject({
      code: "site_blocked",
    });
    // A page that tries to leave on its own is stopped at the browser.
    await page.goto(`${vendor.url}/sign-in`);
    await page.evaluate((target) => {
      location.href = target;
    }, upstream.url);
    await page.waitForTimeout(200);
    // The navigation is aborted, so the tab never reaches the other site.
    expect(page.url().startsWith(upstream.url)).toBe(false);
    expect(new URL(page.url()).origin).not.toBe(new URL(upstream.url).origin);
  });
});
