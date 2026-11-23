/**
 * What a web client turn refuses, and where. A tool the run's tool policy
 * denies is refused at the real forwarding endpoint whatever the approval
 * switch says; a setting the vendor's app can't honor stops the turn before
 * its page is driven; a failure never carries a connector's credential out.
 * And the connector names the vendors find connectors by.
 *
 * Evidence: fixture (local test doubles), no live vendor.
 */
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright";
import { MCPClientManager } from "@mcpjam/sdk";
import type { ToolPolicySnapshot } from "@mcpjam/sdk/contract";
import { extractToolCallsExcludingPolicyBlocks } from "@/shared/eval-tool-call-projection";
import { SYNTHETIC_SESSION_APPROVAL_DENIAL } from "@/shared/tool-approval";
import { startFixtureUpstream, type FixtureUpstream } from "../../../test/support/web-clients/fixture-upstream";
import { startFixtureVendor, type FixtureVendor } from "../../../test/support/web-clients/fixture-vendor";
import type { HarnessPolicyBlockRecord } from "../../../utils/harness/harness-proxy-policy-enforcement";
import { createMemorySendJournal } from "../../../utils/harness/real-ui/drive-turn";
import { createFixtureWebPageModule } from "../../../utils/harness/real-ui/fixture-web";
import { createPlaywrightDriver } from "../../../utils/harness/real-ui/playwright-driver";
import { runHarnessTurn } from "../../../utils/harness/run-harness-turn";
import type { MCPJamHandlerOptions } from "../../../utils/mcpjam-stream-handler";
import { createStaticConnectorResolver } from "../connectors";
import { createWebConnectorEndpoint } from "../forwarding-endpoint";
import { webConnectorName, webTurnApprover } from "../run-web-client-turn";
import { webClientToolCallLedger } from "../tool-call-ledger";
import { webClientTurnWindows } from "../turn-windows";
import { setWebClientEnvironment, type WebClientEnvironment } from "../web-client-environment";
import { WebClientRunError, WebClientTurnRefusedError } from "../web-client-harness-turn";

const CONNECTOR_ID = "conn-gates-orders";
const DENY_ECHO: ToolPolicySnapshot = {
  mode: "default",
  denied: { echo: { reason: "denyList", classification: "unknown" } },
  known: ["echo", "list"],
  unknownTool: "deny",
};

