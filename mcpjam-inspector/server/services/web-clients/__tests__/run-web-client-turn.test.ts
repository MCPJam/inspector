/**
 * The web client runtime on the fixture vendor, with a stand-in for the
 * forwarding endpoint (`test/support/web-clients/stand-in-endpoint.ts`):
 * how the turn opens and closes its windows, binds the approval gate, reads
 * the ledger and builds the trace, and how a run that stops on the page ends
 * as a failure of the run.
 *
 * Evidence: fixture. The end to end test with the real endpoint is
 * `web-client-e2e.test.ts`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright";
import { MCPClientManager } from "@mcpjam/sdk";
import { SYNTHETIC_SESSION_APPROVAL_DENIAL } from "@/shared/tool-approval";
import { startFixtureUpstream, type FixtureUpstream } from "../../../test/support/web-clients/fixture-upstream";
import { startFixtureVendor, type FixtureVendor } from "../../../test/support/web-clients/fixture-vendor";
import { startStandInEndpoint, type StandInEndpoint } from "../../../test/support/web-clients/stand-in-endpoint";
import { createMemorySendJournal } from "../../../utils/harness/real-ui/drive-turn";
import { createFixtureWebPageModule } from "../../../utils/harness/real-ui/fixture-web";
import { createPlaywrightDriver } from "../../../utils/harness/real-ui/playwright-driver";
import { runHarnessTurn } from "../../../utils/harness/run-harness-turn";
import type { MCPJamHandlerOptions } from "../../../utils/mcpjam-stream-handler";
import {
  createInMemoryToolCallLedger,
  webClientToolCallLedger,
  type ToolCallLedger,
} from "../tool-call-ledger";
import {
  createInMemoryTurnWindowStore,
  webClientTurnWindows,
  type TurnWindowStore,
} from "../turn-windows";
import { runWebClientTurn, webTurnApprover, type WebTurnApproval } from "../run-web-client-turn";
import { setWebClientEnvironment, type WebClientEnvironment } from "../web-client-environment";
import { WebClientRunError, webClientFailureEvidenceOf } from "../web-client-harness-turn";

let browser: Browser;
let vendor: FixtureVendor;
let upstream: FixtureUpstream;
let endpoint: StandInEndpoint;
let windows: TurnWindowStore;
let ledger: ToolCallLedger;

beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser.close();
});
beforeEach(async () => {
  vendor = await startFixtureVendor();
  upstream = await startFixtureUpstream();
  windows = createInMemoryTurnWindowStore();
  ledger = createInMemoryToolCallLedger();
  endpoint = await startStandInEndpoint({
    upstreamOf: (connectorId) => (connectorId === "conn-orders" ? upstream.url : undefined),
    windows,
    ledger,
  });
});
afterEach(async () => {
  setWebClientEnvironment(undefined);
  await endpoint.close();
  await vendor.close();
  await upstream.close();
});

function environment(): WebClientEnvironment {
  return {
    publicBaseUrl: endpoint.url,
    journal: createMemorySendJournal(),
    pageModule: createFixtureWebPageModule(vendor.url),
    async resolveAccount() {
      return { webAccountId: "account-1", accountEmail: "runner@example.com" };
    },
    async ensureConnector({ serverId }) {
      return { connectorId: `conn-${serverId}` };
    },
    async openBrowser({ sites }) {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${vendor.url}/sign-in?as=runner@example.com`);
      return { driver: await createPlaywrightDriver(page, { sites }), close: () => context.close() };
    },
  };
}

const ALLOW: WebTurnApproval = { requireToolApproval: false, answer: "deny" };

function turn(approval: WebTurnApproval = ALLOW) {
  return runWebClientTurn({
    runtimeId: "claude-web",
    projectId: "project-1",
    serverIds: ["orders"],
    prompt: "say hello",
    runId: "run-1",
    approval,
    environment: environment(),
    turnWindows: windows,
    ledger,
    stepTimeoutMs: 10_000,
    replyTimeoutMs: 20_000,
  });
}

describe("runWebClientTurn", { timeout: 90_000 }, () => {
  it("opens a window per connector, reads the ledger and matches calls by tool use id", async () => {
    const result = await turn();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.conversation.replyText).toBe("echo said: echo: say hello");
    expect(result.toolCalls).toEqual([
      expect.objectContaining({
        toolName: "echo",
        match: "tool-use-id",
        serverId: "orders",
        state: "result",
        toolUseId: result.page.conversation.toolCalls[0]!.toolUseId,
      }),
    ]);
    const [entry] = ledger.forTurn(result.turnId);
    expect(entry).toMatchObject({ connectorId: "conn-orders", runId: "run-1", state: "result" });
    // The window closed with the turn: a late call finds no turn to run in.
    expect(windows.active("conn-orders")).toBeUndefined();
    const call = upstream.received.find((r) => r.method === "tools/call");
    expect(call?.params).toMatchObject({ name: "echo", arguments: { message: "say hello" } });
  });

  it("stops as turn_running when another run has the connector, and leaves its window alone", async () => {
    // Two compared runs, or two Playground panes, on one account and server.
    windows.open({ connectorId: "conn-orders", runId: "run-0", turnId: "other-turn", approve: async () => ({ allow: true }) });
    const openBrowser = vi.fn();
    const result = await runWebClientTurn({
      runtimeId: "claude-web",
      projectId: "project-1",
      serverIds: ["orders"],
      prompt: "say hello",
      runId: "run-1",
      approval: ALLOW,
      environment: { ...environment(), openBrowser },
      turnWindows: windows,
      ledger,
    });
    expect(result).toMatchObject({ ok: false, infrastructure: true, failure: { kind: "turn_running", step: "connector" } });
    expect(windows.active("conn-orders")?.turnId).toBe("other-turn");
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("lets MCPJam's gate refuse a call before it reaches the server", async () => {
    const result = await turn({ requireToolApproval: true, answer: "deny" });
    expect(result.ok).toBe(true);
    expect(upstream.received.some((r) => r.method === "tools/call")).toBe(false);
    if (result.ok) {
      // The app shows a call the server never received.
      expect(result.toolCalls).toEqual([
        expect.objectContaining({ toolName: "echo", match: "narration-only" }),
      ]);
    }
  });

  it("ends a run stopped by a human check as the run's failure, with its step", async () => {
    vendor.challenge = true;
    const result = await turn();
    expect(result).toMatchObject({
      ok: false,
      infrastructure: true,
      failure: { kind: "needs_sign_in", reason: "human_check" },
      pendingStep: { stepId: "sign_in_check" },
    });
    expect(vendor.sends).toEqual([]);
    expect(windows.active("conn-orders")).toBeUndefined();
  });
});

describe("webTurnApprover", () => {
  const call = {
    connectorId: "c",
    turnId: "t",
    jsonrpcId: 1,
    toolName: "echo",
    arguments: {},
  };
  it("follows the turn's approval policy", async () => {
    expect(await webTurnApprover({ requireToolApproval: false, answer: "person" })(call)).toEqual({ allow: true });
    expect(await webTurnApprover({ requireToolApproval: true, answer: "deny" })(call)).toEqual({
      allow: false,
      reason: SYNTHETIC_SESSION_APPROVAL_DENIAL,
    });
    expect(
      await webTurnApprover({
        requireToolApproval: true,
        answer: "person",
        askPerson: async () => ({ allow: true }),
      })(call),
    ).toEqual({ allow: true });
    expect((await webTurnApprover({ requireToolApproval: true, answer: "person" })(call)).allow).toBe(false);
  });
});

describe("the harness lifecycle", { timeout: 90_000 }, () => {
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

  /** The real endpoint reads the process-wide stores, so the stand-in does too. */
  async function useProcessStores() {
    await endpoint.close();
    endpoint = await startStandInEndpoint({
      upstreamOf: (id) => (id === "conn-orders" ? upstream.url : undefined),
      windows: webClientTurnWindows,
      ledger: webClientToolCallLedger,
    });
    setWebClientEnvironment({ ...environment(), publicBaseUrl: endpoint.url });
  }

  it("runs an eval iteration through runHarnessTurn and persists its trace", async () => {
    await useProcessStores();
    const persisted: unknown[] = [];
    const result = await runHarnessTurn(
      options({ onConversationComplete: (history, trace) => void persisted.push({ history, trace }) }),
      "none",
    );
    const assistant = result.messageHistory.at(-1);
    expect(assistant).toMatchObject({
      role: "assistant",
      content: [
        expect.objectContaining({
          type: "tool-call",
          toolName: "echo",
          providerOptions: { mcpjam: expect.objectContaining({ webClientMatch: "tool-use-id" }) },
        }),
        { type: "text", text: "echo said: echo: say hello" },
      ],
    });
    expect(result.turnTrace?.harnessMcpAtTurn).toMatchObject({
      upstream: "harness",
      delivery: "mcp-endpoint",
      forwarding: { kind: "pass-through" },
    });
    expect(result.turnTrace?.spans.find((span) => span.category === "tool")).toMatchObject({
      toolName: "echo",
      serverId: "orders",
      outputSource: "evidence",
      wireCorroborated: true,
    });
    expect(persisted).toHaveLength(1);
  });

  it("opens a new chat for every iteration", async () => {
    await useProcessStores();
    await runHarnessTurn(options({ evalIterationId: "iteration-1" }), "none");
    await runHarnessTurn(options({ evalIterationId: "iteration-2" }), "none");
    expect(vendor.sends).toEqual(["say hello", "say hello"]);
    expect(vendor.chats.size).toBe(2);
  });

  it("fails the run, not the server, when the page stops it", async () => {
    setWebClientEnvironment(environment());
    vendor.challenge = true;
    const failure = await runHarnessTurn(options(), "none").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WebClientRunError);
    expect(failure).toMatchObject({
      infrastructure: true,
      failure: { kind: "needs_sign_in", reason: "human_check" },
      message: expect.stringContaining("Sign in again"),
    });
    // An eval iteration reads this as the run's failure, out of the pass rate.
    expect(webClientFailureEvidenceOf(failure)).toEqual({ source: "web_client", code: "needs_sign_in" });
    expect(webClientFailureEvidenceOf(new Error("the server failed"))).toBeUndefined();
  });

  it("fails the run, not the server, when another run has the connector", async () => {
    await useProcessStores();
    webClientTurnWindows.open({ connectorId: "conn-orders", runId: "run-0", turnId: "other-turn", approve: async () => ({ allow: true }) });
    try {
      const failure = await runHarnessTurn(options(), "none").catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(WebClientRunError);
      expect(failure).toMatchObject({
        failure: { kind: "turn_running", step: "connector" },
        message: "Another run is already using this connector. Wait for it to finish, then send again.",
      });
      expect(webClientFailureEvidenceOf(failure)).toEqual({ source: "web_client", code: "turn_running" });
      expect(vendor.sends).toEqual([]);
    } finally {
      webClientTurnWindows.close("other-turn");
    }
  });

  it("refuses to start when this server has no web client environment", async () => {
    await expect(runHarnessTurn(options(), "none")).rejects.toThrow(/isn't set up on this server/);
  });
});
