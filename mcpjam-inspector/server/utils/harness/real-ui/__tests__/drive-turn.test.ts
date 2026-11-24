/**
 * A turn on the fixture vendor, in a real browser: the order of the steps,
 * the send that happens exactly once, the app's approval prompt answered with
 * Always allow, and the typed failures that stop a run before it sends.
 *
 * Evidence: fixture (local test doubles), not a live vendor.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright";
import { isChromiumInstalled } from "../../../browser-rendering-setup";
import {
  startFixtureUpstream,
  type FixtureUpstream,
} from "../../../../test/support/web-clients/fixture-upstream";
import {
  startFixtureVendor,
  type FixtureVendor,
} from "../../../../test/support/web-clients/fixture-vendor";
import {
  createMemorySendJournal,
  driveRealUiTurn,
  type SendJournal,
} from "../drive-turn";
import { createFixtureWebPageModule } from "../fixture-web";
import { RealUiError, type RealUiPageModule } from "../page-module";
import { createPlaywrightDriver } from "../playwright-driver";

// Locally a missing browser skips the suite. CI's pinned Playwright image
// ships Chromium, so there its absence fails instead of skipping these checks.
const CHROMIUM_AVAILABLE = await isChromiumInstalled();
if (process.env.CI && !CHROMIUM_AVAILABLE) {
  throw new Error(
    "The real-UI turn suite needs Chromium, which the pinned Playwright CI image installs.",
  );
}
/** `describe`, skipped where the pinned Chromium isn't installed. */
const inChromium = describe.skipIf(!CHROMIUM_AVAILABLE);

let browser: Browser;
const contexts: BrowserContext[] = [];
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
});
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.close()));
  await vendor.close();
  await upstream.close();
});

/**
 * A page off the sites that no request carries, so neither the routes nor
 * CDP see it land: what the driver's blank page is the second line for.
 */
const LANDED_WITHOUT_A_REQUEST = "data:text/html,<p>elsewhere</p>";

/** A page in a context of its own: a driver closes every other page in its context. */
async function newPage() {
  const context = await browser.newContext();
  contexts.push(context);
  return context.newPage();
}

async function signedInDriver() {
  const page = await newPage();
  await page.goto(`${vendor.url}/sign-in?as=runner@example.com`);
  return createPlaywrightDriver(page, { sites: [vendor.url] });
}

function turn(
  driver: Awaited<ReturnType<typeof signedInDriver>>,
  journal = createMemorySendJournal(),
  overrides: Partial<Parameters<typeof driveRealUiTurn>[0]> = {},
) {
  return driveRealUiTurn({
    module: createFixtureWebPageModule(vendor.url),
    driver,
    connectors: [{ name: "MCPJam fixture", url: upstream.url }],
    prompt: "say hello",
    journal,
    turnKey: "turn-1",
    stepTimeoutMs: 10_000,
    replyTimeoutMs: 20_000,
    ...overrides,
  });
}

