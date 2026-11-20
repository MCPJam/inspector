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
          ".dframe-pane-primary role=button[name=/^View MCPJam/]": `View ${shown}`,
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
        '.dframe-pane-primary role=button[name="More options for MCPJam stale 9a8b7c6d"]',
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
      executed({ url: "https://claude.ai/new", a11y: "textbox" }),
    );
    const driver = createHostedPageDriver(send, { sites: WEB_CLIENT_SITES.claude });
    await driver.navigate("https://claude.ai/new");
    await driver.click('[data-testid="chat-input-send"]');
    await driver.type('[data-testid="chat-input"]', "hi");
    expect(await driver.url()).toBe("https://claude.ai/new");
    expect(await driver.readText('[data-testid="chat-input"]')).toBe("textbox");
    expect(send.mock.calls.map(([command]) => command)).toEqual([
      { op: "navigate", url: "https://claude.ai/new", observeAfter: "none" },
      { op: "act", verb: "click", target: { selector: '[data-testid="chat-input-send"]' }, observeAfter: "none" },
      { op: "act", verb: "type", target: { selector: '[data-testid="chat-input"]' }, value: "hi", observeAfter: "none" },
      { op: "observe", mode: "url" },
      { op: "observe", mode: "a11y", rootSelector: '[data-testid="chat-input"]', filter: "all" },
    ]);
    expect(driver.canEvaluate).toBe(false);
    await expect(driver.evaluate(() => 1, {})).rejects.toMatchObject({ code: "unsupported" });
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
});
