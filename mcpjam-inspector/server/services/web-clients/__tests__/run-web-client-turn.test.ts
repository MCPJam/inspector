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
import { RealUiError } from "../../../utils/harness/real-ui/page-module";
import { createPlaywrightDriver } from "../../../utils/harness/real-ui/playwright-driver";
import { runHarnessTurn } from "../../../utils/harness/run-harness-turn";
import { logger } from "../../../utils/logger";
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
import {
  setWebClientEnvironment,
  type WebClientEnvironment,
  type WebTurnContext,
} from "../web-client-environment";
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

function turn(approval: WebTurnApproval = ALLOW, env: WebClientEnvironment = environment()) {
  return runWebClientTurn({
    runtimeId: "claude-web",
    projectId: "project-1",
    serverIds: ["orders"],
    prompt: "say hello",
    runId: "run-1",
    approval,
    environment: env,
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

  it("waits for another run's turn on the same connector, then runs", async () => {
    // Two compared runs, or two Playground panes, on one account and server.
    windows.open({ connectorId: "conn-orders", runId: "run-0", turnId: "other-turn", approve: async () => ({ allow: true }) });
    setTimeout(() => windows.close("other-turn"), 150);
    const result = await runWebClientTurn({
      runtimeId: "claude-web",
      projectId: "project-1",
      serverIds: ["orders"],
      prompt: "say hello",
      runId: "run-1",
      approval: ALLOW,
      environment: environment(),
      turnWindows: windows,
      ledger,
      stepTimeoutMs: 10_000,
      replyTimeoutMs: 20_000,
      connectorPollMs: 25,
    });
    expect(result.ok).toBe(true);
    expect(upstream.received.filter((r) => r.method === "tools/call")).toHaveLength(1);
  });

  it("stops as turn_running when the connector stays busy, and leaves the other turn's window alone", async () => {
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
      connectorWaitMs: 120,
      connectorPollMs: 25,
    });
    expect(result).toMatchObject({ ok: false, infrastructure: true, failure: { kind: "turn_running", step: "connector" } });
    expect(windows.active("conn-orders")?.turnId).toBe("other-turn");
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("ends the wait on a Stop as the run's cancellation, never as a busy connector", async () => {
    windows.open({
      connectorId: "conn-orders",
      runId: "run-0",
      turnId: "other-turn",
      approve: async () => ({ allow: true }),
    });
    const stop = new AbortController();
    const openBrowser = vi.fn();
    const onOutcome = vi.fn(async () => {});
    const result = runWebClientTurn({
      runtimeId: "claude-web",
      projectId: "project-1",
      serverIds: ["orders"],
      prompt: "say hello",
      runId: "run-1",
      approval: ALLOW,
      environment: { ...environment(), openBrowser, onOutcome },
      turnWindows: windows,
      ledger,
      signal: stop.signal,
      connectorPollMs: 25,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    stop.abort();
    await expect(result).rejects.toBe(stop.signal.reason);
    expect(windows.active("conn-orders")?.turnId).toBe("other-turn");
    expect(openBrowser).not.toHaveBeenCalled();
    expect(onOutcome).not.toHaveBeenCalled();
  });

  it("holds no window while another replica's turn has the connector", async () => {
    let refusals = 2;
    const heldWhileRefused: Array<string | undefined> = [];
    const close = vi.fn(async () => {});
    const result = await runWebClientTurn({
      runtimeId: "claude-web",
      projectId: "project-1",
      serverIds: ["orders"],
      prompt: "say hello",
      runId: "run-1",
      approval: ALLOW,
      environment: {
        ...environment(),
        turnGate: {
          async open() {
            if (refusals === 0) return;
            refusals -= 1;
            setTimeout(() => heldWhileRefused.push(windows.active("conn-orders")?.turnId), 5);
            throw new RealUiError({ kind: "turn_running", step: "connector", message: "Another run is already using this connector." });
          },
          close,
        },
      },
      turnWindows: windows,
      ledger,
      stepTimeoutMs: 10_000,
      replyTimeoutMs: 20_000,
      connectorPollMs: 25,
    });
    expect(result.ok).toBe(true);
    expect(heldWhileRefused).toEqual([undefined, undefined]);
    expect(windows.active("conn-orders")).toBeUndefined();
    expect(close).toHaveBeenCalled();
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

  it("keeps the turn's result when its browser won't close, and logs the close", async () => {
    vendor.challenge = true;
    const warn = vi.spyOn(logger, "warn");
    const env = environment();
    try {
      const result = await runWebClientTurn({
        runtimeId: "claude-web",
        projectId: "project-1",
        serverIds: ["orders"],
        prompt: "say hello",
        runId: "run-1",
        approval: ALLOW,
        environment: {
          ...env,
          async openBrowser(args) {
            const opened = await env.openBrowser(args);
            return {
              driver: opened.driver,
              async close() {
                await opened.close();
                throw new Error("The browser was already gone.");
              },
            };
          },
        },
        turnWindows: windows,
        ledger,
        stepTimeoutMs: 10_000,
        replyTimeoutMs: 20_000,
      });
      expect(result).toMatchObject({ ok: false, failure: { kind: "needs_sign_in", reason: "human_check" } });
      // The stop reason is in the message: the dev logger prints no fields.
      expect(warn).toHaveBeenCalledWith(
        "[web-clients] turn stopped: needs_sign_in at sign_in_check",
        expect.objectContaining({ kind: "needs_sign_in", step: "sign_in_check" }),
      );
      expect(warn).toHaveBeenCalledWith(
        "[web-clients] the turn's browser did not close",
        expect.objectContaining({ message: "The browser was already gone." }),
      );
    } finally {
      warn.mockRestore();
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

  it("keeps the completed turn when recording its outcome fails", async () => {
    const warn = vi.spyOn(logger, "warn");
    const result = await turn(ALLOW, {
      ...environment(),
      onOutcome: async () => {
        throw new Error("backend unavailable");
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.conversation.replyText).toBe("echo said: echo: say hello");
      expect(result.toolCalls).toEqual([expect.objectContaining({ toolName: "echo", state: "result" })]);
    }
    expect(warn).toHaveBeenCalledWith(
      "[web-clients] the turn's outcome could not be recorded on the account",
      expect.objectContaining({ ok: true, message: "backend unavailable" }),
    );
    warn.mockRestore();
  });

  it("keeps the turn's own failure when recording it fails", async () => {
    vendor.challenge = true;
    const result = await turn(ALLOW, {
      ...environment(),
      onOutcome: async () => {
        throw new Error("backend unavailable");
      },
    });
    expect(result).toMatchObject({
      ok: false,
      failure: { kind: "needs_sign_in", reason: "human_check" },
      pendingStep: { stepId: "sign_in_check" },
    });
  });

  it("records and returns the sign-in a run stopped on even when its durable close fails", async () => {
    vendor.challenge = true;
    const outcomes: unknown[] = [];
    let closes = 0;
    const result = await turn(ALLOW, {
      ...environment(),
      turnGate: {
        open: async () => {},
        close: async () => {
          closes += 1;
          if (closes === 1) throw new Error("backend unavailable");
        },
      },
      onOutcome: async (outcome) => void outcomes.push(outcome),
    });
    expect(result).toMatchObject({
      ok: false,
      infrastructure: true,
      failure: { kind: "needs_sign_in", reason: "human_check" },
      pendingStep: { stepId: "sign_in_check" },
    });
    expect(outcomes).toEqual([
      expect.objectContaining({ ok: false, failure: expect.objectContaining({ kind: "needs_sign_in" }) }),
    ]);
    expect(closes).toBe(2);
  });

  it("retries a durable close that failed without failing the turn, and closes the browser either way", async () => {
    const warn = vi.spyOn(logger, "warn");
    let closes = 0;
    const close = vi.fn(async (_turnId: string) => {
      closes += 1;
      if (closes === 1) throw new Error("backend unavailable");
    });
    const browserClosed = vi.fn();
    const outcomes: unknown[] = [];
    const base = environment();
    const result = await turn(ALLOW, {
      ...base,
      turnGate: { open: async () => {}, close },
      onOutcome: async (outcome) => void outcomes.push(outcome),
      async openBrowser(args) {
        const opened = await base.openBrowser(args);
        return {
          driver: opened.driver,
          close: async () => {
            browserClosed();
            await opened.close();
          },
        };
      },
    });
    // The turn ran, so it keeps its evidence and its report; a caller that
    // saw it fail would send the prompt again.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.page.conversation.replyText).toBe("echo said: echo: say hello");
      expect(result.toolCalls).toEqual([expect.objectContaining({ toolName: "echo", state: "result" })]);
    }
    expect(outcomes).toEqual([expect.objectContaining({ ok: true, webAccountId: "account-1" })]);
    expect(warn).toHaveBeenCalledWith(
      "[web-clients] the turn's durable window did not close",
      expect.objectContaining({ message: "backend unavailable" }),
    );
    expect(close).toHaveBeenCalledTimes(2);
    expect(close.mock.calls[1]).toEqual(close.mock.calls[0]);
    expect(browserClosed).toHaveBeenCalledTimes(1);
    expect(windows.active("conn-orders")).toBeUndefined();
    warn.mockRestore();
  });

  it("never lets a durable close that keeps failing replace the turn's result", async () => {
    const close = vi.fn(async () => {
      throw new Error("backend unavailable");
    });
    const result = await turn(ALLOW, { ...environment(), turnGate: { open: async () => {}, close } });
    expect(result.ok).toBe(true);
    expect(close).toHaveBeenCalledTimes(2);
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

  it("signs the reply it streams, so it stays in context when another client takes the chat", async () => {
    vi.stubEnv("VITE_MCPJAM_HOSTED_MODE", "true");
    vi.stubEnv("INSPECTOR_SERVICE_TOKEN", "service-token-with-enough-length");
    const { historyProvenanceContextFor, verifyAssistantText } = await import("../../../utils/history-provenance");
    try {
      await useProcessStores();
      const result = await runHarnessTurn(
        options({ sourceType: "direct", evalIterationId: undefined, chatSessionId: "chat-1" }),
        "ui",
      );
      const chunks = (await result.response!.text())
        .split("\n")
        .filter((line) => line.startsWith("data: {"))
        .map((line) => JSON.parse(line.slice("data: ".length)) as { type: string; providerMetadata?: { mcpjam?: { textSig?: string } } });
      const signature = chunks.find((chunk) => chunk.type === "text-end")?.providerMetadata?.mcpjam?.textSig;
      const chat = historyProvenanceContextFor("project-1", "chat-1")!;
      expect(verifyAssistantText(chat, "echo said: echo: say hello", signature)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
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

  it("ends a Stop during the connector wait as the person's, and opens no browser when the connector frees", async () => {
    const openBrowser = vi.fn();
    setWebClientEnvironment({ ...environment(), openBrowser });
    webClientTurnWindows.open({
      connectorId: "conn-orders",
      runId: "run-0",
      turnId: "other-turn",
      approve: async () => ({ allow: true }),
    });
    const stop = new AbortController();
    const result = runHarnessTurn(
      options({ abortSignal: stop.signal }),
      "none",
    );
    await new Promise((resolve) => setTimeout(resolve, 60));
    // The other run lets go of the connector just as this one is stopped.
    stop.abort();
    webClientTurnWindows.close("other-turn");
    await expect(result).resolves.toMatchObject({ aborted: true });
    expect(openBrowser).not.toHaveBeenCalled();
    expect(webClientTurnWindows.active("conn-orders")).toBeUndefined();
  });

  it("acts as the eval run's owner on its frozen accounts, one account on per iteration", async () => {
    const seen: WebTurnContext[] = [];
    setWebClientEnvironment(async (turn) => {
      seen.push(turn);
      throw new Error("recorded");
    });
    const run = { runId: "run-7", actor: { actorUserId: "owner-1" }, webAccountIds: ["acct-1", "acct-2"] };
    for (const evalIterationId of ["iteration-1", "iteration-1", "iteration-2"]) {
      await expect(runHarnessTurn(options({ webClientRun: run, evalIterationId }), "none")).rejects.toThrow("recorded");
    }
    expect(seen.map((turn) => [turn.actor, turn.runWebAccountIds])).toEqual([
      [{ actorUserId: "owner-1" }, ["acct-1", "acct-2"]],
      [{ actorUserId: "owner-1" }, ["acct-1", "acct-2"]],
      [{ actorUserId: "owner-1" }, ["acct-2", "acct-1"]],
    ]);
  });

  it("tells the run's account pool when the account needs sign-in", async () => {
    setWebClientEnvironment(environment());
    vendor.challenge = true;
    const onAccountLost = vi.fn();
    await expect(
      runHarnessTurn(options({ webClientRun: { runId: "swarm-1", webAccountIds: ["acct-1"], onAccountLost } }), "none"),
    ).rejects.toBeInstanceOf(WebClientRunError);
    expect(onAccountLost).toHaveBeenCalledWith(expect.stringContaining("needs sign-in"));
  });

  it("refuses to start when this server has no web client environment", async () => {
    await expect(runHarnessTurn(options(), "none")).rejects.toThrow(/isn't set up on this server/);
  });
});

describe("a turn on a connector another run holds", () => {
  it("tells the person to wait for that run, and files the stop as the run's failure", async () => {
    const { webClientFailureEvidenceOf, webClientFailureMessage } = await import("../web-client-harness-turn");
    const busy = { kind: "turn_running", step: "connector", message: "Another run is already using this connector." } as const;
    expect(webClientFailureMessage("Claude web", busy)).toBe(
      "Another run is already using this connector. Wait for it to finish, then send again.",
    );
    expect(webClientFailureEvidenceOf(new WebClientRunError(busy, "stopped"))).toEqual({ source: "web_client", code: "turn_running" });
    // Only a stop on the page is evidence; any other error says nothing about whose it was.
    expect(webClientFailureEvidenceOf(new Error("the server failed"))).toBeUndefined();
  });
});
