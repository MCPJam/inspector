/**
 * chatgpt.com.
 *
 * Built from the HARN-129 spike's walkthrough: custom MCP servers are added
 * from Plugins ("Add custom MCP server"), MCPJam's sign-in
 * page asks for consent with an organization choice, write tools ask the
 * person to confirm by default, and a cold sign-in in a fresh hosted browser
 * stopped at OpenAI's security check. The hosted composer and plugin controls
 * were observed in the review seat.
 *
 * ChatGPT sends no tool use id with its MCP calls, so its calls are matched
 * to the wire by time only.
 */
import {
  WEB_CLIENT_PAGE_MODULE_VERSIONS,
  WEB_CLIENT_SITES,
} from "@/shared/web-clients";
import type { PageDriver } from "./page-driver.js";
import {
  RealUiError,
  commonBlocker,
  cssString,
  needsSignIn,
  pageChanged,
  type ConversationToolCall,
  type RealUiPageModule,
  type RealUiStep,
  type SavedConversation,
  type StepContext,
} from "./page-module.js";
import { list, readVendorJson, record, text } from "./vendor-json.js";

import {
  CHATGPT_CHALLENGE as CHALLENGE, CHATGPT_COMPOSER as COMPOSER, CURRENT_COMPOSER,
  ensureChatGptPlugin, exactRole, readChatGptAccount, waitForControl as waitVisible,
} from "./chatgpt-controls.js";

const ORIGIN = "https://chatgpt.com";

const SEND = '[data-testid="send-button"]';
const STOP = 'button[aria-label="Stop generating"], [data-testid="stop-button"]';
const PLUS = '[data-testid="composer-plus-btn"]';
const USER_MESSAGE = '[data-message-author-role="user"]';
const ASSISTANT = '[data-message-author-role="assistant"]';
const CHAT_PATH = /^\/c\/([0-9a-f-]{36})$/;

