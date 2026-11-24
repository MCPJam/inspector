/**
 * Every selector the claude.ai and chatgpt.com modules hand a driver parses
 * in Playwright's selector engine. One that doesn't throws before the page is
 * touched, so the run would stop as a `driver` failure on that step.
 *
 * Evidence: fixture. The modules run against a driver that records each
 * selector instead of looking for it, along paths that reach every control
 * they use; a blank page in a real browser then counts each recorded one.
 * Their approval answers also run in a real page, to show the dialog they
 * look in is the run's connector's and no other.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { chatgptWebPageModule } from "../chatgpt-web";
import { claudeWebPageModule } from "../claude-web";
import type { PageDriver } from "../page-driver";
import { createPlaywrightDriver } from "../playwright-driver";

const CONNECTOR = { name: "MCPJam fixture 0a1b2c3d", url: "https://mcp.example.com/mcp/connector-1" };
const PROMPT = "say hello";
const CTX = { timeoutMs: 1_000 };

/** What the page shows for `selector`, given how many times it was read before. */
type Shown = (selector: string, reads: number) => string | undefined;

/**
 * Records every selector it is handed and answers reads from `shown`. A wait
 * checks its condition once and goes on, so a flow reaches each control it
 * would use without the page having to change under it.
 */
function recordingDriver(options: {
  url: string;
  shown: Shown;
  json: Record<string, unknown>;
}): PageDriver & { selectors: Set<string> } {
  let url = options.url;
  const selectors = new Set<string>();
  const reads = new Map<string, number>();
  return {
    selectors,
    kind: "playwright",
    canEvaluate: true,
    playwrightSelectors: true,
    async navigate(next) {
      url = next;
    },
    async url() {
      return url;
    },
    // The modules evaluate only to read the vendor's own JSON API.
    async evaluate<T, A>(_fn: (arg: A) => T | Promise<T>, arg: A): Promise<T> {
      const path = new URL((arg as { url: string }).url).pathname;
      const body = Object.entries(options.json).find(([prefix]) => path.startsWith(prefix))?.[1];
      return { status: 200, text: JSON.stringify(body ?? {}) } as T;
    },
    async waitFor(condition) {
      await condition();
    },
    async click(selector) {
      selectors.add(selector);
    },
    async type(selector) {
      selectors.add(selector);
    },
    async press(_key, selector) {
      if (selector) selectors.add(selector);
    },
    async readText(selector) {
      selectors.add(selector);
      const count = reads.get(selector) ?? 0;
      reads.set(selector, count + 1);
      return options.shown(selector, count);
    },
  };
}

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});

/** Each selector Playwright's engine rejects, with the first line of its error. */
async function unparsed(selectors: Iterable<string>): Promise<string[]> {
  const page = await browser.newPage();
  const rejected: string[] = [];
  for (const selector of selectors) {
    try {
      // A blank page matches nothing, so only a selector that doesn't parse throws.
      await page.locator(selector).count();
    } catch (error) {
      rejected.push(`${selector}: ${String(error).split("\n")[0]}`);
    }
  }
  await page.close();
  return rejected;
}

describe("vendor page module selectors", { timeout: 60_000 }, () => {
  it("claude.ai: every selector from sign-in to the reply parses", async () => {
    // The connector is listed but not connected, so it is removed; adding it
    // then meets the plan's limit (read while waiting and again to check it)
    // until the other MCPJam connector, on the run's endpoint, goes too.
    const driver = recordingDriver({
      url: "https://claude.ai/new",
      json: {
        "/api/account": { email_address: "runner@example.com" },
        "/api/organizations": [{ uuid: "org-1", name: "Team", capabilities: ["chat"] }],
      },
      shown: (selector, reads) => {
        if (selector === "role=dialog") {
          return reads <= 1 ? "Upgrade to add more connectors" : "Add custom connector";
        }
        if (selector.includes("name=/^View")) return "View MCPJam other 1a2b3c4d";
        if (selector.includes(`View ${CONNECTOR.name}`)) {
          return reads === 0 ? `View ${CONNECTOR.name}` : undefined;
        }
        if (selector.includes("Disconnect") || selector.includes("[checked=true]")) {
          return reads === 0 ? undefined : "on";
        }
        if (selector.includes('name="Add"]')) return "Add";
        if (selector === ".dframe-pane-primary") return `Connected ${CONNECTOR.url}`;
        if (selector === '[data-testid="chat-input"]') return PROMPT;
        return undefined;
      },
    });
    const claude = claudeWebPageModule;
    await claude.signedIn(driver, CTX);
    await claude.ensureConnector(driver, CONNECTOR, CTX);
    await claude.openNewChat(driver, CTX);
    await claude.enableConnector(driver, CONNECTOR.name, CTX);
    await claude.send(driver, PROMPT, CTX);
    await claude.answerApproval(driver, [CONNECTOR.name]);
    await claude.replySignals(driver);
    expect(await unparsed(driver.selectors)).toEqual([]);
  });

  it("chatgpt.com: every selector from sign-in to the reply parses", async () => {
    const json = {
      "/api/auth/session": { accessToken: "token", user: { email: "runner@example.com" } },
    };
    // A server ChatGPT doesn't list yet is added; one it lists is reused.
    const fresh = recordingDriver({ url: "https://chatgpt.com/", json, shown: () => undefined });
    const listed = recordingDriver({
      url: "https://chatgpt.com/",
      json,
      shown: (selector) =>
        selector.includes(CONNECTOR.name) || selector.includes(CONNECTOR.url)
          ? CONNECTOR.name
          : undefined,
    });
    const chatgpt = chatgptWebPageModule;
    await chatgpt.signedIn(fresh, CTX);
    await chatgpt.ensureConnector(fresh, CONNECTOR, CTX);
    await chatgpt.ensureConnector(listed, CONNECTOR, CTX);
    await chatgpt.openNewChat(fresh, CTX);
    await chatgpt.enableConnector(fresh, CONNECTOR.name, CTX);
    await chatgpt.send(fresh, PROMPT, CTX);
    await chatgpt.answerApproval(fresh, [CONNECTOR.name]);
    await chatgpt.replySignals(fresh);
    expect(await unparsed([...fresh.selectors, ...listed.selectors])).toEqual([]);
  });
});

describe("vendor approval prompts in a real page", { timeout: 60_000 }, () => {
  /** A dialog asking to approve a tool from `connector`; a click on an answer titles the page with it. */
  const prompt = (connector: string, answers: string[]) =>
    `<div role="dialog"><p>Allow echo from ${connector}?</p>${answers
      .map((answer) => `<button onclick="document.title = this.textContent">${answer}</button>`)
      .join("")}</div>`;

  it("answers the dialog that names the run's connector, and no other", async () => {
    const page = await browser.newPage();
    const driver = await createPlaywrightDriver(page, { sites: ["https://claude.ai", "https://chatgpt.com"] });
    for (const [module, answers] of [
      [claudeWebPageModule, ["Always allow", "Allow once"]],
      [chatgptWebPageModule, ["Confirm"]],
    ] as const) {
      await page.setContent(prompt("Team Drive", [...answers]));
      await expect(module.answerApproval(driver, [CONNECTOR.name])).rejects.toMatchObject({
        failure: { kind: "connector_failed", step: "reply" },
      });
      expect(await page.title()).toBe("");
      await page.setContent(prompt(CONNECTOR.name, [...answers]));
      expect(await module.answerApproval(driver, [CONNECTOR.name])).toBe(true);
      expect(await page.title()).toBe(answers[0]);
    }
    await page.close();
  });
});
