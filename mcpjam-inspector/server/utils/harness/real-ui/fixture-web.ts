/**
 * The page module for the fixture vendor (`server/test/support/web-clients/
 * fixture-vendor.ts`): the same contract as the claude.ai and chatgpt.com
 * modules, on a site whose selectors never change, so the turn's order, the
 * send journal, the approval answer and the typed failures can be tested with
 * a real browser and no vendor account.
 */
import type { PageDriver } from "./page-driver.js";
import {
  RealUiError,
  commonBlocker,
  cssString,
  needsSignIn,
  pageChanged,
  type RealUiPageModule,
  type StepContext,
} from "./page-module.js";
import { list, readVendorJson, record, text } from "./vendor-json.js";

export const FIXTURE_PAGE_MODULE_VERSION = "fixture-1";

/** Text as a page renders it: trimmed, with each run of whitespace as one space. */
const collapse = (value: string) => value.replace(/\s+/g, " ").trim();

export function createFixtureWebPageModule(baseUrl: string): RealUiPageModule {
  const origin = new URL(baseUrl).origin;
  const visible = async (driver: PageDriver, selector: string, ctx: StepContext, what: string) =>
    driver.waitFor(async () => (await driver.readText(selector)) !== undefined, {
      timeoutMs: ctx.timeoutMs,
      signal: ctx.signal,
      what,
    });
  const row = (name: string) => `[data-testid="connector-row"][data-name="${cssString(name)}"]`;
  const toggle = (name: string) =>
    `[data-testid="connector-toggle"][data-name="${cssString(name)}"]`;

  return {
    id: "fixture-web",
    version: FIXTURE_PAGE_MODULE_VERSION,
    sites: [origin],

    async signedIn(driver, ctx) {
      await driver.navigate(`${origin}/new`);
      const blocked = await this.blocker(driver);
      if (blocked?.kind === "needs_sign_in" && blocked.reason === "password") {
        throw needsSignIn("signed_out", "sign_in_check", "The fixture account is signed out.");
      }
      if (blocked) throw new RealUiError({ ...blocked, step: "sign_in_check" });
      await visible(driver, '[data-testid="composer"]', ctx, "the composer");
      const me = record(await readVendorJson(driver, `${origin}/api/me`));
      return { email: text(me.email), workspace: text(me.workspace) };
    },

    async blocker(driver) {
      return commonBlocker(driver, { challengeSelectors: [], step: "reply" });
    },

    async ensureConnector(driver, connector, ctx) {
      await driver.navigate(`${origin}/connectors`);
      // A human check that shows up after sign-in takes the list's place:
      // a person's to answer, not a page that changed.
      await driver.waitFor(
        async () => {
          const add = await driver.readText('[data-testid="connector-add"]');
          if (add !== undefined) return true;
          const blocked = await this.blocker(driver);
          if (blocked) throw new RealUiError({ ...blocked, step: "connector" });
          return false;
        },
        {
          timeoutMs: ctx.timeoutMs,
          signal: ctx.signal,
          what: "the connector list",
        },
      );
      const shown = await driver.readText(row(connector.name));
      if (shown !== undefined) {
        // The row's own URL, exactly: `/mcp` must not keep `/mcp-old`.
        const same = `${row(connector.name)}[data-url="${cssString(connector.url)}"]`;
        if ((await driver.readText(same)) !== undefined) return;
        await driver.click(`${row(connector.name)} [data-testid="connector-remove"]`);
        await driver.waitFor(async () => (await driver.readText(row(connector.name))) === undefined, {
          timeoutMs: ctx.timeoutMs,
          signal: ctx.signal,
          what: "the old connector to go",
        });
      }
      await driver.type('[data-testid="connector-name"]', connector.name);
      await driver.type('[data-testid="connector-url"]', connector.url);
      await driver.click('[data-testid="connector-add"]');
      await visible(driver, row(connector.name), ctx, "the new connector");
    },

    async openNewChat(driver, ctx) {
      await driver.navigate(`${origin}/new`);
      await visible(driver, '[data-testid="composer"]', ctx, "a new chat");
    },

    async enableConnector(driver, name, ctx) {
      await visible(driver, toggle(name), ctx, "the connector toggle");
      if ((await driver.readText(`${toggle(name)}[aria-checked="true"]`)) === undefined) {
        await driver.click(toggle(name));
      }
      if ((await driver.readText(`${toggle(name)}[aria-checked="true"]`)) === undefined) {
        throw pageChanged("enable_connector", "The connector did not switch on.");
      }
    },

    async send(driver, prompt, ctx) {
      await driver.type('[data-testid="composer"]', prompt);
      await driver.click('[data-testid="send"]');
      let conversationUrl: string | undefined;
      await driver.waitFor(
        async () => {
          const url = new URL(await driver.url());
          if (!url.pathname.startsWith("/chat/")) return false;
          // The page shows the prompt as rendered text, trimmed and with runs
          // of spaces collapsed; the send happened all the same.
          const shown = await driver.readText('[data-testid="user-message"]');
          if (shown === undefined || collapse(shown) !== collapse(prompt)) return false;
          conversationUrl = `${url.origin}${url.pathname}`;
          return true;
        },
        { timeoutMs: ctx.timeoutMs, signal: ctx.signal, what: "the chat to open" },
      );
      return { conversationUrl };
    },

    async findSent(driver, prompt, _ctx, since) {
      for (const chat of list(await readVendorJson(driver, `${origin}/api/chats`))) {
        const id = text(record(chat).id);
        const created = Date.parse(text(record(chat).createdAt) ?? "");
        if (!id || !(created >= Date.parse(since))) continue;
        const saved = await this.readConversation(driver, `${origin}/chat/${id}`, {
          timeoutMs: 5_000,
        });
        if (saved.userPrompt === prompt) return { conversationUrl: saved.url };
      }
      return undefined;
    },

    async answerApproval(driver) {
      const always = '[data-testid="approval"]:not([hidden]) [data-testid="approve-always"]';
      if ((await driver.readText(always)) === undefined) return false;
      await driver.click(always);
      return true;
    },

    async replySignals(driver) {
      const signals: string[] = [];
      if ((await driver.readText('[data-testid="reply-status"][data-state="done"]')) !== undefined)
        signals.push("status done");
      if ((await driver.readText('[data-testid="approval"][hidden]')) !== undefined)
        signals.push("no approval waiting");
      if (((await driver.readText('[data-testid="assistant-message"]')) ?? "") !== "")
        signals.push("an assistant message");
      return { finished: signals.length === 3, signals };
    },

    async readConversation(driver, conversationUrl) {
      const id = new URL(conversationUrl).pathname.split("/").pop() ?? "";
      const saved = record(await readVendorJson(driver, `${origin}/api/chats/${id}`));
      const messages = list(saved.messages).map(record);
      return {
        conversationId: id,
        url: `${origin}/chat/${id}`,
        ...(messages[0] ? { userPrompt: text(messages[0].text) } : {}),
        replyText: text(messages.find((m) => m.role === "assistant")?.text) ?? "",
        toolCalls: list(saved.toolCalls).map(record).map((call) => ({
          toolName: text(call.name) ?? "unknown",
          ...(text(call.toolUseId) ? { toolUseId: text(call.toolUseId) } : {}),
          ...(text(call.at) ? { at: text(call.at) } : {}),
        })),
      };
    },
  };
}
