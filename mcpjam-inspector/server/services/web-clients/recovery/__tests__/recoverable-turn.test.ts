/**
 * `runRecoverableWebTurn` over a scripted runtime: each environment queues
 * what its turn's tries return, the reconnect backend and the ledger are the
 * in-memory ones, and a handback goes through the coordinator with the
 * process's `resumeWebRun`, as the reconnect route sends it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const warned = vi.hoisted(() => vi.fn());
vi.mock("../../../../utils/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: warned, error: vi.fn() },
}));
const ran = vi.hoisted(() =>
  vi.fn<(input: WebClientTurnInput) => Promise<WebClientTurnResult>>(),
);
vi.mock("../../run-web-client-turn.js", () => ({ runWebClientTurn: ran }));

import { createMemorySendJournal } from "../../../../utils/harness/real-ui/drive-turn.js";
import { createFixtureWebPageModule } from "../../../../utils/harness/real-ui/fixture-web.js";
import type {
  PendingStep,
  RealUiFailure,
} from "../../../../utils/harness/real-ui/page-module.js";
import type { PageDriver } from "../../../../utils/harness/real-ui/page-driver.js";
import type {
  WebClientTurnInput,
  WebClientTurnResult,
} from "../../run-web-client-turn.js";
import { createInMemoryToolCallLedger } from "../../tool-call-ledger.js";
import type { WebClientEnvironment } from "../../web-client-environment.js";
import type { WebAccountRecord, WebIdentity } from "../backend.js";
import { createWebRecoveryCoordinator } from "../coordinator.js";
import { createInMemoryWebReconnectBackend } from "../in-memory-backend.js";
import { resumeWebRun } from "../paused-runs.js";
import { runRecoverableWebTurn, type WebRunStop } from "../turn-recovery.js";

const PROJECT = "project-1";
const STARTED_AT = Date.UTC(2026, 10, 20, 10);

const fakeDriver: PageDriver = {
  kind: "playwright",
  canEvaluate: false,
  playwrightSelectors: true,
  navigate: async () => {},
  url: async () => "https://claude.ai/new",
  evaluate: async () => {
    throw new Error("unused");
  },
  waitFor: async () => {},
  click: async () => {},
  type: async () => {},
  press: async () => {},
  readText: async () => undefined,
};

function failed(
  failure: RealUiFailure,
  pendingStep?: PendingStep,
): () => WebClientTurnResult {
  return () => ({
    ok: false,
    turnId: "turn-1",
    startedAt: STARTED_AT,
    endedAt: STARTED_AT + 1,
    infrastructure: true,
    failure,
    ...(pendingStep ? { pendingStep } : {}),
    toolCalls: [],
  });
}

const signedOut = failed({
  kind: "needs_sign_in",
  reason: "signed_out",
  step: "sign_in_check",
  message: "Signed out.",
});
const crashed = failed({
  kind: "driver",
  step: "new_chat",
  message: "The browser closed.",
});

function replied(): () => WebClientTurnResult {
  return () => ({
    ok: true,
    turnId: "turn-1",
    startedAt: STARTED_AT,
    endedAt: STARTED_AT + 1,
    page: {
      account: {},
      conversation: {
        conversationId: "chat-1",
        url: "https://claude.ai/chat/chat-1",
        replyText: "done",
        toolCalls: [],
      },
      approvalsAnswered: 0,
      finishedSignals: [],
      resumed: false,
    },
    toolCalls: [],
  });
}

/** What each environment's tries return, in order. */
const scripts = new Map<
  WebClientEnvironment,
  Array<() => WebClientTurnResult>
>();

const triesOf = (environment: WebClientEnvironment) =>
  ran.mock.calls.filter(([input]) => input.environment === environment).length;

function account(webAccountId: string, seat: WebIdentity): WebAccountRecord {
  return {
    webAccountId,
    projectId: PROJECT,
    vendor: "claude",
    status: "ready",
    ...seat,
    profileVersion: 1,
  };
}