const PLUGINS_PANEL = "role=dialog";
const PLAN_LIMIT =
  /you(?:'|’)ve (?:reached|hit) (?:the|your) .*(?:limit|cap)|usage cap/i;

const role = (kind: string, name: string) =>
  `role=${kind}[name="${cssString(name)}"]`;

/** ChatGPT's own API takes the session's access token, read from the page. */
async function session(driver: PageDriver): Promise<Record<string, unknown>> {
  return record(await readVendorJson(driver, `${ORIGIN}/api/auth/session`));
}

/**
 * The chat as the page shows it, for a browser that can't run a script in
 * the page (the hosted one): ChatGPT's own API takes the session's token in a
 * header, which only a script can send. The page shows no tool call times,
 * so the turn's calls come from MCPJam's record of the wire alone.
 */
async function readShownConversation(
  driver: PageDriver,
  id: string,
  ctx: StepContext,
): Promise<SavedConversation> {
  const url = `${ORIGIN}/c/${id}`;
  if ((await driver.url()) !== url) await driver.navigate(url);
  await waitVisible(driver, ASSISTANT, ctx, "the saved reply", "read_conversation");
  const userPrompt = await driver.readText(USER_MESSAGE);
  return {
    conversationId: id,
    url,
    ...(userPrompt ? { userPrompt } : {}),
    replyText: (await driver.readText(`${ASSISTANT} >> nth=-1`)) ?? "",
    toolCalls: [],
  };
}

async function openPlusMenuItem(driver: PageDriver, ctx: StepContext, item: string, step: RealUiStep) {
  await driver.click(PLUS);
  await waitVisible(driver, role("menuitem", item), ctx, `the ${item} menu item`, step);
  await driver.click(role("menuitem", item));
}

export const chatgptWebPageModule: RealUiPageModule = {
  id: "chatgpt-web",
  version: WEB_CLIENT_PAGE_MODULE_VERSIONS.chatgpt,
  sites: WEB_CLIENT_SITES.chatgpt,

  async signedIn(driver, ctx) {
    await driver.navigate(`${ORIGIN}/`);
    const blocked = await this.blocker(driver);
    if (blocked) throw new RealUiError({ ...blocked, step: "sign_in_check" });
    const url = new URL(await driver.url());
    if (url.origin !== ORIGIN || (await driver.readText('[data-testid="login-button"], a[href^="/auth/login"]')) !== undefined) {
      throw needsSignIn("signed_out", "sign_in_check", "The ChatGPT account is signed out.");
    }
    await waitVisible(driver, COMPOSER, ctx, "the chat composer", "sign_in_check");
    if (!driver.canEvaluate) return readChatGptAccount(driver, ctx);
    const current = await session(driver);
    const user = record(current.user);
    if (!text(user.email)) {
      throw needsSignIn("signed_out", "sign_in_check", "The ChatGPT account is signed out.");
    }
    return {
      email: text(user.email),
      workspace: text(record(current.account).name) ?? text(record(current.account).planType),
    };
  },

  async blocker(driver) {
    const found = await commonBlocker(driver, {
      challengeSelectors: [CHALLENGE],
      step: "reply",
    });
    if (found) return found;
    const body = (await driver.readText("main")) ?? "";
    return PLAN_LIMIT.test(body)
      ? { kind: "plan_limit", step: "reply", message: "The ChatGPT account has reached its plan's limit." }
      : undefined;
  },

  async ensureConnector(driver, connector, ctx) {
    // Plugins, then +, then "Add custom MCP server": the walkthrough's path.
    // A server already added under this name is reused, never added twice.
    await driver.navigate(`${ORIGIN}/`);
    await waitVisible(driver, COMPOSER, ctx, "the chat composer", "connector");
    if ((await driver.readText(CURRENT_COMPOSER)) !== undefined) return ensureChatGptPlugin(driver, connector, ctx);
    await openPlusMenuItem(driver, ctx, "Plugins", "connector");
    const existing = `${PLUGINS_PANEL} >> text="${cssString(connector.name)}"`;
    const add = `${PLUGINS_PANEL} >> role=button[name=/^(\\+|Add)$/]`;
    await driver.waitFor(
      async () =>
        (await driver.readText(existing)) !== undefined ||
        (await driver.readText(add)) !== undefined,
      { timeoutMs: ctx.timeoutMs, signal: ctx.signal, what: "the plugins list" },
    );
    if ((await driver.readText(existing)) !== undefined) {
      const shown = (await driver.readText(`${PLUGINS_PANEL} >> text="${cssString(connector.url)}"`)) !== undefined;
      await driver.press("Escape");
      if (shown) return;
      throw new RealUiError({
        kind: "connector_failed",
        step: "connector",
        message: `ChatGPT has a server named ${connector.name} with a different address. Remove it in ChatGPT, then run again.`,
      });
    }
    await driver.click(add);
    await waitVisible(driver, role("menuitem", "Add custom MCP server"), ctx, "the add server item", "connector");
    await driver.click(role("menuitem", "Add custom MCP server"));
    const dialog = "role=dialog";
    await waitVisible(driver, dialog, ctx, "the add server form", "connector");
    await driver.type(`${dialog} >> role=textbox[name=/name/i]`, connector.name);
    await driver.type(`${dialog} >> role=textbox[name=/url/i]`, connector.url);
    await driver.click(`${dialog} >> role=button[name=/^(Create|Add|Connect)$/]`);
    await driver.waitFor(
      async () => {
        // MCPJam's own sign-in page asks for consent: a person's step.
        const blocked = await commonBlocker(driver, { challengeSelectors: [CHALLENGE], step: "connector" });
        if (blocked) throw new RealUiError(blocked);
        return (await driver.readText(dialog)) === undefined;
      },
      { timeoutMs: ctx.timeoutMs, signal: ctx.signal, what: "ChatGPT to add the server" },
    );
  },

  async openNewChat(driver, ctx) {
    await driver.navigate(`${ORIGIN}/`);
    await waitVisible(driver, COMPOSER, ctx, "a new chat", "new_chat");
    if ((await driver.readText(USER_MESSAGE)) !== undefined) {
      throw pageChanged("new_chat", "chatgpt.com did not open an empty chat.");
    }
  },

  async enableConnector(driver, name, ctx) {
    if ((await driver.readText(CURRENT_COMPOSER)) !== undefined) {
      await driver.click(exactRole("button", "Add files and more"));
      const plugin = exactRole("button", `${name} ${name}`);
      await waitVisible(driver, plugin, ctx, "the installed plugin in the composer", "enable_connector");
      await driver.click(plugin);
      return;
    }
    const toggle = role("menuitemcheckbox", name);
    await openPlusMenuItem(driver, ctx, "More", "enable_connector");
    await waitVisible(driver, toggle, ctx, "the server in the tools menu", "enable_connector");
    if ((await driver.readText(`${toggle}[checked=true]`)) === undefined) {
      await driver.click(toggle);
    }
    await driver.press("Escape");
  },

  async send(driver, prompt, ctx) {
    await driver.type(COMPOSER, prompt);
    const current = (await driver.readText(CURRENT_COMPOSER)) !== undefined;
    await driver.click(current ? exactRole("button", "Send") : SEND);
    let conversationUrl: string | undefined;
    await driver.waitFor(
      async () => {
        const url = new URL(await driver.url());
        if (!CHAT_PATH.test(url.pathname)) return false;
        if ((await driver.readText(USER_MESSAGE)) !== prompt) return false;
        conversationUrl = `${url.origin}${url.pathname}`;
        return true;
      },
      { timeoutMs: ctx.timeoutMs, signal: ctx.signal, what: "chatgpt.com to open the chat" },
    );
    return { conversationUrl };
  },

  async findSent(driver, prompt) {
    // Without a script the chat list can't be read, so the send stays
    // ambiguous rather than being guessed.
    if (!driver.canEvaluate) return undefined;
    const token = text((await session(driver)).accessToken);
    if (!token) return undefined;
    const page = record(
      await readVendorJson(driver, `${ORIGIN}/backend-api/conversations?offset=0&limit=10`, {
        authorization: `Bearer ${token}`,
      }),
    );
    for (const item of list(page.items)) {
      const id = text(record(item).id);
      if (!id) continue;
      const saved = await this.readConversation(driver, `${ORIGIN}/c/${id}`, { timeoutMs: 15_000 });
      if (saved.userPrompt === prompt) return { conversationUrl: saved.url };
    }
    return undefined;
  },

  async answerApproval(driver) {
    for (const name of ["Always allow", "Allow", "Confirm"]) {
      const button = role("button", name);
      if ((await driver.readText(button)) !== undefined) {
        await driver.click(button);
        return true;
      }
    }
    return false;
  },

  async replySignals(driver) {
    const signals: string[] = [];
    if ((await driver.readText(STOP)) === undefined) signals.push("no stop button");
    if ((await driver.readText(ASSISTANT)) !== undefined) signals.push("an assistant message");
    if ((await driver.readText(COMPOSER)) !== undefined) signals.push("the composer is back");
    return { finished: signals.length === 3, signals };
  },

  async readConversation(driver, conversationUrl, ctx) {
    const id = CHAT_PATH.exec(new URL(conversationUrl).pathname)?.[1];
    if (!id) throw pageChanged("read_conversation", "The chat's address has no conversation id.");
    if (!driver.canEvaluate) return readShownConversation(driver, id, ctx);
    const token = text((await session(driver)).accessToken);
    if (!token) throw needsSignIn("signed_out", "read_conversation", "The ChatGPT account is signed out.");
    const saved = record(
      await readVendorJson(driver, `${ORIGIN}/backend-api/conversation/${id}`, {
        authorization: `Bearer ${token}`,
      }),
    );
    const messages = Object.values(record(saved.mapping))
      .map((node) => record(record(node).message))
      .filter((message) => Object.keys(message).length > 0)
      .sort((a, b) => Number(a.create_time ?? 0) - Number(b.create_time ?? 0));
    const textOf = (message: Record<string, unknown>) =>
      list(record(message.content).parts)
        .filter((part): part is string => typeof part === "string")
        .join("\n")
        .trim();
    const roleOf = (message: Record<string, unknown>) => text(record(message.author).role);
    const toolCalls: ConversationToolCall[] = messages
      .filter((message) => roleOf(message) === "assistant" && text(message.recipient) && message.recipient !== "all")
      .map((message) => ({
        toolName: String(message.recipient).split(".").pop() ?? String(message.recipient),
        ...(typeof message.create_time === "number"
          ? { at: new Date(message.create_time * 1000).toISOString() }
          : {}),
      }));
    const human = messages.find((message) => roleOf(message) === "user");
    const assistant = [...messages]
      .reverse()
      .find((message) => roleOf(message) === "assistant" && (!message.recipient || message.recipient === "all"));
    return {
      conversationId: id,
      url: `${ORIGIN}/c/${id}`,
      ...(human ? { userPrompt: textOf(human) } : {}),
      replyText: assistant ? textOf(assistant) : "",
      toolCalls,
    };
  },
};
