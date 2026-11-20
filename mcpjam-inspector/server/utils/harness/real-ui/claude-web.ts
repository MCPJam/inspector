/**
 * claude.ai.
 *
 * Selectors and flows were read off claude.ai while building the directory
 * reviewer's live browser and the HARN-129 spike; the site changes without
 * notice, so a missing control is a `page_changed` failure of the run, and
 * `WEB_CLIENT_PAGE_MODULE_VERSIONS.claude` dates the last check.
 *
 * What the spike showed and this module keeps to: a broken connector needs
 * remove and add (Reconnect only sends `initialize` again); the Free plan
 * allows one custom connector; a fresh browser can meet Cloudflare's human
 * check, which MCPJam never answers.
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
  waitVisibleUnlessBlocked,
  type ConversationToolCall,
  type RealUiPageModule,
  type RealUiStep,
  type StepContext,
} from "./page-module.js";
import { list, readVendorJson, record, text } from "./vendor-json.js";

const ORIGIN = "https://claude.ai";
const PANE = ".dframe-pane-primary";
const COMPOSER = '[data-testid="chat-input"]';
const SEND = '[data-testid="chat-input-send"]';
const CHALLENGE = 'iframe[src*="challenges.cloudflare.com"]';
const USER_MESSAGE = `${PANE} [data-testid="user-message"]`;
const ASSISTANT = `${PANE} [data-is-streaming]`;
const STREAMING = `${PANE} [data-is-streaming="true"]`;
const STOP = 'button[aria-label="Stop response"], button[aria-label="Stop"]';
const CHAT_PATH = /^\/chat\/([0-9a-f-]{36})$/;
const CONNECTORS = `${ORIGIN}/customize/connectors/yours`;
const PLAN_LIMIT =
  /you(?:'|’)ve (?:reached|hit) your (?:usage )?limit|out of free messages|upgrade to (?:add|connect) more/i;
/** MCPJam names its own connectors so it never removes one a person added. */
export const MCPJAM_CONNECTOR_PREFIX = "MCPJam";

/** Playwright's own role engine, not CSS: scope one with `>>`, never a space. */
const role = (kind: string, name: string) =>
  `role=${kind}[name="${cssString(name)}"]`;

async function onSite(driver: PageDriver): Promise<URL> {
  return new URL(await driver.url());
}

const waitVisible = (driver: PageDriver, selector: string, ctx: StepContext, what: string, step: RealUiStep) =>
  waitVisibleUnlessBlocked(driver, selector, ctx, { what, step, challengeSelectors: [CHALLENGE] });

async function organizationId(driver: PageDriver): Promise<string> {
  const orgs = list(await readVendorJson(driver, `${ORIGIN}/api/organizations`));
  const chat = orgs.find((org) =>
    list(record(org).capabilities).includes("chat"),
  );
  const id = text(record(chat ?? orgs[0]).uuid);
  if (!id) throw pageChanged("read_conversation", "claude.ai named no organization for this account.");
  return id;
}

async function connectorRowVisible(driver: PageDriver, name: string) {
  return (await driver.readText(`${PANE} >> ${role("button", `View ${name}`)}`)) !== undefined;
}

async function removeConnector(driver: PageDriver, name: string, ctx: StepContext) {
  await driver.click(`${PANE} >> ${role("button", `More options for ${name}`)}`);
  await driver.click("role=menuitem[name=/^(Remove|Delete)/]");
  await driver.click("role=dialog >> role=button[name=/^(Remove|Delete)$/]");
  await driver.waitFor(async () => !(await connectorRowVisible(driver, name)), {
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
    what: "the connector to be removed",
  });
}

async function addConnector(
  driver: PageDriver,
  connector: { name: string; url: string },
  ctx: StepContext,
): Promise<void> {
  await driver.click(`${PANE} >> ${role("button", "Add connector")}`);
  await driver.click(role("menuitem", "Add custom connector"));
  const dialog = "role=dialog";
  const body = (await driver.readText(dialog)) ?? "";
  if (PLAN_LIMIT.test(body) || /upgrade/i.test(body)) {
    throw new RealUiError({
      kind: "plan_limit",
      step: "connector",
      message: "This Claude plan allows no more custom connectors. Remove one in claude.ai or use a paid plan.",
    });
  }
  await driver.type(`${dialog} >> [placeholder="Name"]`, connector.name);
  await driver.type(`${dialog} >> [placeholder="MCP server URL"]`, connector.url);
  await driver.click(`${dialog} >> ${role("button", "Continue")}`);
  await waitVisible(driver, `${dialog} >> text=Step 2 of 2`, ctx, "the connector's second step", "connector");
  if ((await driver.readText(`${dialog} >> ${role("button", "Add")}`)) === undefined) {
    // No Add without authorization: someone has to approve MCPJam's sign-in.
    throw needsSignIn("consent", "connector", "Adding the connector needs someone to approve access.");
  }
  await driver.click(`${dialog} >> ${role("button", "Add")}`);
}

