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
  WEB_CONNECTOR_PATH_PREFIX,
} from "@/shared/web-clients";
import { logger } from "../../logger.js";
import type { PageDriver } from "./page-driver.js";
import {
  RealUiError,
  answerRunApproval,
  commonBlocker,
  cssString,
  needsSignIn,
  pageChanged,
  requirePlaywrightSelectors,
  waitVisibleUnlessBlocked,
  type ConversationToolCall,
  type RealUiPageModule,
  type RealUiStep,
  type StepContext,
} from "./page-module.js";
import {
  VendorStatusError,
  VendorTextCutOffError,
  createdSince,
  leadingJsonString,
  list,
  readShownVendorText,
  readVendorJson,
  record,
  text,
} from "./vendor-json.js";

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
/**
 * MCPJam names its own connectors "MCPJam <label> <8 hex digits>", a name a
 * person calling theirs after MCPJam ("MCPJam", "MCPJam server") doesn't
 * reach, and adds none under any other. A name alone never makes a connector
 * MCPJam's to remove: its address must be this run's forwarding endpoint too.
 */
export const MCPJAM_CONNECTOR_PREFIX = "MCPJam";
const MCPJAM_NAME = `${MCPJAM_CONNECTOR_PREFIX} (?:.+ )?[0-9a-f]{8}`;
const isMcpjamName = (name: string) => new RegExp(`^${MCPJAM_NAME}$`).test(name);

/** Playwright's own role engine, not CSS: scope one with `>>`, never a space. */
const role = (kind: string, name: string) =>
  `role=${kind}[name="${cssString(name)}"]`;

async function onSite(driver: PageDriver): Promise<URL> {
  return new URL(await driver.url());
}

const waitVisible = (driver: PageDriver, selector: string, ctx: StepContext, what: string, step: RealUiStep) =>
  waitVisibleUnlessBlocked(driver, selector, ctx, { what, step, challengeSelectors: [CHALLENGE] });

/** The organization the account's chats are kept in: the first that can chat. */
async function chatOrganization(driver: PageDriver): Promise<Record<string, unknown>> {
  const orgs = list(await readVendorJson(driver, `${ORIGIN}/api/organizations`)).map(record);
  return orgs.find((org) => list(org.capabilities).includes("chat")) ?? orgs[0] ?? {};
}

async function chatOrganizationName(driver: PageDriver): Promise<string | undefined> {
  try {
    return text((await chatOrganization(driver)).name);
  } catch (error) {
    if (!(error instanceof VendorTextCutOffError)) throw error;
    logger.debug("[real-ui] claude.ai's organization list was too long to read; saving without a workspace");
    return undefined;
  }
}

async function organizationId(driver: PageDriver): Promise<string> {
  const id = text((await chatOrganization(driver)).uuid);
  if (!id) throw pageChanged("read_conversation", "claude.ai named no organization for this account.");
  return id;
}

/** The signed-in account's email. An error answer names none, on either driver. */
async function accountEmail(driver: PageDriver): Promise<string | undefined> {
  // `/api/account` lists every membership, often past the hosted browser's
  // text cap, so that browser takes the email from the answer's start (it
  // comes first) instead of parsing all of it. A sign-in page names none.
  if (!driver.canEvaluate) {
    return leadingJsonString(await readShownVendorText(driver, `${ORIGIN}/api/account`), "email_address");
  }
  try {
    return text(record(await readVendorJson(driver, `${ORIGIN}/api/account`)).email_address);
  } catch (error) {
    if (error instanceof VendorStatusError) return undefined;
    throw error;
  }
}

async function connectorRowVisible(driver: PageDriver, name: string) {
  return (await driver.readText(`${PANE} >> ${role("button", `View ${name}`)}`)) !== undefined;
}

