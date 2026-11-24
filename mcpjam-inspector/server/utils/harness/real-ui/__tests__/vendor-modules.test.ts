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
 * against a `fetch` that serves canned JSON by path, with the status
 * `statuses` gives its path (200 otherwise).
 */
function cannedDriver(options: {
  url: string;
  texts?: Record<string, string>;
  json?: Record<string, unknown>;
  statuses?: Record<string, number>;
}): PageDriver {
  let url = options.url;
  vi.stubGlobal("fetch", async (target: string) => {
    const parsed = new URL(target);
    const path = parsed.pathname + parsed.search;
    const [prefix, body] =
      Object.entries(options.json ?? {}).find(([start]) => path.startsWith(start)) ?? [];
    return new Response(JSON.stringify(body ?? {}), {
      status: body === undefined ? 404 : (options.statuses?.[prefix ?? ""] ?? 200),
    });
  });
  return {
    kind: "playwright",
    canEvaluate: true,
    playwrightSelectors: true,
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

type ConnectorRow = { name: string; url: string; connected: boolean };

/**
 * claude.ai's connector settings as the module drives them: a View and a More
 * options button per connector, named after it; the open connector's name,
 * address and Disconnect in the pane; and the add dialog `dialog` shows, by
 * the connectors there and how many times it was read.
 */
function claudeConnectors(
  rows: ConnectorRow[],
  dialog: (rows: ConnectorRow[], reads: number) => string | undefined,
): PageDriver {
  let open: ConnectorRow | undefined;
  let removing: ConnectorRow | undefined;
  let dialogReads = 0;
  const form = { name: "", url: "" };
  /** The connector whose `${action} <name>` button the selector names, exactly or by pattern. */
  const rowFor = (selector: string, action: string) => {
    const named = /^\.dframe-pane-primary >> role=button\[name=(?:"(.*)"|\/(.*)\/)\]$/.exec(selector);
    if (!named) return undefined;
    const label = (row: ConnectorRow) => `${action} ${row.name}`;
    return rows.find((row) =>
      named[1] !== undefined ? named[1] === label(row) : new RegExp(named[2]).test(label(row)),
    );
  };
  return {
    ...cannedDriver({ url: "https://claude.ai/new" }),
    async readText(selector) {
      switch (selector) {
        case '.dframe-pane-primary [placeholder="Search"]':
          return "";
        case ".dframe-pane-primary":
          return open && `${open.name} ${open.url}`;
        case '.dframe-pane-primary >> role=button[name="Disconnect"]':
          return open?.connected ? "Disconnect" : undefined;
        case "role=dialog":
          return dialog(rows, dialogReads++);
        case "role=dialog >> text=Step 2 of 2":
          return "Step 2 of 2";
        case 'role=dialog >> role=button[name="Add"]':
          return "Add";
      }
      const row = rowFor(selector, "View");
      return row && `View ${row.name}`;
    },
    type: vi.fn(async (selector: string, value: string) => {
      if (selector.endsWith('[placeholder="Name"]')) form.name = value;
      if (selector.endsWith('[placeholder="MCP server URL"]')) form.url = value;
    }),
    click: vi.fn(async (selector: string) => {
      open = rowFor(selector, "View") ?? open;
      removing = rowFor(selector, "More options for") ?? removing;
      if (selector === "role=dialog >> role=button[name=/^(Remove|Delete)$/]" && removing) {
        rows.splice(rows.indexOf(removing), 1);
      }
      if (selector === 'role=dialog >> role=button[name="Add"]') {
        open = { ...form, connected: true };
        rows.push(open);
      }
    }),
  };
}

const PLAN_WALL = "Upgrade to add more connectors";
const ADD_FORM = "Add custom connector. Name. MCP server URL.";

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

  it("finds its own chat after a restart, and never one created before the send began", async () => {
    const earlier = "22222222-2222-3333-4444-555555555555";
    const asked = (prompt: string) => ({
      chat_messages: [{ sender: "human", content: [{ type: "text", text: prompt }], created_at: "2026-11-23T10:00:05Z" }],
    });
    const driver = cannedDriver({
      url: "https://claude.ai/new",
      json: {
        "/api/organizations/org-1/chat_conversations?": [
          { uuid: id, created_at: "2026-11-23T10:00:05Z" },
          { uuid: earlier, created_at: "2026-11-23T09:00:00Z" },
        ],
        [`/api/organizations/org-1/chat_conversations/${id}`]: asked("say hello"),
        [`/api/organizations/org-1/chat_conversations/${earlier}`]: asked("say hello"),
        "/api/organizations": [{ uuid: "org-1", name: "Team", capabilities: ["chat"] }],
      },
    });
    const ctx = { timeoutMs: 1_000 };
    expect(await claudeWebPageModule.findSent(driver, "say hello", ctx, "2026-11-23T10:00:00Z")).toEqual({
      conversationUrl: `https://claude.ai/chat/${id}`,
    });
    expect(await claudeWebPageModule.findSent(driver, "say hello", ctx, "2026-11-23T10:00:10Z")).toBeUndefined();
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

  it("answers Always allow in the approval dialog that names the run's connector", async () => {
    const dialog = ':is(dialog, [role="dialog"], [role="alertdialog"]):has-text("MCPJam orders 1a2b3c4d")';
    const driver = cannedDriver({
      url: "https://claude.ai/chat/x",
      texts: {
        'role=button[name="Always allow"]': "Always allow",
        [`${dialog} >> role=button[name="Always allow"]`]: "Always allow",
        [`${dialog} >> role=button[name="Allow once"]`]: "Allow once",
      },
    });
    expect(await claudeWebPageModule.answerApproval(driver, ["MCPJam orders 1a2b3c4d"])).toBe(true);
    expect(driver.click).toHaveBeenCalledWith(`${dialog} >> role=button[name="Always allow"]`);
  });

  it("leaves an approval prompt from another connector unanswered and stops the turn", async () => {
    const driver = cannedDriver({
      url: "https://claude.ai/chat/x",
      texts: { 'role=button[name="Always allow"]': "Always allow", 'role=button[name="Allow once"]': "Allow once" },
    });
    await expect(claudeWebPageModule.answerApproval(driver, ["MCPJam orders 1a2b3c4d"])).rejects.toMatchObject({
      failure: { kind: "connector_failed", step: "reply" },
    });
    expect(driver.click).not.toHaveBeenCalled();
  });

  it("reports the organization its chats come from, not merely the first", async () => {
    const driver = cannedDriver({
      url: "https://claude.ai/new",
      texts: { '[data-testid="chat-input"]': "" },
      json: {
        "/api/account": { email_address: "runner@example.com" },
        "/api/organizations": [
          { uuid: "org-api", name: "API only", capabilities: ["api"] },
          { uuid: "org-chat", name: "Chat team", capabilities: ["chat"] },
        ],
      },
    });
    expect(await claudeWebPageModule.signedIn(driver, { timeoutMs: 1_000 })).toEqual({
      email: "runner@example.com",
      workspace: "Chat team",
    });
  });

  it("reads an error answer from the account endpoint as signed out, in either browser", async () => {
    const error = { type: "error", error: { type: "permission_error", message: "Not signed in" } };
    const scripted = cannedDriver({
      url: "https://claude.ai/new",
      texts: { '[data-testid="chat-input"]': "" },
      json: { "/api/account": error, "/api/organizations": [] },
      statuses: { "/api/account": 403 },
    });
    // The hosted browser shows the error's JSON and no status.
    const shown: PageDriver = {
      ...cannedDriver({ url: "https://claude.ai/new", texts: { '[data-testid="chat-input"]': "" } }),
      canEvaluate: false,
      pageText: async () => JSON.stringify(error),
    };
    for (const driver of [scripted, shown]) {
      await expect(claudeWebPageModule.signedIn(driver, { timeoutMs: 1_000 })).rejects.toMatchObject({
        failure: { kind: "needs_sign_in", reason: "signed_out", step: "sign_in_check" },
      });
    }
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
    const connector = { name: "MCPJam billing 5e6f7a8b", url: "https://inspector.example/mcp/connector-1" };
    const ctx = { timeoutMs: 300 };

    it("stops with plan_limit rather than remove a connector the turn selected", async () => {
      const rows = [{ name: "MCPJam orders 1a2b3c4d", url: "https://inspector.example/mcp/connector-2", connected: true }];
      const driver = claudeConnectors(rows, () => PLAN_WALL);
      await expect(
        claudeWebPageModule.ensureConnector(driver, connector, ctx, ["MCPJam orders 1a2b3c4d", connector.name]),
      ).rejects.toMatchObject({
        failure: { kind: "plan_limit", step: "connector", message: expect.stringContaining("each server this run uses") },
      });
      expect(rows.map((row) => row.name)).toEqual(["MCPJam orders 1a2b3c4d"]);
      expect(driver.click).not.toHaveBeenCalledWith(expect.stringContaining("More options"));
    });

    it("still makes room by removing one another run added", async () => {
      const rows = [{ name: "MCPJam stale 9a8b7c6d", url: "https://inspector.example/mcp/connector-0", connected: false }];
      const driver = claudeConnectors(rows, (shown) => (shown.length > 0 ? PLAN_WALL : ADD_FORM));
      await claudeWebPageModule.ensureConnector(driver, connector, ctx, [connector.name]);
      expect(rows).toEqual([{ ...connector, connected: true }]);
    });
  });

  describe("its connector", () => {
    const connector = { name: "MCPJam orders 1a2b3c4d", url: "https://inspector.example/mcp/connector-1" };
    const ctx = { timeoutMs: 300 };

    it("adds no connector under a name MCPJam doesn't reserve", async () => {
      const driver = claudeConnectors([], () => ADD_FORM);
      await expect(
        claudeWebPageModule.ensureConnector(driver, { ...connector, name: "MCPJam" }, ctx),
      ).rejects.toMatchObject({ failure: { kind: "connector_failed", step: "connector" } });
      expect(driver.type).not.toHaveBeenCalled();
    });

    it("never removes a person's own MCPJam connector to make room on a full plan", async () => {
      const rows = [{ name: "MCPJam", url: "https://mcp.mcpjam.com/mcp", connected: true }];
      const driver = claudeConnectors(rows, () => PLAN_WALL);
      await expect(claudeWebPageModule.ensureConnector(driver, connector, ctx)).rejects.toMatchObject({
        failure: { kind: "plan_limit", step: "connector" },
      });
      expect(rows.map((row) => row.name)).toEqual(["MCPJam"]);
      expect(driver.click).not.toHaveBeenCalledWith(expect.stringContaining("More options"));
    });

    it("keeps a connector under MCPJam's name whose address isn't this run's forwarding endpoint", async () => {
      const rows = [
        { name: "MCPJam billing 5e6f7a8b", url: "https://billing.example.com/mcp", connected: true },
        { name: "MCPJam stale 9a8b7c6d", url: "https://old-tunnel.example/mcp/connector-0", connected: true },
      ];
      const full = claudeConnectors(rows, () => PLAN_WALL);
      await expect(claudeWebPageModule.ensureConnector(full, connector, ctx)).rejects.toMatchObject({
        failure: { kind: "plan_limit" },
      });
      // The same name as the run's, at another address, is not MCPJam's to replace.
      const taken = [{ name: connector.name, url: "https://elsewhere.example/mcp", connected: false }];
      const same = claudeConnectors(taken, () => ADD_FORM);
      await expect(claudeWebPageModule.ensureConnector(same, connector, ctx)).rejects.toMatchObject({
        failure: { kind: "connector_failed", step: "connector" },
      });
      expect([...rows, ...taken]).toHaveLength(3);
      expect(full.click).not.toHaveBeenCalledWith(expect.stringContaining("More options"));
      expect(same.click).not.toHaveBeenCalledWith(expect.stringContaining("More options"));
    });

    it("makes room by removing one MCPJam added on this run's endpoint, then adds the run's", async () => {
      const rows = [{ name: "MCPJam stale 9a8b7c6d", url: "https://inspector.example/mcp/connector-0", connected: false }];
      const driver = claudeConnectors(rows, (shown) => (shown.length > 0 ? PLAN_WALL : ADD_FORM));
      await claudeWebPageModule.ensureConnector(driver, connector, ctx);
      expect(rows).toEqual([{ ...connector, connected: true }]);
    });

    it("waits for the add dialog, and counts only a plan wall as the plan's limit", async () => {
      const person = { name: "Drive", url: "https://drive.example/mcp", connected: true };
      const late = claudeConnectors([person], (_rows, reads) => (reads === 0 ? undefined : PLAN_WALL));
      await expect(claudeWebPageModule.ensureConnector(late, connector, ctx)).rejects.toMatchObject({
        failure: { kind: "plan_limit" },
      });
      const rows = [person];
      const upsell = claudeConnectors(rows, () => `${ADD_FORM} Upgrade to Max for higher usage.`);
      await claudeWebPageModule.ensureConnector(upsell, connector, ctx);
      expect(rows.map((row) => row.name)).toEqual(["Drive", connector.name]);
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
            a: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["say hello"] }, create_time: 1 } },
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
    expect(
      await chatgptWebPageModule.findSent(driver, "say hello", { timeoutMs: 1_000 }, "2026-11-23T10:00:00Z"),
    ).toBeUndefined();
  });

  it("refuses a page read when the browser moved to another chat while it read", async () => {
    // A person can take the browser to another chat between the reads, and
    // hand it back: its prompt and reply must not come back under this id.
    const other = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
    const base = cannedDriver({ url: `https://chatgpt.com/c/${id}` });
    const driver: PageDriver = {
      ...base,
      kind: "hosted",
      canEvaluate: false,
      async readText(selector) {
        if (selector === '[data-message-author-role="assistant"] >> nth=-1') {
          await base.navigate(`https://chatgpt.com/c/${other}`);
          return "the other chat's reply";
        }
        return selector.startsWith("[data-message-author-role=") ? "shown" : undefined;
      },
    };
    const read = chatgptWebPageModule.readConversation(driver, `https://chatgpt.com/c/${id}`, { timeoutMs: 1_000 });
    await expect(read).rejects.toMatchObject({
      failure: { kind: "driver", step: "read_conversation" },
    });
  });

  it("finds its own chat after a restart, and never one created before the send began", async () => {
    const earlier = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
    const asked = (prompt: string) => ({
      mapping: {
        a: { message: { author: { role: "user" }, content: { content_type: "text", parts: [prompt] }, create_time: 1 } },
      },
    });
    const driver = cannedDriver({
      url: "https://chatgpt.com/",
      json: {
        "/api/auth/session": { accessToken: "token", user: { email: "a@example.com" } },
        "/backend-api/conversations?": {
          items: [
            { id, create_time: "2026-11-23T10:00:05.123456+00:00" },
            { id: earlier, create_time: Date.parse("2026-11-23T09:00:00Z") / 1000 },
          ],
        },
        [`/backend-api/conversation/${id}`]: asked("say hello"),
        [`/backend-api/conversation/${earlier}`]: asked("say hello"),
      },
    });
    const ctx = { timeoutMs: 1_000 };
    expect(await chatgptWebPageModule.findSent(driver, "say hello", ctx, "2026-11-23T10:00:00Z")).toEqual({
      conversationUrl: `https://chatgpt.com/c/${id}`,
    });
    expect(await chatgptWebPageModule.findSent(driver, "say hello", ctx, "2026-11-23T10:00:10Z")).toBeUndefined();
    expect(await chatgptWebPageModule.findSent(driver, "say hello", ctx, "2026-11-23T08:00:00Z")).toEqual({
      conversationUrl: `https://chatgpt.com/c/${id}`,
    });
  });

  it("takes the prompt from the first message the person sees, not the account's hidden custom instructions", async () => {
    const hidden = { is_visually_hidden_from_conversation: true };
    const driver = cannedDriver({
      url: `https://chatgpt.com/c/${id}`,
      json: {
        "/api/auth/session": { accessToken: "token", user: { email: "a@example.com" } },
        [`/backend-api/conversation/${id}`]: {
          mapping: {
            root: { message: null },
            instructions: {
              message: {
                author: { role: "user" },
                content: { content_type: "user_editable_context", user_profile: "I build MCP servers.", user_instructions: "Be brief." },
                metadata: { ...hidden, user_context_message_data: { about_user_message: "I build MCP servers." } },
                create_time: null,
              },
            },
            context: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["Earlier context"] }, metadata: hidden, create_time: 0.5 } },
            prompt: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["say hello"] }, create_time: 1 } },
            reply: { message: { author: { role: "assistant" }, recipient: "all", content: { content_type: "text", parts: ["Hello."] }, create_time: 2 } },
          },
        },
      },
    });
    const saved = await chatgptWebPageModule.readConversation(driver, `https://chatgpt.com/c/${id}`, { timeoutMs: 1_000 });
    expect(saved).toMatchObject({ userPrompt: "say hello", replyText: "Hello." });
  });

  it("leaves a bare Confirm that isn't the run's connector's approval unanswered and stops the turn", async () => {
    const dialog = ':is(dialog, [role="dialog"], [role="alertdialog"]):has-text("MCPJam orders 1a2b3c4d")';
    const other = cannedDriver({ url: "https://chatgpt.com/c/x", texts: { 'role=button[name="Confirm"]': "Confirm" } });
    await expect(chatgptWebPageModule.answerApproval(other, ["MCPJam orders 1a2b3c4d"])).rejects.toMatchObject({
      failure: { kind: "connector_failed", step: "reply" },
    });
    expect(other.click).not.toHaveBeenCalled();
    const own = cannedDriver({
      url: "https://chatgpt.com/c/x",
      texts: { 'role=button[name="Confirm"]': "Confirm", [`${dialog} >> role=button[name="Confirm"]`]: "Confirm" },
    });
    expect(await chatgptWebPageModule.answerApproval(own, ["MCPJam orders 1a2b3c4d"])).toBe(true);
    expect(own.click).toHaveBeenCalledWith(`${dialog} >> role=button[name="Confirm"]`);
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

  it("stops claude.ai's connector step before it changes any connector on the account", async () => {
    // Its chat menu needs a key pressed on one element, which this browser
    // refuses: stopping at the menu would leave the account's connectors changed.
    const send = vi.fn(async (_command: BrowserAgentCommand) => executed({ url: "https://claude.ai/new" }));
    const driver = createHostedPageDriver(send, { sites: WEB_CLIENT_SITES.claude });
    const connector = { name: "MCPJam orders 1a2b3c4d", url: "https://inspector.example/mcp/connector-1" };
    await expect(claudeWebPageModule.ensureConnector(driver, connector, { timeoutMs: 300 })).rejects.toMatchObject({
      failure: { kind: "driver", step: "connector" },
    });
    expect(send).not.toHaveBeenCalled();
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

  it("refuses a key press aimed at an element, which the browser would send wherever focus is", async () => {
    const send = vi.fn(async (_command: BrowserAgentCommand) => executed());
    const driver = createHostedPageDriver(send, { sites: WEB_CLIENT_SITES.claude });
    // Its reads and acts find elements with Playwright's engine in the browser.
    expect(driver.playwrightSelectors).toBe(true);
    await expect(driver.press("ArrowRight", '[data-testid="add-menu-connectors"]')).rejects.toMatchObject({
      code: "unsupported",
    });
    expect(send).not.toHaveBeenCalled();
    await driver.press("Escape");
    expect(send.mock.calls.map(([command]) => command)).toEqual([
      { op: "act", verb: "press", value: "Escape", observeAfter: "none" },
    ]);
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