/** The connector page shows `url`, directly or in its details. */
async function pointsAt(driver: PageDriver, url: string): Promise<boolean> {
  const pane = (await driver.readText(PANE)) ?? "";
  return pane.split(/\s+/).some((word) => word === url);
}

export const claudeWebPageModule: RealUiPageModule = {
  id: "claude-web",
  version: WEB_CLIENT_PAGE_MODULE_VERSIONS.claude,
  sites: WEB_CLIENT_SITES.claude,

  async signedIn(driver, ctx) {
    await driver.navigate(`${ORIGIN}/new`);
    const blocked = await this.blocker(driver);
    if (blocked) throw new RealUiError({ ...blocked, step: "sign_in_check" });
    const url = await onSite(driver);
    if (url.origin !== ORIGIN || /^\/(login|logout|oauth|auth)\b/.test(url.pathname)) {
      throw needsSignIn("signed_out", "sign_in_check", "The Claude account is signed out.");
    }
    await waitVisible(driver, COMPOSER, ctx, "the chat composer", "sign_in_check");
    const account = record(await readVendorJson(driver, `${ORIGIN}/api/account`));
    const orgs = list(await readVendorJson(driver, `${ORIGIN}/api/organizations`));
    return {
      email: text(account.email_address),
      workspace: text(record(orgs[0]).name),
    };
  },

  async blocker(driver) {
    const found = await commonBlocker(driver, {
      challengeSelectors: [CHALLENGE],
      step: "reply",
    });
    if (found) return found;
    const pane = (await driver.readText(PANE)) ?? "";
    return PLAN_LIMIT.test(pane)
      ? { kind: "plan_limit", step: "reply", message: "The Claude account has reached its plan's limit." }
      : undefined;
  },

  async ensureConnector(driver, connector, ctx, keep = []) {
    await driver.navigate(CONNECTORS);
    await waitVisible(driver, `${PANE} [placeholder="Search"]`, ctx, "the connector list", "connector");
    await driver.type(`${PANE} [placeholder="Search"]`, connector.name);
    if (await connectorRowVisible(driver, connector.name)) {
      await driver.click(`${PANE} >> ${role("button", `View ${connector.name}`)}`);
      const connected =
        (await driver.readText(`${PANE} >> ${role("button", "Disconnect")}`)) !== undefined;
      if (connected && (await pointsAt(driver, connector.url))) return;
      // Never Reconnect: it only sends `initialize` again, so a connector
      // that broke stays broken. Remove it and add it fresh.
      await driver.navigate(CONNECTORS);
      await driver.type(`${PANE} [placeholder="Search"]`, connector.name);
      await removeConnector(driver, connector.name, ctx);
    }
    try {
      await addConnector(driver, connector, ctx);
    } catch (error) {
      if (!(error instanceof RealUiError) || error.failure.kind !== "plan_limit") throw error;
      // Free allows one custom connector. Only one MCPJam added may make room.
      await driver.navigate(CONNECTORS);
      await driver.type(`${PANE} [placeholder="Search"]`, MCPJAM_CONNECTOR_PREFIX);
      const other = await driver.readText(`${PANE} >> role=button[name=/^View ${MCPJAM_CONNECTOR_PREFIX}/]`);
      const otherName = other?.replace(/^View\s+/, "").trim();
      if (!otherName || otherName === connector.name) throw error;
      // The turn's own: removing it would break the turn, so it can't fit here.
      if (keep.includes(otherName)) {
        throw new RealUiError({
          kind: "plan_limit",
          step: "connector",
          message: "This Claude plan can't hold a connector for each server this run uses. Select fewer servers or use a paid plan.",
        });
      }
      await removeConnector(driver, otherName, ctx);
      await driver.navigate(CONNECTORS);
      await addConnector(driver, connector, ctx);
    }
    await waitVisible(driver, `${PANE} >> ${role("button", "Disconnect")}`, ctx, "the connector to connect", "connector");
    if (!(await pointsAt(driver, connector.url))) {
      throw new RealUiError({
        kind: "connector_failed",
        step: "connector",
        message: "claude.ai shows a different address for this connector.",
      });
    }
  },

  async openNewChat(driver, ctx) {
    await driver.navigate(`${ORIGIN}/new`);
    await waitVisible(driver, COMPOSER, ctx, "a new chat", "new_chat");
    if ((await driver.readText(USER_MESSAGE)) !== undefined) {
      throw pageChanged("new_chat", "claude.ai did not open an empty chat.");
    }
  },

  async enableConnector(driver, name, ctx) {
    const toggle = `role=menuitemcheckbox[name="${cssString(name)}"]`;
    await driver.click('[data-testid="chat-input-attach"]');
    await driver.press("ArrowRight", '[data-testid="add-menu-connectors"]');
    await waitVisible(driver, toggle, ctx, "the connector in the chat menu", "enable_connector");
    if ((await driver.readText(`${toggle}[checked=true]`)) === undefined) {
      await driver.click(toggle);
    }
    if ((await driver.readText(`${toggle}[checked=true]`)) === undefined) {
      throw pageChanged("enable_connector", "The connector did not switch on for this chat.");
    }
    await driver.press("Escape");
    await driver.press("Escape");
  },

  async send(driver, prompt, ctx) {
    await driver.type(COMPOSER, prompt);
    if ((await driver.readText(COMPOSER)) !== prompt) {
      throw pageChanged("send", "The composer did not take the exact prompt; nothing was sent.");
    }
    await driver.click(SEND);
    let conversationUrl: string | undefined;
    await driver.waitFor(
      async () => {
        const url = await onSite(driver);
        if (!CHAT_PATH.test(url.pathname)) return false;
        if ((await driver.readText(USER_MESSAGE)) !== prompt) return false;
        conversationUrl = `${url.origin}${url.pathname}`;
        return true;
      },
      { timeoutMs: ctx.timeoutMs, signal: ctx.signal, what: "claude.ai to open the chat" },
    );
    return { conversationUrl };
  },

  async findSent(driver, prompt) {
    // The newest chats are listed first; the prompt's own chat is the one
    // whose first message is exactly this prompt.
    const org = await organizationId(driver);
    const chats = list(
      await readVendorJson(
        driver,
        `${ORIGIN}/api/organizations/${org}/chat_conversations?limit=10`,
      ),
    );
    for (const chat of chats) {
      const id = text(record(chat).uuid);
      if (!id) continue;
      const saved = await this.readConversation(driver, `${ORIGIN}/chat/${id}`, {
        timeoutMs: 15_000,
      });
      if (saved.userPrompt === prompt) return { conversationUrl: saved.url };
    }
    return undefined;
  },

  async answerApproval(driver) {
    for (const name of ["Always allow", "Allow once", "Allow"]) {
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
    if ((await driver.readText(STREAMING)) === undefined) signals.push("nothing streaming");
    if ((await driver.readText(ASSISTANT)) !== undefined) signals.push("an assistant message");
    if ((await driver.readText(COMPOSER)) !== undefined) signals.push("the composer is back");
    return { finished: signals.length === 4, signals };
  },

  async readConversation(driver, conversationUrl) {
    const id = CHAT_PATH.exec(new URL(conversationUrl).pathname)?.[1];
    if (!id) throw pageChanged("read_conversation", "The chat's address has no conversation id.");
    const org = await organizationId(driver);
    const saved = record(
      await readVendorJson(
        driver,
        `${ORIGIN}/api/organizations/${org}/chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true`,
      ),
    );
    const messages = list(saved.chat_messages).map(record);
    const textOf = (message: Record<string, unknown>) =>
      list(message.content)
        .map(record)
        .filter((part) => part.type === "text")
        .map((part) => text(part.text) ?? "")
        .join("\n")
        .trim() || (text(message.text) ?? "");
    const toolCalls: ConversationToolCall[] = messages.flatMap((message) =>
      list(message.content)
        .map(record)
        .filter((part) => part.type === "tool_use")
        .map((part) => ({
          toolName: text(part.name) ?? "unknown",
          ...(text(part.id) ? { toolUseId: text(part.id) } : {}),
          ...(text(part.start_timestamp) ?? text(message.created_at)
            ? { at: text(part.start_timestamp) ?? text(message.created_at) }
            : {}),
        })),
    );
    const human = messages.find((message) => message.sender === "human");
    const assistant = [...messages].reverse().find((m) => m.sender === "assistant");
    return {
      conversationId: id,
      url: `${ORIGIN}/chat/${id}`,
      ...(human ? { userPrompt: textOf(human) } : {}),
      replyText: assistant ? textOf(assistant) : "",
      toolCalls,
    };
  },
};
