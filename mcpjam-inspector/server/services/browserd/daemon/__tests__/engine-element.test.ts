/**
 * Finding one element with Playwright's own selector engine, in a real
 * browser: what an observation scoped by `role=`, `text=`, `>>` or `nth=`
 * relies on. A fake can't show that the one-off mark reaches the page, that
 * CDP finds the element by it, or that the mark comes off again.
 *
 * Evidence: fixture page in a real Chromium, no daemon.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { resolveBackendNodeId } from "../cdp-a11y";
import { elementNodeId, elementText } from "../engine-element";
import type { CdpLike } from "../webmcp-bridge";

const PAGE = `<main>
  <div role="dialog" aria-label="Add server"><p>Step 2 of 2</p><button>Add</button></div>
  <div data-message-author-role="assistant">Calling echo</div>
  <div data-message-author-role="assistant"><p>It said <b>"hello"</b>.</p></div>
</main>`;
const LAST_REPLY = '[data-message-author-role="assistant"] >> nth=-1';

let browser: Browser;
let page: Page;
let cdp: CdpLike;
const locate = (selector: string) => page.locator(selector);

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  page = await context.newPage();
  await page.setContent(PAGE);
  const session = await context.newCDPSession(page);
  cdp = {
    send: (method, params) => session.send(method as never, params as never),
    on: () => undefined,
  };
});
afterAll(async () => {
  await browser.close();
});

describe("one element by Playwright's selector engine", { timeout: 60_000 }, () => {
  it("reads the element's innerText, or null when nothing matches", async () => {
    expect(await elementText(locate, LAST_REPLY)).toBe('It said "hello".');
    expect(await elementText(locate, 'role=dialog >> text="Step 2 of 2"')).toBe("Step 2 of 2");
    expect(await elementText(locate, 'role=dialog >> text="Step 3 of 3"')).toBeNull();
  });

  it("throws for a selector Playwright can't parse, rather than reading it as absent", async () => {
    await expect(elementText(locate, 'main role=button[name="Add"]')).rejects.toThrow(
      /Unexpected token/,
    );
  });

  it("finds the node CDP finds for the same element, and leaves no mark behind", async () => {
    const byCss = await resolveBackendNodeId(cdp, "main > div:last-of-type");
    expect(byCss).not.toBeNull();
    expect(await elementNodeId(locate, cdp, LAST_REPLY)).toBe(byCss);
    expect(await elementNodeId(locate, cdp, 'role=dialog[name="Add server"]')).toBe(
      await resolveBackendNodeId(cdp, '[role="dialog"]'),
    );
    expect(await elementNodeId(locate, cdp, "role=alertdialog")).toBeNull();
    expect(await page.locator("[data-mcpjam-element]").count()).toBe(0);
  });
});