/** A person's environment on their own account. */
function environmentOn(
  webAccountId: string,
  script: Array<() => WebClientTurnResult>,
  browser: { seat?: WebIdentity; close?: () => Promise<void> } = {},
): WebClientEnvironment {
  const environment: WebClientEnvironment = {
    publicBaseUrl: "https://inspector.example.test",
    journal: createMemorySendJournal(),
    pageModule: {
      ...createFixtureWebPageModule("https://claude.ai"),
      signedIn: async () => ({
        email: browser.seat?.accountEmail,
        workspace: browser.seat?.workspaceName,
      }),
    },
    resolveAccount: async () => ({ webAccountId }),
    ensureConnector: async () => ({ connectorId: "connector-1" }),
    async openBrowser() {
      // A browser that can save its profile offers `captureProfile`.
      const handle = {
        driver: fakeDriver,
        close: browser.close ?? (async () => {}),
        captureProfile: async () => new TextEncoder().encode("fixture-profile"),
      };
      return handle;
    },
  };
  scripts.set(environment, script);
  return environment;
}

/** Every Playground turn without a chat session has this run id. */
function playgroundTurn(
  environment: WebClientEnvironment,
  signal?: AbortSignal,
): WebClientTurnInput {
  return {
    runtimeId: "claude-web",
    projectId: PROJECT,
    serverIds: [],
    prompt: "hello",
    runId: "playground",
    approval: { requireToolApproval: false, answer: "person" },
    environment,
    ...(signal ? { signal } : {}),
  };
}

const SEAT_A = { accountEmail: "a@example.com", workspaceName: "A's team" };
const SEAT_B = { accountEmail: "b@example.com", workspaceName: "B's team" };

beforeEach(() => {
  scripts.clear();
  warned.mockClear();
  ran.mockReset();
  ran.mockImplementation(async ({ environment }) => {
    const next = scripts.get(environment)?.shift();
    if (!next) throw new Error("The script has no more tries.");
    return next();
  });
});