// A real browser under a loaded test runner: each turn gets room to finish.
inChromium("driveRealUiTurn on the fixture vendor", { timeout: 90_000 }, () => {
  it("adds the connector, sends once, answers the app's approval and reads the saved chat", async () => {
    const steps: string[] = [];
    const driver = await signedInDriver();
    const result = await driveRealUiTurn({
      module: createFixtureWebPageModule(vendor.url),
      driver,
      connectors: [{ name: "MCPJam fixture", url: upstream.url }],
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

  it("is asked to approve the tool again once its connector was replaced", async () => {
    expect((await turn(await signedInDriver())).approvalsAnswered).toBe(1);
    vendor.connectors.set("MCPJam fixture", "http://127.0.0.1:9/elsewhere");
    const again = await turn(await signedInDriver());
    expect(vendor.connectors.get("MCPJam fixture")).toBe(upstream.url);
    expect(again.approvalsAnswered).toBe(1);
  });

  it("continues in the chat an earlier attempt already sent, without sending again", async () => {
    const journal = createMemorySendJournal();
    await turn(await signedInDriver(), journal);
    expect(vendor.sends).toHaveLength(1);
    const again = await turn(await signedInDriver(), journal);
    expect(again.resumed).toBe(true);
    expect(vendor.sends).toHaveLength(1);
  });

  it("continues in its own sent chat, not a newer chat another turn sent with the same prompt", async () => {
    const journal = createMemorySendJournal();
    const first = await turn(await signedInDriver(), journal);
    // Another turn (its own journal) sends the same prompt in a newer chat.
    const other = await turn(await signedInDriver());
    expect(other.conversation.url).not.toBe(first.conversation.url);
    const again = await turn(await signedInDriver(), journal);
    expect(again.resumed).toBe(true);
    expect(again.conversation.url).toBe(first.conversation.url);
    expect(vendor.sends).toHaveLength(2);
  });

  it("journals a chat it learns only after the reply, so a restart comes back to it", async () => {
    const fixture = createFixtureWebPageModule(vendor.url);
    // A site that doesn't say which chat the send landed in.
    const module: RealUiPageModule = {
      ...fixture,
      async send(driver, prompt, ctx) {
        await fixture.send(driver, prompt, ctx);
        return {};
      },
    };
    const journal = createMemorySendJournal();
    const first = await turn(await signedInDriver(), journal, { module });
    const entry = await journal.read("turn-1");
    expect(entry).toMatchObject({
      state: "sent",
      conversationUrl: first.conversation.url,
    });
    // Still the send's own time, from before its chat was created.
    const chat = vendor.chats.get(first.conversation.conversationId);
    expect(Date.parse(entry!.at)).toBeLessThanOrEqual(
      Date.parse(chat!.createdAt),
    );
    // Another turn sends the same prompt in a newer chat before the restart.
    await turn(await signedInDriver());
    const again = await turn(await signedInDriver(), journal, { module });
    expect(again.resumed).toBe(true);
    expect(again.conversation.url).toBe(first.conversation.url);
  });

  it("replaces a connector whose URL only starts with the one it needs", async () => {
    vendor.connectors.set("MCPJam fixture", `${upstream.url}-old`);
    await turn(await signedInDriver());
    expect(vendor.connectors.get("MCPJam fixture")).toBe(upstream.url);
  });

  it("confirms a send whose prompt the page shows trimmed, with its spaces collapsed", async () => {
    const result = await driveRealUiTurn({
      module: createFixtureWebPageModule(vendor.url),
      driver: await signedInDriver(),
      connectors: [{ name: "MCPJam fixture", url: upstream.url }],
      prompt: "say  hello ",
      journal: createMemorySendJournal(),
      turnKey: "turn-1",
      stepTimeoutMs: 10_000,
      replyTimeoutMs: 20_000,
    });
    expect(result.resumed).toBe(false);
    expect(vendor.sends).toEqual(["say  hello "]);
  });

  it("stops as send_ambiguous when the journal says sending and no chat holds the prompt", async () => {
    const journal = createMemorySendJournal();
    await journal.write("turn-1", { state: "sending", at: new Date().toISOString() });
    const failure = await turn(await signedInDriver(), journal).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RealUiError);
    expect((failure as RealUiError).failure).toMatchObject({ kind: "send_ambiguous", step: "send" });
    expect(vendor.sends).toEqual([]);
  });

  it("resumes a send journaled as sending in its own chat, and records it for the next restart", async () => {
    const journal = createMemorySendJournal();
    await journal.write("turn-1", {
      state: "sending",
      at: new Date().toISOString(),
    });
    // The prompt went out, but the run stopped before the journal said so.
    const own = await turn(await signedInDriver());
    const resumed = await turn(await signedInDriver(), journal);
    expect(resumed.resumed).toBe(true);
    expect(resumed.conversation.url).toBe(own.conversation.url);
    expect(await journal.read("turn-1")).toMatchObject({
      state: "sent",
      conversationUrl: own.conversation.url,
    });
    // Another turn sends the same prompt in a newer chat before a second restart.
    const other = await turn(await signedInDriver());
    expect(other.conversation.url).not.toBe(own.conversation.url);
    const again = await turn(await signedInDriver(), journal);
    expect(again.conversation.url).toBe(own.conversation.url);
    expect(vendor.sends).toHaveLength(2);
  });

  it("stops as send_ambiguous rather than take a chat from before the send began", async () => {
    // An earlier turn's chat holds the same prompt.
    await turn(await signedInDriver());
    const journal = createMemorySendJournal();
    await journal.write("turn-1", {
      state: "sending",
      at: new Date().toISOString(),
    });
    const failure = await turn(await signedInDriver(), journal).catch(
      (error: unknown) => error,
    );
    expect((failure as RealUiError).failure).toMatchObject({
      kind: "send_ambiguous",
      step: "send",
    });
    expect(vendor.sends).toHaveLength(1);
  });

  it("stops as send_ambiguous when the send fails after the journal says sending", async () => {
    const fixture = createFixtureWebPageModule(vendor.url);
    const journal = createMemorySendJournal();
    const failure = await turn(await signedInDriver(), journal, {
      module: {
        ...fixture,
        // The prompt goes out, then a control the module expects is missing.
        async send(driver, prompt, ctx) {
          const sent = await fixture.send(driver, prompt, ctx);
          await driver.click('[data-testid="send-receipt"]');
          return sent;
        },
      },
    }).catch((error: unknown) => error);
    expect((failure as RealUiError).failure).toMatchObject({
      kind: "send_ambiguous",
      step: "send",
    });
    expect(await journal.read("turn-1")).toMatchObject({ state: "sending" });
    expect(vendor.sends).toEqual(["say hello"]);
  });

  it("stops as send_ambiguous, keeping the sending record, when the journal can't record the sent prompt", async () => {
    const memory = createMemorySendJournal();
    const journal: SendJournal = {
      ...memory,
      async write(turnKey, entry) {
        if (entry.state === "sent") throw new Error("The journal is down.");
        return memory.write(turnKey, entry);
      },
    };
    const failure = await turn(await signedInDriver(), journal).catch(
      (error: unknown) => error,
    );
    expect((failure as RealUiError).failure).toMatchObject({
      kind: "send_ambiguous",
      step: "send",
    });
    expect(await memory.read("turn-1")).toMatchObject({ state: "sending" });
    expect(vendor.sends).toEqual(["say hello"]);
  });

  it("keeps a sign-in the page asks for after the click as needs_sign_in", async () => {
    const fixture = createFixtureWebPageModule(vendor.url);
    const failure = await turn(await signedInDriver(), undefined, {
      module: {
        ...fixture,
        async send(driver, prompt, ctx) {
          await fixture.send(driver, prompt, ctx);
          throw new RealUiError({
            kind: "needs_sign_in",
            reason: "human_check",
            step: "send",
            message: "The site is asking to verify a person is there.",
          });
        },
      },
    }).catch((error: unknown) => error);
    expect((failure as RealUiError).failure).toMatchObject({
      kind: "needs_sign_in",
      reason: "human_check",
    });
  });

  it("sends once when two runs start the same turn together", async () => {
    vendor.connectors.set("MCPJam fixture", upstream.url);
    const memory = createMemorySendJournal();
    // Neither run goes past its read until both have read: both find no send.
    let reads = 0;
    let bothRead = () => {};
    const together = new Promise<void>((resolve) => (bothRead = resolve));
    const journal: SendJournal = {
      ...memory,
      async read(turnKey) {
        const entry = await memory.read(turnKey);
        if (++reads === 2) bothRead();
        await together;
        return entry;
      },
    };
    const drivers = [await signedInDriver(), await signedInDriver()];
    const settled = await Promise.allSettled(
      drivers.map((driver) => turn(driver, journal)),
    );
    expect(vendor.sends).toEqual(["say hello"]);
    const failed = settled.flatMap((result) =>
      result.status === "rejected" ? [result.reason as RealUiError] : [],
    );
    expect(failed.map((error) => error.failure)).toMatchObject([
      { kind: "send_ambiguous", step: "send" },
    ]);
  });

  /** The fixture module, counting how often the turn asks it to send. */
  function countingSends() {
    const fixture = createFixtureWebPageModule(vendor.url);
    const module: RealUiPageModule & { sends: number } = {
      ...fixture,
      sends: 0,
      async send(driver, prompt, ctx) {
        module.sends += 1;
        return fixture.send(driver, prompt, ctx);
      },
    };
    return module;
  }

  it("records and sends nothing when the run is stopped as the send step starts", async () => {
    const stop = new AbortController();
    const module = countingSends();
    const journal = createMemorySendJournal();
    const failure = await turn(await signedInDriver(), journal, {
      module,
      signal: stop.signal,
      onStep: (step) => {
        if (step === "send") stop.abort();
      },
    }).catch((error: unknown) => error);
    expect((failure as RealUiError).failure).toMatchObject({ step: "send" });
    expect(module.sends).toBe(0);
    expect(await journal.read("turn-1")).toBeUndefined();
    expect(vendor.sends).toEqual([]);
  });

  it("does not click send when the run is stopped while the send is recorded", async () => {
    const stop = new AbortController();
    const module = countingSends();
    const memory = createMemorySendJournal();
    const journal: SendJournal = {
      ...memory,
      async claim(turnKey, entry) {
        const claimed = await memory.claim(turnKey, entry);
        stop.abort();
        return claimed;
      },
    };
    const failure = await turn(await signedInDriver(), journal, {
      module,
      signal: stop.signal,
    }).catch((error: unknown) => error);
    expect((failure as RealUiError).failure).toMatchObject({ step: "send" });
    expect(module.sends).toBe(0);
    // Kept: an attempt after this one looks for the chat, never sends.
    expect(await memory.read("turn-1")).toMatchObject({ state: "sending" });
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

  it("returns needs_sign_in when a human check shows in place of the connector list", async () => {
    const failure = await turn(await signedInDriver(), undefined, {
      // The check shows up only once the account has passed its sign-in check.
      onStep: (step) => {
        if (step === "connector") vendor.challenge = true;
      },
    }).catch((error: unknown) => error);
    expect((failure as RealUiError).failure).toMatchObject({
      kind: "needs_sign_in",
      reason: "human_check",
      step: "connector",
    });
    expect(vendor.sends).toEqual([]);
  });

  it("returns needs_sign_in with the pending step when another account is signed in", async () => {
    const failure = await driveRealUiTurn({
      module: createFixtureWebPageModule(vendor.url),
      driver: await signedInDriver(),
      connectors: [{ name: "MCPJam fixture", url: upstream.url }],
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
    const page = await newPage();
    const driver = await createPlaywrightDriver(page, { sites: [vendor.url] });
    const failure = await turn(driver).catch((error: unknown) => error);
    expect((failure as RealUiError).failure).toMatchObject({
      kind: "needs_sign_in",
      reason: "signed_out",
    });
    expect(vendor.sends).toEqual([]);
  });

  it("keeps the signed-in browser on its own sites", async () => {
    const page = await newPage();
    const driver = await createPlaywrightDriver(page, { sites: [vendor.url] });
    await expect(driver.navigate(upstream.url)).rejects.toMatchObject({
      code: "site_blocked",
    });
    // A page that tries to leave on its own is stopped at the browser.
    await page.goto(`${vendor.url}/sign-in`);
    expect(page.url()).toBe(`${vendor.url}/new`);
    const stopped = page.waitForEvent("requestfailed", (request) =>
      request.url().startsWith(upstream.url),
    );
    await page.evaluate((target) => {
      location.href = target;
    }, upstream.url);
    expect((await stopped).failure()?.errorText).toBe(
      "net::ERR_BLOCKED_BY_CLIENT",
    );
    // Chromium shows its own error page in place of the other site.
    await expect.poll(() => page.url()).toMatch(/^chrome-error:/);
    expect(upstream.requests).toEqual([]);
  });

  it.each([
    ["window.open", "script"],
    ["a target=_blank link", "link"],
  ])(
    "closes a page opened by %s before it loads another site",
    async (_how, opener) => {
      const page = await newPage();
      const driver = await createPlaywrightDriver(page, {
        sites: [vendor.url],
      });
      await driver.navigate(`${vendor.url}/sign-in?as=runner@example.com`);
      // What a reply can put in front of the driver: a link to another site.
      await page.evaluate((target) => {
        const link = Object.assign(document.createElement("a"), {
          href: target,
          target: "_blank",
          id: "elsewhere",
          textContent: "elsewhere",
        });
        document.body.append(link);
      }, upstream.url);
      const opened = page.waitForEvent("popup");
      if (opener === "script") {
        await page.evaluate((target) => {
          window.open(target);
        }, upstream.url);
      } else {
        await driver.click("#elsewhere");
      }
      const popup = await opened;
      await expect.poll(() => popup.isClosed(), { timeout: 10_000 }).toBe(true);
      expect(page.context().pages()).toHaveLength(1);
      expect(upstream.requests).toEqual([]);
    },
  );

  it("stops a redirect off its sites before the other site gets the request", async () => {
    const page = await newPage();
    const driver = await createPlaywrightDriver(page, { sites: [vendor.url] });
    await page.goto(`${vendor.url}/sign-in?as=runner@example.com`);
    vendor.redirectTo = `${upstream.url}/`;
    await expect(driver.navigate(`${vendor.url}/redirect`)).rejects.toMatchObject({ code: "site_blocked" });
    expect(upstream.requests).toEqual([]);
    // The browser shows its own error page in place of the other site.
    await expect.poll(() => page.url()).toMatch(/^chrome-error:/);
    await driver.navigate(`${vendor.url}/new`);
    expect(await driver.url()).toBe(`${vendor.url}/new`);
  });

  it("goes blank when the page lands off its sites anyway, and acts on nothing until it navigates back", async () => {
    const page = await newPage();
    const driver = await createPlaywrightDriver(page, { sites: [vendor.url] });
    await page.goto(`${vendor.url}/sign-in?as=runner@example.com`);
    await page.goto(LANDED_WITHOUT_A_REQUEST, { waitUntil: "commit" });
    await expect.poll(() => page.url()).toBe("about:blank");
    await expect(driver.readText("body")).rejects.toMatchObject({ code: "site_blocked" });
    await driver.navigate(`${vendor.url}/new`);
    expect(await driver.url()).toBe(`${vendor.url}/new`);
  });

  it("keeps refusing when the way back fails before it lands", async () => {
    const page = await newPage();
    const driver = await createPlaywrightDriver(page, { sites: [vendor.url] });
    await page.goto(LANDED_WITHOUT_A_REQUEST, { waitUntil: "commit" });
    await expect.poll(() => page.url()).toBe("about:blank");
    // An aborted navigation never commits, so the page stays where it was.
    await page.route(`${vendor.url}/new`, (route) => route.abort("aborted"));
    await expect(driver.navigate(`${vendor.url}/new`)).rejects.toThrow(/ERR_ABORTED/);
    await expect(driver.readText("body")).rejects.toMatchObject({ code: "site_blocked" });
    await page.unroute(`${vendor.url}/new`);
    await driver.navigate(`${vendor.url}/new`);
    expect(await driver.url()).toBe(`${vendor.url}/new`);
  });

  it("refuses a page that is already on another site when it is handed over", async () => {
    const page = await newPage();
    await page.goto(upstream.url);
    const driver = await createPlaywrightDriver(page, { sites: [vendor.url] });
    await expect(driver.readText("body")).rejects.toMatchObject({
      code: "site_blocked",
    });
    await expect(
      driver.evaluate(() => document.title, undefined),
    ).rejects.toMatchObject({ code: "site_blocked" });
    await driver.navigate(`${vendor.url}/new`);
    expect(await driver.url()).toBe(`${vendor.url}/new`);
  });

  it("reports a navigation that fails on its own site as that failure, not as leaving", async () => {
    const page = await newPage();
    const driver = await createPlaywrightDriver(page, { sites: [vendor.url] });
    await page.route(`${vendor.url}/new`, (route) => route.abort("failed"));
    const failure = await driver.navigate(`${vendor.url}/new`).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toMatchObject({ code: "site_blocked" });
    // The browser's own error page isn't another site, so nothing is refused.
    await expect.poll(() => driver.url()).toMatch(/^chrome-error:/);
    await page.unroute(`${vendor.url}/new`);
    await driver.navigate(`${vendor.url}/new`);
    expect(await driver.url()).toBe(`${vendor.url}/new`);
  });

  it("tells each connector step the turn's whole selection, and sends nothing when one can't fit", async () => {
    const fixture = createFixtureWebPageModule(vendor.url);
    const kept: Array<readonly string[] | undefined> = [];
    const module: RealUiPageModule = {
      ...fixture,
      async ensureConnector(driver, connector, ctx, keep) {
        kept.push(keep);
        if (connector.name === "MCPJam billing") {
          throw new RealUiError({ kind: "plan_limit", step: "connector", message: "The plan holds one connector." });
        }
        return fixture.ensureConnector(driver, connector, ctx, keep);
      },
    };
    const failure = await driveRealUiTurn({
      module,
      driver: await signedInDriver(),
      connectors: [
        { name: "MCPJam fixture", url: upstream.url },
        { name: "MCPJam billing", url: upstream.url },
      ],
      prompt: "say hello",
      journal: createMemorySendJournal(),
      turnKey: "turn-1",
      stepTimeoutMs: 10_000,
    }).catch((error: unknown) => error);
    expect((failure as RealUiError).failure).toMatchObject({ kind: "plan_limit", step: "connector" });
    expect(kept).toEqual([
      ["MCPJam fixture", "MCPJam billing"],
      ["MCPJam fixture", "MCPJam billing"],
    ]);
    expect(vendor.sends).toEqual([]);
  });
});