/** `url` is an MCPJam forwarding endpoint on `origin`: `/mcp/<connectorId>` there. */
function isForwardingEndpoint(url: string, origin: string): boolean {
  const prefix = `${origin}${WEB_CONNECTOR_PATH_PREFIX}/`;
  return url.startsWith(prefix) && /^[^/?#]+$/.test(url.slice(prefix.length));
}

/**
 * Removes the connector named `name`, and answers true, only when MCPJam
 * provably added it: the name is MCPJam's, and its page shows an MCPJam
 * forwarding endpoint on the run's own origin as its address.
 */
async function removeOwnConnector(driver: PageDriver, name: string, origin: string, ctx: StepContext): Promise<boolean> {
  if (!isMcpjamName(name)) return false;
  await driver.navigate(CONNECTORS);
  await driver.type(`${PANE} [placeholder="Search"]`, name);
  await driver.click(`${PANE} >> ${role("button", `View ${name}`)}`);
  const pane = (await driver.readText(PANE)) ?? "";
  if (!pane.split(/\s+/).some((word) => isForwardingEndpoint(word, origin))) return false;
  await driver.navigate(CONNECTORS);
  await driver.type(`${PANE} [placeholder="Search"]`, name);
  await driver.click(`${PANE} >> ${role("button", `More options for ${name}`)}`);
  await driver.click("role=menuitem[name=/^(Remove|Delete)/]");
  await driver.click("role=dialog >> role=button[name=/^(Remove|Delete)$/]");
  await driver.waitFor(async () => !(await connectorRowVisible(driver, name)), {
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
    what: "the connector to be removed",
  });
  return true;
}

async function addConnector(
  driver: PageDriver,
  connector: { name: string; url: string },
  ctx: StepContext,
): Promise<void> {
  await driver.click(`${PANE} >> ${role("button", "Add connector")}`);
  await driver.click(role("menuitem", "Add custom connector"));
  const dialog = "role=dialog";
  // The form, or a plan wall in its place. Another mention of upgrading is
  // no wall: a plan wall here lets ensureConnector remove a connector.
  await waitVisible(driver, dialog, ctx, "the add connector form", "connector");
  if (PLAN_LIMIT.test((await driver.readText(dialog)) ?? "")) {
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
    const email = await accountEmail(driver);
    if (!email) throw needsSignIn("signed_out", "sign_in_check", "The Claude account is signed out.");
    // The organization whose chats the turn reads, not merely the first. The
    // name is optional: a list too long for the hosted browser's text read
    // still leaves the account identified.
    return { email, workspace: await chatOrganizationName(driver) };
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
    requirePlaywrightSelectors(driver, "connector", "claude.ai");
    // The chat's connector menu opens with a key pressed on it. A browser
    // that can't do that is refused here, before any connector on the
    // account changes, not at the menu after.
    if (driver.pressesOnElement === false) {
      throw new RealUiError({
        kind: "driver",
        step: "connector",
        message: "MCPJam can't use claude.ai in the hosted browser yet. Run this client from the local app.",
      });
    }
    const origin = URL.canParse(connector.url) ? new URL(connector.url).origin : "";
    if (!origin || !isMcpjamName(connector.name) || !isForwardingEndpoint(connector.url, origin)) {
      throw new RealUiError({
        kind: "connector_failed",
        step: "connector",
        message: "MCPJam adds only its own connectors to claude.ai, under its name and at its forwarding endpoint.",
      });
    }
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
      if (!(await removeOwnConnector(driver, connector.name, origin, ctx))) {
        throw new RealUiError({
          kind: "connector_failed",
          step: "connector",
          message: `claude.ai has a connector named ${connector.name} that MCPJam can't confirm it added. Remove it in claude.ai, then run again.`,
        });
      }
    }
    try {
      await addConnector(driver, connector, ctx);
    } catch (error) {
      if (!(error instanceof RealUiError) || error.failure.kind !== "plan_limit") throw error;
      // Free allows one custom connector. Only one provably MCPJam's makes
      // room; with anything else there, the turn stops at the plan's limit.
      await driver.navigate(CONNECTORS);
      await driver.type(`${PANE} [placeholder="Search"]`, MCPJAM_CONNECTOR_PREFIX);
      const shown = await driver.readText(`${PANE} >> role=button[name=/^View ${MCPJAM_NAME}$/]`);
      const other = shown?.replace(/^View\s+/, "").trim();
      if (!other || other === connector.name) throw error;
      // The turn's own: removing it would break the turn, so it can't fit here.
      if (keep.includes(other)) {
        throw new RealUiError({
          kind: "plan_limit",
          step: "connector",
          message: "This Claude plan can't hold a connector for each server this run uses. Select fewer servers or use a paid plan.",
        });
      }
      if (!(await removeOwnConnector(driver, other, origin, ctx))) throw error;
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

  async findSent(driver, prompt, _ctx, since) {
    // The newest chats are listed first; the prompt's own chat is one
    // claude.ai created since the send began whose first message is exactly
    // this prompt.
    const org = await organizationId(driver);
    const chats = list(
      await readVendorJson(
        driver,
        `${ORIGIN}/api/organizations/${org}/chat_conversations?limit=10`,
      ),
    );
    for (const chat of chats) {
      const id = text(record(chat).uuid);
      if (!id || !createdSince(record(chat).created_at, since)) continue;
      const saved = await this.readConversation(driver, `${ORIGIN}/chat/${id}`, {
        timeoutMs: 15_000,
      });
      if (saved.userPrompt === prompt) return { conversationUrl: saved.url };
    }
    return undefined;
  },

  async answerApproval(driver, connectorNames) {
    return answerRunApproval(driver, {
      site: "claude.ai",
      connectorNames,
      answers: ["Always allow", "Allow once", "Allow"],
    });
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
