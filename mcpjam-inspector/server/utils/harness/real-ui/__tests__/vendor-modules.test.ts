/**
 * The vendor page modules' readings, against canned pages and JSON, and the
 * hosted driver's mapping onto the conversation browser's command API.
 *
 * Evidence: fixture. The claude.ai and chatgpt.com shapes here are the ones
 * the modules expect; no live vendor run has checked them yet.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserAgentCommand,
  BrowserAgentResult,
} from "@/shared/browser-agent-contract";
import { WEB_CLIENT_PAGE_MODULE_VERSIONS, WEB_CLIENT_SITES } from "@/shared/web-clients";
import { HARNESS_DESCRIPTORS } from "@/shared/harness-descriptors";
import { chatgptWebPageModule } from "../chatgpt-web";
import { claudeWebPageModule } from "../claude-web";
import { createHostedPageDriver } from "../hosted-driver";
import { pollUntil, type PageDriver } from "../page-driver";
import { readVendorJson } from "../vendor-json";

/**
 * A page that answers `readText` from a map, and runs `evaluate` for real
 * against a `fetch` that serves canned JSON by path.
 */
function cannedDriver(options: {
  url: string;
  texts?: Record<string, string>;
  json?: Record<string, unknown>;
}): PageDriver {
  let url = options.url;
  vi.stubGlobal("fetch", async (target: string) => {
    const parsed = new URL(target);
    const path = parsed.pathname + parsed.search;
    const body = Object.entries(options.json ?? {}).find(([prefix]) =>
      path.startsWith(prefix),
    )?.[1];
    return new Response(JSON.stringify(body ?? {}), {
      status: body === undefined ? 404 : 200,
    });
  });
  return {
    kind: "playwright",
    canEvaluate: true,
    async navigate(next) {
      url = next;
    },
    async url() {
      return url;
    },
    async evaluate(fn, arg) {
      return fn(arg);
    },
    waitFor: pollUntil,
    click: vi.fn(async () => undefined),
    type: vi.fn(async () => undefined),
    press: vi.fn(async () => undefined),
    async readText(selector) {
      return options.texts?.[selector];
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("page module pins", () => {
  it("pins each vendor module to the version its runtime declares", () => {
    expect(claudeWebPageModule.version).toBe(HARNESS_DESCRIPTORS["claude-web"].runtimeVersion);
    expect(chatgptWebPageModule.version).toBe(HARNESS_DESCRIPTORS["chatgpt-web"].runtimeVersion);
    expect(claudeWebPageModule.version).toBe(WEB_CLIENT_PAGE_MODULE_VERSIONS.claude);
    expect(claudeWebPageModule.sites).toEqual(WEB_CLIENT_SITES.claude);
    expect(chatgptWebPageModule.sites).toEqual(WEB_CLIENT_SITES.chatgpt);
  });
});

describe("claude.ai", () => {
  const id = "11111111-2222-3333-4444-555555555555";
  it("reads the reply and each tool use id from the saved conversation", async () => {
    const driver = cannedDriver({
      url: `https://claude.ai/chat/${id}`,
      json: {
        "/api/organizations/org-1/chat_conversations/": {
          chat_messages: [
            { sender: "human", content: [{ type: "text", text: "say hello" }], created_at: "2026-11-20T08:00:00Z" },
            {
              sender: "assistant",
              created_at: "2026-11-20T08:00:01Z",
              content: [
                { type: "tool_use", id: "toolu_01", name: "echo", input: { message: "hello" } },
                { type: "tool_result", tool_use_id: "toolu_01", content: [] },
                { type: "text", text: "It said hello." },
              ],
            },
          ],
        },
        "/api/organizations": [{ uuid: "org-1", name: "Team", capabilities: ["chat"] }],
      },
    });
    const saved = await claudeWebPageModule.readConversation(driver, `https://claude.ai/chat/${id}`, { timeoutMs: 1_000 });
    expect(saved).toEqual({
      conversationId: id,
      url: `https://claude.ai/chat/${id}`,
      userPrompt: "say hello",
      replyText: "It said hello.",
      toolCalls: [{ toolName: "echo", toolUseId: "toolu_01", at: "2026-11-20T08:00:01Z" }],
    });
  });

  it("names a Cloudflare check as needs_sign_in and a plan wall as plan_limit", async () => {
    const challenged = cannedDriver({
      url: "https://claude.ai/new",
      texts: { 'iframe[src*="challenges.cloudflare.com"]': "" },
    });
    expect(await claudeWebPageModule.blocker(challenged)).toMatchObject({
      kind: "needs_sign_in",
      reason: "human_check",
    });
    const walled = cannedDriver({
      url: "https://claude.ai/chat/x",
      texts: { body: "", ".dframe-pane-primary": "You've reached your usage limit until 3 PM" },
    });
    expect(await claudeWebPageModule.blocker(walled)).toMatchObject({ kind: "plan_limit" });
  });

  it("stops waiting for a control at a password prompt, as the account's sign-in, not a changed page", async () => {
    const driver = cannedDriver({ url: "https://claude.ai/new", texts: { 'input[type="password"]': "" } });
    await expect(claudeWebPageModule.openNewChat(driver, { timeoutMs: 1_000 })).rejects.toMatchObject({
      failure: { kind: "needs_sign_in", reason: "password", step: "new_chat" },
    });
  });

  it("answers the app's approval with Always allow where it is offered", async () => {
    const driver = cannedDriver({
      url: "https://claude.ai/chat/x",
      texts: { 'role=button[name="Always allow"]': "Always allow", 'role=button[name="Allow once"]': "Allow once" },
    });
    expect(await claudeWebPageModule.answerApproval(driver)).toBe(true);
    expect(driver.click).toHaveBeenCalledWith('role=button[name="Always allow"]');
  });

  it("calls a reply finished only when every signal agrees", async () => {
    const streaming = cannedDriver({
      url: "https://claude.ai/chat/x",
      texts: {
        '.dframe-pane-primary [data-is-streaming="true"]': "...",
        ".dframe-pane-primary [data-is-streaming]": "...",
        '[data-testid="chat-input"]': "",
      },
    });
    expect((await claudeWebPageModule.replySignals(streaming)).finished).toBe(false);
    const done = cannedDriver({
      url: "https://claude.ai/chat/x",
      texts: { ".dframe-pane-primary [data-is-streaming]": "Hi", '[data-testid="chat-input"]': "" },
    });
    expect(await claudeWebPageModule.replySignals(done)).toEqual({
      finished: true,
      signals: ["no stop button", "nothing streaming", "an assistant message", "the composer is back"],
    });
  });

  describe("on a plan with no room for another connector", () => {
    const connector = { name: "MCPJam billing 5e6f7a8b", url: "https://inspector.example/mcp/billing" };
    /** The add dialog asks for an upgrade, and the search shows one MCPJam connector. */
    const walled = (shown: string) =>
      cannedDriver({
        url: "https://claude.ai/customize/connectors/yours",
        texts: {
          '.dframe-pane-primary [placeholder="Search"]': "",
          "role=dialog": "Upgrade to add more connectors",
          ".dframe-pane-primary >> role=button[name=/^View MCPJam/]": `View ${shown}`,
        },
      });

    it("stops with plan_limit rather than remove a connector the turn selected", async () => {
      const driver = walled("MCPJam orders 1a2b3c4d");
      await expect(
        claudeWebPageModule.ensureConnector(driver, connector, { timeoutMs: 1_000 }, [
          "MCPJam orders 1a2b3c4d",
          connector.name,
        ]),
      ).rejects.toMatchObject({
        failure: { kind: "plan_limit", step: "connector", message: expect.stringContaining("each server this run uses") },
      });
      expect(driver.click).not.toHaveBeenCalledWith(expect.stringContaining("More options"));
    });

    it("still makes room by removing one another run added", async () => {
      const driver = walled("MCPJam stale 9a8b7c6d");
      // The canned dialog still asks for an upgrade, so the second add fails too.
      await expect(
        claudeWebPageModule.ensureConnector(driver, connector, { timeoutMs: 1_000 }, [connector.name]),
      ).rejects.toMatchObject({ failure: { kind: "plan_limit" } });
      expect(driver.click).toHaveBeenCalledWith(
        '.dframe-pane-primary >> role=button[name="More options for MCPJam stale 9a8b7c6d"]',
      );
    });
  });
});

describe("chatgpt.com", () => {
  const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  it("reads the reply and the tool calls, which carry no tool use id", async () => {
    const driver = cannedDriver({
      url: `https://chatgpt.com/c/${id}`,
      json: {
        "/api/auth/session": { accessToken: "token", user: { email: "a@example.com" } },
        [`/backend-api/conversation/${id}`]: {
          mapping: {
            a: { message: { author: { role: "user" }, content: { parts: ["say hello"] }, create_time: 1 } },
            b: { message: { author: { role: "assistant" }, recipient: "fixture.echo", content: { parts: [""] }, create_time: 2 } },
            c: { message: { author: { role: "tool" }, content: { parts: ["echo: hello"] }, create_time: 3 } },
            d: { message: { author: { role: "assistant" }, recipient: "all", content: { parts: ["It said hello."] }, create_time: 4 } },
          },
        },
      },
    });
    const saved = await chatgptWebPageModule.readConversation(driver, `https://chatgpt.com/c/${id}`, { timeoutMs: 1_000 });
    expect(saved).toMatchObject({
      conversationId: id,
      userPrompt: "say hello",
      replyText: "It said hello.",
      toolCalls: [{ toolName: "echo", at: new Date(2000).toISOString() }],
    });
    expect(saved.toolCalls[0]).not.toHaveProperty("toolUseId");
  });

  it("reads the chat from the page in a browser that runs no script", async () => {
    const driver: PageDriver = {
      ...cannedDriver({
        url: `https://chatgpt.com/c/${id}`,
        // The hosted browser reads an element's text, as the Playwright one does.
        texts: {
          '[data-message-author-role="user"]': "say hello",
          '[data-message-author-role="assistant"]': "Calling echo",
          '[data-message-author-role="assistant"] >> nth=-1': 'It said "hello".',
        },
      }),
      kind: "hosted",
      canEvaluate: false,
    };
    expect(
      await chatgptWebPageModule.readConversation(driver, `https://chatgpt.com/c/${id}`, { timeoutMs: 1_000 }),
    ).toEqual({
      conversationId: id,
      url: `https://chatgpt.com/c/${id}`,
      userPrompt: "say hello",
      replyText: 'It said "hello".',
      toolCalls: [],
    });
    // The chat list needs the session's token, so an earlier send stays ambiguous.
    expect(await chatgptWebPageModule.findSent(driver, "say hello", { timeoutMs: 1_000 })).toBeUndefined();
  });

  it("stops waiting for a control at a human check, as the account's sign-in, not a changed page", async () => {
    const driver = cannedDriver({ url: "https://chatgpt.com/", texts: { 'iframe[src*="arkoselabs"], iframe[src*="challenges.cloudflare.com"]': "" } });
    await expect(chatgptWebPageModule.openNewChat(driver, { timeoutMs: 1_000 })).rejects.toMatchObject({
      failure: { kind: "needs_sign_in", reason: "human_check", step: "new_chat" },
    });
  });
});

describe("chatgpt.com's connector step", () => {
  const connector = { name: "MCPJam orders", url: "https://inspector.example/mcp/abc" };
  const composer = '[contenteditable="true"][aria-label="Ask ChatGPT"]';
  const current = { [composer]: "" };
  const installed = 'role=link[name="MCPJam orders"s]';
  const pluginSettings = {
    ...current, [installed]: connector.name,
    'role=button[name="Add"s]': "Add", 'role=link[name="Settings"s]': "Settings",
    'role=link[name="View details"s]': "View details",
  };

  it("reads the hosted account email from Settings with the sidebar collapsed", async () => {
    const email = "review@example.org";
    const controls = {
      ...current,
      'role=button[name="Show sidebar"s]': "",
      'role=menuitem[name="Settings"s]': "",
      'role=dialog >> role=button[name="Account"s]': "",
      'role=dialog >> text=/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/': email,
    };
    const fixture = cannedDriver({ url: "https://chatgpt.com/", texts: controls });
    let expanded = false;
    const driver: PageDriver = {
      ...fixture, kind: "hosted", canEvaluate: false,
      click: async (target) => { if (target === 'role=button[name="Show sidebar"s]') expanded = true; },
      readText: async (target) => expanded && target === 'role=button[name="Open profile menu"s]'
        ? "Profile" : fixture.readText(target),
    };
    await expect(chatgptWebPageModule.signedIn(driver, { timeoutMs: 500 })).resolves.toEqual({ email });
    expect(await driver.url()).toBe("https://chatgpt.com/");
  });

  it("checks the installed plugin address in Settings before reusing it", async () => {
    const shown = `main >> text="${connector.url}"`;
    const driver = cannedDriver({ url: "https://chatgpt.com/", texts: { ...pluginSettings, [shown]: connector.url } });
    await chatgptWebPageModule.ensureConnector(driver, connector, { timeoutMs: 500 });
    expect(driver.click).toHaveBeenCalledWith('role=link[name="Settings"s]');
    expect(driver.type).not.toHaveBeenCalled();
    const other = cannedDriver({ url: "https://chatgpt.com/", texts: pluginSettings });
    await expect(chatgptWebPageModule.ensureConnector(other, connector, { timeoutMs: 500 }))
      .rejects.toMatchObject({ failure: { kind: "connector_failed" } });
  });

  it("leaves ChatGPT's trust checkbox for the person setting up the server", async () => {
    const driver = cannedDriver({ url: "https://chatgpt.com/", texts: {
      ...current, 'role=button[name="Add"s]': "Add",
      'role=menuitem[name="Add custom MCP server"s]': "Add custom MCP server",
      'role=dialog >> role=textbox[name="Name"s]': "",
      'role=dialog >> role=checkbox[name="I understand and want to continue"s][checked=false]': "",
    } });
    await expect(chatgptWebPageModule.ensureConnector(driver, connector, { timeoutMs: 500 }))
      .rejects.toMatchObject({ failure: { kind: "needs_sign_in", reason: "consent" } });
    expect(driver.type).toHaveBeenLastCalledWith('role=dialog >> role=textbox[name="Server URL"s]', connector.url);
    expect(driver.click).toHaveBeenCalledTimes(2);
  });

  it("selects the named plugin in the current composer", async () => {
    const item = 'role=button[name="MCPJam orders MCPJam orders"s]';
    const driver = cannedDriver({ url: "https://chatgpt.com/", texts: { ...current, [item]: connector.name } });
    await chatgptWebPageModule.enableConnector(driver, connector.name, { timeoutMs: 500 });
    expect(vi.mocked(driver.click).mock.calls).toEqual([['role=button[name="Add files and more"s]'], [item]]);
  });

  it("adds one through Plugins, then Add custom MCP server, and waits for it to install", async () => {
    const installed = 'role=link[name="MCPJam orders"s]';
    const create = 'role=dialog >> role=button[name="Create as a plugin"s]';
    const fixture = cannedDriver({ url: "https://chatgpt.com/", texts: {
      ...current, 'role=button[name="Add"s]': "Add",
      'role=menuitem[name="Add custom MCP server"s]': "Add custom MCP server",
      'role=dialog >> role=textbox[name="Name"s]': "",
    } });
    let created = false;
    const driver: PageDriver = {
      ...fixture,
      click: vi.fn(async (target: string) => {
        if (target === create) created = true;
      }),
      readText: async (target) => (created && target === installed ? connector.name : fixture.readText(target)),
    };
    await chatgptWebPageModule.ensureConnector(driver, connector, { timeoutMs: 1_000 });
    expect(vi.mocked(driver.click).mock.calls.map(([selector]) => selector)).toEqual([
      'role=button[name="Add"s]',
      'role=menuitem[name="Add custom MCP server"s]',
      create,
    ]);
    expect(vi.mocked(fixture.type).mock.calls).toEqual([
      ['role=dialog >> role=textbox[name="Name"s]', connector.name],
      ['role=dialog >> role=textbox[name="Server URL"s]', connector.url],
    ]);
  });

  it("sends with the composer's Send button and waits for the chat to open", async () => {
    const chat = "https://chatgpt.com/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const fixture = cannedDriver({ url: "https://chatgpt.com/", texts: current });
    let sent = false;
    const driver: PageDriver = {
      ...fixture,
      click: vi.fn(async () => {
        sent = true;
      }),
      url: async () => (sent ? chat : "https://chatgpt.com/"),
      readText: async (target) =>
        sent && target === '[data-message-author-role="user"]' ? "say hello" : fixture.readText(target),
    };
    await expect(chatgptWebPageModule.send(driver, "say hello", { timeoutMs: 1_000 })).resolves.toEqual({
      conversationUrl: chat,
    });
    expect(fixture.type).toHaveBeenCalledWith(composer, "say hello");
    expect(vi.mocked(driver.click).mock.calls).toEqual([['role=button[name="Send"s]']]);
  });
});

describe("the hosted driver", () => {
  const executed = (page?: Record<string, unknown>): BrowserAgentResult => ({
    status: "executed",
    commandId: "c",
    ok: true,
    ...(page ? { page: { viewport: { width: 1024, height: 768 }, pageContent: { untrusted: true, ...page } } } : {}),
  });

  it("sends the command API's own commands and runs no script", async () => {
    const send = vi.fn(async (_command: BrowserAgentCommand) =>
      executed({ url: "https://claude.ai/new", text: " hi\n" }),
    );
    const driver = createHostedPageDriver(send, { sites: WEB_CLIENT_SITES.claude });
    await driver.navigate("https://claude.ai/new");
    await driver.click('[data-testid="chat-input-send"]');
    await driver.type('[data-testid="chat-input"]', "hi");
    expect(await driver.url()).toBe("https://claude.ai/new");
    expect(await driver.readText('[data-testid="chat-input"]')).toBe("hi");
    expect(send.mock.calls.map(([command]) => command)).toEqual([
      { op: "navigate", url: "https://claude.ai/new", observeAfter: "none" },
      { op: "act", verb: "click", target: { selector: '[data-testid="chat-input-send"]' }, observeAfter: "none" },
      { op: "act", verb: "type", target: { selector: '[data-testid="chat-input"]' }, value: "hi", observeAfter: "none" },
      { op: "observe", mode: "url" },
      { op: "observe", mode: "text", rootSelector: '[data-testid="chat-input"]' },
    ]);
    expect(driver.canEvaluate).toBe(false);
    await expect(driver.evaluate(() => 1, {})).rejects.toMatchObject({ code: "unsupported" });
  });

  it("reads an element as absent only when nothing matches it, and fails any other read", async () => {
    const failed = (code: string): BrowserAgentResult => ({
      status: "executed",
      commandId: "c",
      ok: false,
      error: { code, message: `${code} for this read` },
    });
    const send = vi.fn(async (command: BrowserAgentCommand) =>
      command.op === "observe" && command.rootSelector === "role=dialog"
        ? failed("unknown_selector")
        : failed("unsupported_target"),
    );
    const driver = createHostedPageDriver(send, { sites: WEB_CLIENT_SITES.chatgpt });
    expect(await driver.readText("role=dialog")).toBeUndefined();
    // A read that failed is never taken for an element that isn't there.
    await expect(driver.readText("main")).rejects.toMatchObject({ code: "failed" });
  });

  it("reads a site's JSON from the page's text, and goes back to the page it was on", async () => {
    const send = vi.fn(async (command: { op: string; mode?: string }) =>
      command.op === "observe" && command.mode === "url"
        ? executed({ url: "https://claude.ai/new" })
        : command.op === "observe"
          ? executed({ text: 'Pretty-print\n\n```\n{"email_address":"runner@example.com","tags":["a"]}\n```' })
          : executed(),
    );
    const driver = createHostedPageDriver(send, { sites: WEB_CLIENT_SITES.claude });
    expect(await readVendorJson(driver, "https://claude.ai/api/account")).toEqual({
      email_address: "runner@example.com",
      tags: ["a"],
    });
    expect(send.mock.calls.map(([command]) => command)).toEqual([
      { op: "observe", mode: "url" },
      { op: "navigate", url: "https://claude.ai/api/account", observeAfter: "none" },
      { op: "observe", mode: "text" },
      { op: "navigate", url: "https://claude.ai/new", observeAfter: "none" },
    ]);
  });

  it("goes back to the page it was on when the site's JSON can't be read", async () => {
    const send = vi.fn(async (command: { op: string; mode?: string }) =>
      command.op === "observe" && command.mode === "url"
        ? executed({ url: "https://claude.ai/new" })
        : command.op === "observe"
          ? executed({ text: "Not found" })
          : executed(),
    );
    const driver = createHostedPageDriver(send, { sites: WEB_CLIENT_SITES.claude });
    await expect(readVendorJson(driver, "https://claude.ai/api/account")).rejects.toMatchObject({ code: "failed" });
    expect(send.mock.calls.at(-1)?.[0]).toEqual({ op: "navigate", url: "https://claude.ai/new", observeAfter: "none" });
  });

  it("refuses other sites and never retries a command whose outcome is unknown", async () => {
    const send = vi.fn(
      async (): Promise<BrowserAgentResult> => ({
        status: "unknown",
        commandId: "c",
        unknown: { reason: "transport", commandId: "c", instruction: "read the trace" },
      }),
    );
    const driver = createHostedPageDriver(send, { sites: WEB_CLIENT_SITES.claude });
    await expect(driver.navigate("https://example.com")).rejects.toMatchObject({ code: "site_blocked" });
    await expect(driver.click("#send")).rejects.toMatchObject({ code: "unknown_outcome" });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("reads a site's own JSON from the page text the browser shows, and says when it is cut short", async () => {
    let shown = 'Pretty-print\n```\n{"user":{"email":"a@example.com"}}\n```';
    const send = vi.fn(async (command: BrowserAgentCommand) =>
      command.op === "observe" && command.mode === "text"
        ? executed({ text: shown })
        : executed({ url: "https://chatgpt.com/" }),
    );
    const driver = createHostedPageDriver(send, { sites: WEB_CLIENT_SITES.chatgpt });
    expect(await readVendorJson(driver, "https://chatgpt.com/api/auth/session")).toEqual({
      user: { email: "a@example.com" },
    });
    expect(send.mock.calls.map(([command]) => command.op)).toEqual(["observe", "navigate", "observe", "navigate"]);
    shown = '{"user":{"email":"a@exa';
    await expect(readVendorJson(driver, "https://chatgpt.com/api/auth/session")).rejects.toMatchObject({
      code: "failed",
    });
    // The token-carrying API needs a script, which this browser can't run.
    await expect(
      readVendorJson(driver, "https://chatgpt.com/backend-api/conversations", { authorization: "Bearer t" }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });
});