let browser: Browser;
let vendor: FixtureVendor;
let upstream: FixtureUpstream;
let server: ServerType;
let environment: WebClientEnvironment;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});
beforeEach(async () => {
  vendor = await startFixtureVendor();
  upstream = await startFixtureUpstream();
  const app = createWebConnectorEndpoint({
    resolver: createStaticConnectorResolver([
      {
        connector: { connectorId: CONNECTOR_ID, projectId: "project-1", serverId: "orders", auth: "capability" },
        upstream: { url: upstream.url, headers: {} },
      },
    ]),
    turns: webClientTurnWindows,
    ledger: webClientToolCallLedger,
    isEnabled: async () => true,
  });
  server = await new Promise<ServerType>((resolve) => {
    const started = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(started));
  });
  environment = {
    publicBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    journal: createMemorySendJournal(),
    pageModule: createFixtureWebPageModule(vendor.url),
    async resolveAccount() {
      return { webAccountId: "account-1", accountEmail: "runner@example.com" };
    },
    async ensureConnector() {
      return { connectorId: CONNECTOR_ID };
    },
    async openBrowser({ sites }) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${vendor.url}/sign-in?as=runner@example.com`);
      return { driver: await createPlaywrightDriver(page, { sites }), close: () => context.close() };
    },
  };
  setWebClientEnvironment(environment);
});
afterEach(async () => {
  setWebClientEnvironment(undefined);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await vendor.close();
  await upstream.close();
});

function options(over: Partial<MCPJamHandlerOptions> = {}): MCPJamHandlerOptions {
  return {
    messages: [{ role: "user", content: "say hello" }],
    modelId: "anthropic/claude-sonnet-4.5",
    systemPrompt: "",
    tools: {},
    mcpClientManager: new MCPClientManager(),
    harness: "claude-web",
    projectId: "project-1",
    selectedServers: ["orders"],
    sourceType: "eval",
    evalIterationId: "iteration-1",
    ...over,
  };
}

const toolCalls = () => upstream.received.filter((request) => request.method === "tools/call");

describe("the run's tool policy on a web turn", { timeout: 90_000 }, () => {
  it("refuses a denied tool at the endpoint with approval off, and reports the block", async () => {
    const blocks: HarnessPolicyBlockRecord[] = [];
    const result = await runHarnessTurn(
      options({
        harnessToolPolicy: { orders: DENY_ECHO },
        onHarnessPolicyBlocks: (found) => void blocks.push(...found),
      }),
      "none",
    );
    expect(toolCalls()).toEqual([]);
    // The vendor's model read the same refusal the harness proxy gives.
    expect(result.messageHistory.at(-1)).toMatchObject({
      content: expect.arrayContaining([
        { type: "text", text: "The tool call failed: Call blocked by tool policy: denyList" },
      ]),
    });
    const [chat] = vendor.chats.values();
    expect(blocks).toEqual([
      expect.objectContaining({
        toolName: "echo",
        reason: "denyList",
        serverId: "orders",
        toolCallId: chat!.toolCalls[0]!.toolUseId,
      }),
    ]);
  });

  it("leaves a call it refused out of the grade on ChatGPT, which sends no tool use id", async () => {
    vendor.withoutToolUseIds = true;
    const blocks: HarnessPolicyBlockRecord[] = [];
    const result = await runHarnessTurn(
      options({
        harness: "chatgpt-web",
        modelId: "openai/gpt-5.5",
        harnessToolPolicy: { orders: DENY_ECHO },
        onHarnessPolicyBlocks: (found) => void blocks.push(...found),
      }),
      "none",
    );
    expect(toolCalls()).toEqual([]);
    // The eval's grade: every call the transcript shows, less the refused ones.
    const refused = new Set(blocks.flatMap((block) => (block.toolCallId ? [block.toolCallId] : [])));
    expect(refused.size).toBe(1);
    expect(extractToolCallsExcludingPolicyBlocks({ messages: result.messageHistory }, refused)).toEqual([]);
  });

  it("decides by the snapshot before the switch, and leaves a server it doesn't cover to the switch", async () => {
    const call = { connectorId: CONNECTOR_ID, turnId: "t", jsonrpcId: 1, toolName: "echo", arguments: {}, toolUseId: "toolu_1" };
    const blocks: HarnessPolicyBlockRecord[] = [];
    const approve = webTurnApprover(
      { requireToolApproval: false, answer: "person" },
      {
        snapshots: { orders: DENY_ECHO },
        onBlock: (block) => void blocks.push(block),
        serverOf: (connectorId) => (connectorId === CONNECTOR_ID ? "orders" : undefined),
      },
    );
    expect(await approve(call)).toEqual({ allow: false, reason: "Call blocked by tool policy: denyList" });
    expect(await approve({ ...call, toolName: "list" })).toEqual({ allow: true });
    expect(await approve({ ...call, toolName: "added_later" })).toEqual({
      allow: false,
      reason: "Call blocked by tool policy: unknownAtLaunch",
    });
    // A connector the turn can't place under a server has no decision to allow it.
    expect((await approve({ ...call, connectorId: "conn-unknown" })).allow).toBe(false);
    expect(blocks.map((block) => [block.toolName, block.reason, block.serverId])).toEqual([
      ["echo", "denyList", "orders"],
      ["added_later", "unknownAtLaunch", "orders"],
      ["echo", "unknownAtLaunch", undefined],
    ]);
    const uncovered = webTurnApprover(
      { requireToolApproval: true, answer: "deny" },
      { snapshots: {}, serverOf: () => "orders" },
    );
    expect(await uncovered(call)).toEqual({ allow: false, reason: SYNTHETIC_SESSION_APPROVAL_DENIAL });
  });
});

describe("settings the vendor's app can't honor", { timeout: 90_000 }, () => {
  it("refuses a turn that asks for approval before the page is driven, with the gate's reason", async () => {
    const failure = await runHarnessTurn(
      options({ requireToolApproval: true, sourceType: "direct", evalIterationId: undefined, chatSessionId: "chat-1" }),
      "none",
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WebClientTurnRefusedError);
    expect(failure).toMatchObject({
      kind: "tool-approval",
      message:
        "The Claude web client does not support interactive tool approval. Turn off tool approvals for this client or choose another client.",
    });
    expect(vendor.sends).toEqual([]);
    expect(toolCalls()).toEqual([]);
  });

  it("refuses a system prompt the app has no place for, rather than dropping it", async () => {
    const failure = await runHarnessTurn(options({ systemPrompt: "Always reply in French." }), "none").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(WebClientTurnRefusedError);
    expect(failure).toMatchObject({
      kind: "setting-unsupported",
      message:
        "Claude web uses claude.ai's own instructions, so it can't take a system prompt. Clear this client's system prompt or choose another client.",
    });
    expect(vendor.sends).toEqual([]);
  });

  it("refuses a message with an attachment, rather than sending its text alone", async () => {
    const failure = await runHarnessTurn(
      options({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "what is in this picture?" },
              { type: "image", image: "data:image/png;base64,iVBORw0KGgo=" },
            ],
          },
        ],
      }),
      "none",
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WebClientTurnRefusedError);
    expect(failure).toMatchObject({
      kind: "setting-unsupported",
      message:
        "Claude web can only send text to claude.ai, so it can't take attachments. Remove the attachment or choose another client.",
    });
    expect(vendor.sends).toEqual([]);
  });
});

describe("a page that stops after a call reached the server", { timeout: 90_000 }, () => {
  it("fails the run and keeps the call on the turn's trace, on an errored step", async () => {
    const fixture = createFixtureWebPageModule(vendor.url);
    setWebClientEnvironment({
      ...environment,
      pageModule: {
        ...fixture,
        async readConversation() {
          throw new Error("The saved chat could not be read.");
        },
      },
    });
    const failure = await runHarnessTurn(options(), "none").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WebClientRunError);
    expect(toolCalls()).toHaveLength(1);
    const { failure: stopped, turnTrace } = failure as WebClientRunError;
    expect(stopped).toMatchObject({ kind: "driver", step: "read_conversation" });
    expect(turnTrace).toMatchObject({ promptIndex: 0, finishReason: "error" });
    expect(turnTrace?.spans.map((span) => [span.category, span.status, span.toolName, span.serverId])).toEqual([
      ["step", "error", undefined, undefined],
      ["tool", "ok", "echo", "orders"],
    ]);
    expect(turnTrace?.spans[1]).toMatchObject({ wireCorroborated: true, evidenceStatus: "complete" });
  });
});

describe("a Stop while the reply is coming", { timeout: 90_000 }, () => {
  it("ends the turn as aborted, not as a failed run", async () => {
    const stop = new AbortController();
    const fixture = createFixtureWebPageModule(vendor.url);
    setWebClientEnvironment({
      ...environment,
      pageModule: {
        ...fixture,
        async replySignals() {
          stop.abort();
          return { finished: false, signals: [] };
        },
      },
    });
    const result = await runHarnessTurn(options({ abortSignal: stop.signal }), "none");
    expect(result).toMatchObject({ aborted: true });
    expect(result.messageHistory).toEqual(options().messages);
  });
});

describe("a failure that quotes the turn's connector", { timeout: 90_000 }, () => {
  it("surfaces neither the connector's URL nor its id, and keeps the step and the rest", async () => {
    const fixture = createFixtureWebPageModule(vendor.url);
    let typed = "";
    setWebClientEnvironment({
      ...environment,
      pageModule: {
        ...fixture,
        async ensureConnector(_driver, connector) {
          typed = connector.url;
          // Playwright's fill timeout quotes the value it was filling.
          throw new Error(`locator.fill: Timeout 1000ms exceeded.\nCall log:\n  - fill("${connector.url}")`);
        },
      },
    });
    const failure = await runHarnessTurn(options(), "none").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WebClientRunError);
    const { message, failure: stopped } = failure as WebClientRunError;
    expect(typed).toContain(CONNECTOR_ID);
    expect(stopped).toMatchObject({ kind: "driver", step: "connector" });
    for (const text of [message, stopped.message]) {
      expect(text).toContain('Timeout 1000ms exceeded.\nCall log:\n  - fill("[connector URL]")');
      expect(text).not.toContain(typed);
      expect(text).not.toContain(CONNECTOR_ID);
    }
  });

  it("takes the connector's id out of an error it passes on, stack included", async () => {
    setWebClientEnvironment({
      ...environment,
      async openBrowser() {
        const error = new Error(`No browser for connector ${CONNECTOR_ID}.`);
        // A stack read once keeps the message it was read with.
        void error.stack;
        throw error;
      },
    });
    const failure = await runHarnessTurn(options(), "none").catch((error: unknown) => error);
    expect((failure as Error).message).toBe("No browser for connector [connector id].");
    expect((failure as Error).stack).not.toContain(CONNECTOR_ID);
  });
});

describe("webConnectorName", () => {
  it("gives two servers whose names start alike their own connector, under MCPJam's prefix", () => {
    // The same first 24 characters.
    const east = webConnectorName("Payments API - production east");
    const west = webConnectorName("Payments API - production west");
    expect(east).not.toBe(west);
    for (const name of [east, west]) {
      expect(name.startsWith("MCPJam ")).toBe(true);
      expect(name.length).toBeLessThanOrEqual(31);
    }
    expect(webConnectorName("orders")).toBe(webConnectorName("orders"));
  });
});