describe("runRecoverableWebTurn", () => {
  it("wakes only the paused Playground turn whose request was handed back", async () => {
    const backend = createInMemoryWebReconnectBackend([
      account("account-a", SEAT_A),
      account("account-b", SEAT_B),
    ]);
    const ledger = createInMemoryToolCallLedger();
    // A wake is the only way out of a pause here: no poll comes in time.
    const setup = { backendFor: () => backend, ledger, pollMs: 60_000 };
    const stopHeartbeatA = vi.fn();
    const stopHeartbeatB = vi.fn();
    const pausedOn = (stops: WebRunStop[], stopHeartbeat: () => void) =>
      (stop: WebRunStop) => {
        stops.push(stop);
        return stopHeartbeat;
      };
    const aPaused: WebRunStop[] = [];
    const bPaused: WebRunStop[] = [];
    const a = environmentOn("account-a", [signedOut, replied()]);
    const b = environmentOn("account-b", [signedOut, signedOut]);
    const stopB = new AbortController();

    // A's turn gives up after a few seconds unless the handback wakes it.
    const turnA = runRecoverableWebTurn(
      playgroundTurn(a),
      { ...setup, maxPauseMs: 4_000 },
      pausedOn(aPaused, stopHeartbeatA),
    );
    await vi.waitFor(() => expect(aPaused).toHaveLength(1));
    const turnB = runRecoverableWebTurn(
      playgroundTurn(b, stopB.signal),
      { ...setup, maxPauseMs: 60_000 },
      pausedOn(bPaused, stopHeartbeatB),
    );
    await vi.waitFor(() => expect(bPaused).toHaveLength(1));
    const [requestA, requestB] = [aPaused[0], bPaused[0]].map((stop) =>
      stop?.kind === "paused_for_person" ? stop.requestId : "",
    );
    expect(requestA).not.toBe(requestB);

    const handback = await createWebRecoveryCoordinator({
      backend,
      ledger,
      resumeRun: resumeWebRun,
    }).handback({
      projectId: PROJECT,
      requestId: requestA,
      browserFor: () => ({
        verifyAccount: async () => SEAT_A,
        captureProfile: async () => new Uint8Array(),
      }),
    });

    expect(handback).toEqual({
      status: "resumed",
      runs: [
        expect.objectContaining({
          requestId: requestA,
          runId: "playground",
          status: "resumed",
        }),
      ],
    });
    expect(await turnA).toMatchObject({ ok: true });
    expect(triesOf(a)).toBe(2);
    expect(stopHeartbeatA).toHaveBeenCalledOnce();
    expect(stopHeartbeatB).not.toHaveBeenCalled();
    // B's account is still signed out, so its turn still waits.
    expect(triesOf(b)).toBe(1);
    stopB.abort();
    expect(await turnB).toMatchObject({
      ok: false,
      stop: { kind: "paused_for_person", requestId: requestB },
    });
    expect(triesOf(b)).toBe(1);
    expect(stopHeartbeatB).toHaveBeenCalledOnce();
  });

  it("opens the account's sign-in request when the last try finds it signed out", async () => {
    const backend = createInMemoryWebReconnectBackend([
      account("account-a", SEAT_A),
    ]);
    const onPaused = vi.fn();
    const environment = environmentOn("account-a", [
      crashed,
      crashed,
      signedOut,
    ]);

    const result = await runRecoverableWebTurn(
      playgroundTurn(environment),
      { backendFor: () => backend, ledger: createInMemoryToolCallLedger() },
      onPaused,
    );

    expect(triesOf(environment)).toBe(3);
    const requests = await backend.listWebReconnectRequests({
      projectId: PROJECT,
    });
    expect(requests).toEqual([
      expect.objectContaining({ status: "open", waitingRunCount: 1 }),
    ]);
    expect(result).toMatchObject({
      ok: false,
      stop: {
        kind: "paused_for_person",
        requestId: requests[0]?.requestId,
      },
    });
    // No try is left to resume, so the turn doesn't wait for a handback.
    expect(onPaused).not.toHaveBeenCalled();
  });

  it("stops as ambiguous when the last try's call got no answer", async () => {
    const backend = createInMemoryWebReconnectBackend([
      account("account-a", SEAT_A),
    ]);
    const ledger = createInMemoryToolCallLedger();
    const timedOut = failed(
      { kind: "reply_timeout", step: "reply", message: "No reply." },
      {
        stepId: "reply",
        startedAt: new Date(STARTED_AT).toISOString(),
        turnId: "turn-1",
      },
    );
    const environment = environmentOn("account-a", [
      crashed,
      crashed,
      () => {
        // The tool reached the server on the last try, and no answer came.
        ledger.forwarded({
          connectorId: "connector-1",
          turnId: "turn-1",
          runId: "playground",
          jsonrpcId: "1",
          toolName: "create_note",
          argsHash: "args-hash",
        });
        return timedOut();
      },
    ]);

    const result = await runRecoverableWebTurn(playgroundTurn(environment), {
      backendFor: () => backend,
      ledger,
    });

    expect(triesOf(environment)).toBe(3);
    expect(result).toMatchObject({
      ok: false,
      stop: {
        kind: "ambiguous_execution",
        calls: [{ toolName: "create_note" }],
      },
    });
  });

  it("reports a call that got no answer when the last try pauses for sign-in", async () => {
    const backend = createInMemoryWebReconnectBackend([
      account("account-a", SEAT_A),
    ]);
    const ledger = createInMemoryToolCallLedger();
    const environment = environmentOn("account-a", [
      crashed,
      crashed,
      () => {
        // The tool reached the server, then the account signed out.
        ledger.forwarded({
          connectorId: "connector-1",
          turnId: "turn-1",
          runId: "playground",
          jsonrpcId: "1",
          toolName: "create_note",
          argsHash: "args-hash",
        });
        return signedOut();
      },
    ]);

    const result = await runRecoverableWebTurn(playgroundTurn(environment), {
      backendFor: () => backend,
      ledger,
    });

    expect(result).toMatchObject({
      ok: false,
      stop: {
        kind: "ambiguous_execution",
        calls: [{ toolName: "create_note" }],
      },
    });
    // The account still needs a person, so its request stays open.
    expect(
      await backend.listWebReconnectRequests({ projectId: PROJECT }),
    ).toEqual([expect.objectContaining({ status: "open" })]);
  });

  it("reports a call that got no answer when a pause ends without a handback", async () => {
    const backend = createInMemoryWebReconnectBackend([
      account("account-a", SEAT_A),
    ]);
    const ledger = createInMemoryToolCallLedger();
    const onPaused = vi.fn();
    const environment = environmentOn("account-a", [
      () => {
        ledger.forwarded({
          connectorId: "connector-1",
          turnId: "turn-1",
          runId: "playground",
          jsonrpcId: "1",
          toolName: "create_note",
          argsHash: "args-hash",
        });
        return signedOut();
      },
    ]);

    const result = await runRecoverableWebTurn(
      playgroundTurn(environment),
      { backendFor: () => backend, ledger, maxPauseMs: 50, pollMs: 60_000 },
      onPaused,
    );

    expect(onPaused).toHaveBeenCalledOnce();
    expect(triesOf(environment)).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      stop: {
        kind: "ambiguous_execution",
        calls: [{ toolName: "create_note" }],
      },
    });
  });

  it("wakes both paused Playground turns on one account when it's handed back", async () => {
    const backend = createInMemoryWebReconnectBackend([
      account("account-a", SEAT_A),
    ]);
    const ledger = createInMemoryToolCallLedger();
    // A wake is the only way out of a pause here: no poll comes in time.
    const setup = {
      backendFor: () => backend,
      ledger,
      pollMs: 60_000,
      maxPauseMs: 4_000,
    };
    const paused: WebRunStop[] = [];
    const first = environmentOn("account-a", [signedOut, replied()]);
    const second = environmentOn("account-a", [signedOut, replied()]);

    const firstTurn = runRecoverableWebTurn(
      playgroundTurn(first),
      setup,
      (stop) => {
        paused.push(stop);
      },
    );
    await vi.waitFor(() => expect(paused).toHaveLength(1));
    const secondTurn = runRecoverableWebTurn(
      playgroundTurn(second),
      setup,
      (stop) => {
        paused.push(stop);
      },
    );
    await vi.waitFor(() => expect(paused).toHaveLength(2));
    const [requestId, other] = paused.map((stop) =>
      stop.kind === "paused_for_person" ? stop.requestId : "",
    );
    expect(other).toBe(requestId);

    await createWebRecoveryCoordinator({
      backend,
      ledger,
      resumeRun: resumeWebRun,
    }).handback({
      projectId: PROJECT,
      requestId: requestId ?? "",
      browserFor: () => ({
        verifyAccount: async () => SEAT_A,
        captureProfile: async () => new Uint8Array(),
      }),
    });

    expect(await firstTurn).toMatchObject({ ok: true });
    expect(await secondTurn).toMatchObject({ ok: true });
    expect([triesOf(first), triesOf(second)]).toEqual([2, 2]);
  });

  it("starts a retried turn's trace at its first try", async () => {
    const backend = createInMemoryWebReconnectBackend([
      account("account-a", SEAT_A),
    ]);
    const environment = environmentOn("account-a", [
      crashed,
      () => ({ ...replied()(), startedAt: STARTED_AT + 5_000 }),
    ]);

    const result = await runRecoverableWebTurn(playgroundTurn(environment), {
      backendFor: () => backend,
      ledger: createInMemoryToolCallLedger(),
    });

    expect(result).toMatchObject({ ok: true, startedAt: STARTED_AT });
    expect(triesOf(environment)).toBe(2);
  });

  it("carries the turn on when the browser a sign-in used won't close", async () => {
    const backend = createInMemoryWebReconnectBackend([
      account("account-a", SEAT_A),
    ]);
    const environment = environmentOn("account-a", [signedOut, replied()], {
      seat: SEAT_A,
      close: async () => {
        throw new Error("The browser is already gone.");
      },
    });

    const result = await runRecoverableWebTurn(playgroundTurn(environment), {
      backendFor: () => backend,
      ledger: createInMemoryToolCallLedger(),
      // Signs the account in without a person, in the run's own browser.
      signInMethodFor: () => ({
        id: "test-inbox",
        signIn: async () => "signed_in",
      }),
    });

    expect(result).toMatchObject({ ok: true });
    expect(triesOf(environment)).toBe(2);
    expect(warned).toHaveBeenCalledWith(
      "[web-recovery] The account's browser did not close",
      expect.objectContaining({ message: "The browser is already gone." }),
    );
  });
});
