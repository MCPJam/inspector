/**
 * Recovery against fixtures: the in-memory reconnect backend standing in for
 * the durable one, the in-memory tool-call ledger, an upstream server that
 * counts every tool it runs, and a scripted runtime that records what each run
 * did. A "process" is one coordinator; a restart is a new one over the same
 * backend and ledger.
 */
import { ConvexHttpClient } from "convex/browser";
import { afterEach, describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => [] as unknown[][]);
vi.mock("../../../../utils/logger.js", () => ({
  logger: {
    debug: (...args: unknown[]) => logged.push(args),
    info: (...args: unknown[]) => logged.push(args),
    warn: (...args: unknown[]) => logged.push(args),
    error: (...args: unknown[]) => logged.push(args),
  },
}));

import {
  createInMemoryToolCallLedger,
  hashPayload,
} from "../../tool-call-ledger.js";
import type {
  PendingStep,
  WebIdentity,
  WebReconnectBackend,
} from "../backend.js";
import { createConvexWebReconnectBackend } from "../convex-backend.js";
import {
  classifyRunFailure,
  createWebRecoveryCoordinator,
  type AccountBrowser,
  type ReconnectNotice,
  type RunFailure,
  type SignInMethod,
  type WebRecoveryCoordinator,
} from "../coordinator.js";
import { createInMemoryWebReconnectBackend } from "../in-memory-backend.js";
import { reconcileWithLedger } from "../reconcile.js";

const PROJECT = "project-1";
const ACCOUNT = "web-account-1";
const CONNECTOR = "connector-1";
const SEAT: WebIdentity = {
  accountEmail: "seat@example.com",
  workspaceName: "Test workspace",
};
const OTHER_SEAT: WebIdentity = {
  accountEmail: "other-seat@example.com",
  workspaceName: "Test workspace",
};
/** Stands in for a serialized browser profile. Nothing real. */
const PROFILE = "fixture-profile";

/** What the vendor's site does when the runtime sends a step. */
type Behavior =
  /** The model calls the tool through the endpoint and replies. */
  | "reply"
  /** The tool runs and the endpoint records its answer, then the stream drops. */
  | "reply_lost"
  /** The tool runs, then the endpoint stops before it records the answer. */
  | "no_answer"
  | "sign_in_page"
  | "human_check"
  | "browser_crash"
  | "browser_asleep";

type FixtureRun = {
  runId: string;
  script: Behavior[];
  /** What the run did, in order, across restarts. */
  log: string[];
  result?: string;
  step?: PendingStep;
  restoredProfileVersion: number;
  browser: AccountBrowser;
};

type World = ReturnType<typeof createWorld>;

function createWorld(signInMethod?: SignInMethod) {
  return {
    backend: createInMemoryWebReconnectBackend([
      {
        webAccountId: ACCOUNT,
        projectId: PROJECT,
        status: "ready",
        ...SEAT,
        profileVersion: 1,
      },
    ]),
    ledger: createInMemoryToolCallLedger(),
    /** One entry per tool the upstream server actually ran. */
    upstream: [] as string[],
    notices: [] as ReconnectNotice[],
    runs: new Map<string, FixtureRun>(),
    inFlight: [] as Promise<void>[],
    signInMethod,
  };
}

function browserSignedInAs(identity: WebIdentity | undefined) {
  return {
    verifyAccount: vi.fn(async () => identity),
    captureProfile: vi.fn(async () => PROFILE),
  };
}

async function accountOf(world: World) {
  const [account] = await world.backend.listWebAccounts({
    projectId: PROJECT,
  });
  if (!account) throw new Error("The fixture account is missing.");
  return account;
}

const requestsOf = (world: World) =>
  world.backend.listWebReconnectRequests({ projectId: PROJECT });

function runOf(world: World, runId: string): FixtureRun {
  const run = world.runs.get(runId);
  if (!run) throw new Error(`The fixture has no run ${runId}.`);
  return run;
}

function stepOf(world: World, runId: string): PendingStep {
  const step = runOf(world, runId).step;
  if (!step) throw new Error(`Run ${runId} never sent a step.`);
  return step;
}

/** One process: a coordinator of its own over the world's durable state. */
function startProcess(
  world: World,
  backend: WebReconnectBackend = world.backend,
): WebRecoveryCoordinator {
  const method = world.signInMethod;
  const coordinator = createWebRecoveryCoordinator({
    backend,
    ledger: world.ledger,
    notify: async (notice) => {
      world.notices.push(notice);
    },
    ...(method ? { signInMethodFor: () => method } : {}),
    resumeRun: async (runId, pendingStep) => {
      const run = runOf(world, runId);
      run.log.push(`resume ${pendingStep.stepId}`);
      run.restoredProfileVersion = (await accountOf(world)).profileVersion;
      world.inFlight.push(execute(world, coordinator, run, pendingStep, true));
    },
  });
  return coordinator;
}

/** The vendor's site, when the runtime sends a step. */
function vendorTurn(
  world: World,
  run: FixtureRun,
  step: PendingStep,
): RunFailure | undefined {
  const behavior = run.script.shift() ?? "reply";
  if (behavior === "sign_in_page") {
    return { kind: "needs_sign_in", reason: "signed_out" };
  }
  if (behavior === "human_check") {
    return { kind: "needs_sign_in", reason: "human_check" };
  }
  if (behavior === "browser_crash") return { kind: "browser_crashed" };
  if (behavior === "browser_asleep") return { kind: "browser_asleep" };
  // The vendor's model calls the tool; the endpoint records it and forwards it.
  const entry = world.ledger.forwarded({
    connectorId: CONNECTOR,
    runId: run.runId,
    turnId: step.turnId,
    jsonrpcId: 1,
    toolName: "create_note",
    toolUseId: `toolu_${run.runId}`,
    argsHash: hashPayload({ title: run.runId }),
  });
  world.upstream.push(run.runId);
  run.log.push("tool ran upstream");
  if (behavior !== "no_answer") {
    world.ledger.settle(entry.id, {
      state: "result",
      upstreamStatus: 200,
      resultHash: hashPayload({ ok: true }),
    });
  }
  return behavior === "reply" ? undefined : { kind: "stream_dropped" };
}

/** The runtime's loop for one step: reconcile before any resend, then send. */
async function execute(
  world: World,
  coordinator: WebRecoveryCoordinator,
  run: FixtureRun,
  pendingStep: PendingStep,
  resending: boolean,
): Promise<void> {
  let step = pendingStep;
  let resend = resending;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (resend) {
      const verdict = await coordinator.reconcileBeforeResend({
        runId: run.runId,
        connectorIds: [CONNECTOR],
        step,
      });
      run.log.push(`reconcile: ${verdict.status}`);
      if (verdict.status === "reconciled") {
        run.result = "completed from the ledger";
        return;
      }
      if (verdict.status === "ambiguous_execution") {
        run.result = "stopped: ambiguous_execution";
        return;
      }
    }
    step = { ...step, turnId: `${run.runId}-turn-${run.log.length}` };
    run.step = step;
    run.log.push(`send ${step.stepId}`);
    const failure = vendorTurn(world, run, step);
    if (!failure) {
      run.result = "completed";
      return;
    }
    run.log.push(
      failure.kind === "needs_sign_in"
        ? `${failure.reason} page`
        : failure.kind,
    );
    const outcome = await coordinator.handleStepFailure({
      failure,
      projectId: PROJECT,
      webAccountId: ACCOUNT,
      runId: run.runId,
      pendingStep: step,
      browser: run.browser,
      restoredProfileVersion: run.restoredProfileVersion,
    });
    run.log.push(outcome.status);
    if (outcome.status === "paused") {
      run.result = "paused";
      return;
    }
    if (outcome.status === "reload_profile") {
      run.restoredProfileVersion = (await accountOf(world)).profileVersion;
    }
    resend = true;
  }
  run.result = "stopped: out of attempts";
}

function startRun(
  world: World,
  coordinator: WebRecoveryCoordinator,
  runId: string,
  script: Behavior[],
  options: { restoredProfileVersion?: number; browser?: AccountBrowser } = {},
): Promise<void> {
  const run: FixtureRun = {
    runId,
    script: [...script],
    log: [],
    restoredProfileVersion: options.restoredProfileVersion ?? 1,
    // The run's own browser shows the sign-in page, so no one is signed in.
    browser: options.browser ?? browserSignedInAs(undefined),
  };
  world.runs.set(runId, run);
  const step = { stepId: "step-1", startedAt: new Date().toISOString() };
  return execute(world, coordinator, run, step, false);
}

/** Waits for every run a resume started. */
async function settle(world: World) {
  while (world.inFlight.length > 0) {
    await Promise.all(world.inFlight.splice(0));
  }
}

const PAUSED = ["send step-1", "signed_out page", "paused"];
const RESUMED_AND_SENT = [
  "resume step-1",
  "reconcile: send",
  "send step-1",
  "tool ran upstream",
];

afterEach(() => {
  // Profiles, codes and seat addresses never reach the logs.
  const text = JSON.stringify(logged);
  expect(text).not.toContain(PROFILE);
  expect(text).not.toContain(SEAT.accountEmail);
  expect(text).not.toContain(OTHER_SEAT.accountEmail);
  logged.length = 0;
});

describe("web account recovery", () => {
  it("sends one reconnect link for two runs waiting on one account", async () => {
    const world = createWorld();
    const coordinator = startProcess(world);
    await Promise.all([
      startRun(world, coordinator, "run-1", ["sign_in_page"]),
      startRun(world, coordinator, "run-2", ["sign_in_page"]),
    ]);

    expect(runOf(world, "run-1").log).toEqual(PAUSED);
    expect(runOf(world, "run-2").log).toEqual(PAUSED);
    const [request, ...others] = await requestsOf(world);
    expect(others).toEqual([]);
    expect(request?.runs.map((run) => run.runId).sort()).toEqual([
      "run-1",
      "run-2",
    ]);
    expect(request?.notifiedAt).toEqual(expect.any(String));
    expect(world.notices).toEqual([
      {
        requestId: request?.requestId,
        projectId: PROJECT,
        webAccountId: ACCOUNT,
        reason: "signed_out",
      },
    ]);
    expect(await accountOf(world)).toMatchObject({ status: "needs_sign_in" });
    expect(world.upstream).toEqual([]);
  });

  it("doesn't send a second link for duplicate or stale expiry reports", async () => {
    const world = createWorld();
    const coordinator = startProcess(world);
    await Promise.all([
      startRun(world, coordinator, "run-1", ["sign_in_page"]),
      startRun(world, coordinator, "run-2", ["sign_in_page"]),
    ]);
    // Each run's report arrives again, as a retried request would.
    for (const run of world.runs.values()) {
      const again = await coordinator.reportNeedsSignIn({
        projectId: PROJECT,
        webAccountId: ACCOUNT,
        runId: run.runId,
        pendingStep: stepOf(world, run.runId),
        reason: "signed_out",
        browser: run.browser,
      });
      expect(again).toMatchObject({ status: "paused", notified: false });
    }
    const [request] = await requestsOf(world);
    expect(world.notices).toHaveLength(1);
    expect(request?.runs).toHaveLength(2);

    await coordinator.handback({
      projectId: PROJECT,
      requestId: request?.requestId ?? "",
      browser: browserSignedInAs(SEAT),
    });
    await settle(world);
    // A run that restored the expired profile before the handback reaches a
    // sign-in page only now: it reloads the saved profile and carries on.
    await startRun(world, coordinator, "run-3", ["sign_in_page"], {
      restoredProfileVersion: 1,
    });

    expect(runOf(world, "run-3").log).toEqual([
      "send step-1",
      "signed_out page",
      "reload_profile",
      "reconcile: send",
      "send step-1",
      "tool ran upstream",
    ]);
    expect(world.notices).toHaveLength(1);
    expect(await requestsOf(world)).toHaveLength(1);
    expect(world.upstream.sort()).toEqual(["run-1", "run-2", "run-3"]);
  });

  it("resumes each run exactly once across duplicate handbacks", async () => {
    const world = createWorld();
    const coordinator = startProcess(world);
    await Promise.all([
      startRun(world, coordinator, "run-1", ["sign_in_page"]),
      startRun(world, coordinator, "run-2", ["sign_in_page"]),
    ]);
    const [request] = await requestsOf(world);
    const handback = () =>
      coordinator.handback({
        projectId: PROJECT,
        requestId: request?.requestId ?? "",
        browser: browserSignedInAs(SEAT),
      });

    const outcomes = [...(await Promise.all([handback(), handback()]))];
    outcomes.push(await handback());
    await settle(world);

    const resumed = outcomes.flatMap((outcome) =>
      outcome.status === "resumed" ? outcome.runs : [],
    );
    expect(resumed.map((run) => [run.runId, run.status]).sort()).toEqual([
      ["run-1", "resumed"],
      ["run-2", "resumed"],
    ]);
    for (const runId of ["run-1", "run-2"]) {
      expect(runOf(world, runId).log).toEqual([...PAUSED, ...RESUMED_AND_SENT]);
      expect(runOf(world, runId).result).toBe("completed");
    }
    expect(world.upstream.sort()).toEqual(["run-1", "run-2"]);
    // The two concurrent handbacks raced to save; compare-and-set kept one.
    expect(await accountOf(world)).toMatchObject({
      status: "ready",
      profileVersion: 2,
    });
  });

  it.each([
    "saveWebAccountProfile",
    "markWebAccountVerified",
    "handbackWebReconnect",
    "claimResumableWebRuns",
  ] as const)(
    "resumes from durable state after a restart before %s",
    async (stopBefore) => {
      const world = createWorld();
      // The first process stops partway through the handback.
      const stopped: WebReconnectBackend = { ...world.backend };
      stopped[stopBefore] = async () => {
        throw new Error("process stopped");
      };
      const first = startProcess(world, stopped);
      await Promise.all([
        startRun(world, first, "run-1", ["sign_in_page"]),
        startRun(world, first, "run-2", ["sign_in_page"]),
      ]);
      const [request] = await requestsOf(world);
      const handback = (coordinator: WebRecoveryCoordinator) =>
        coordinator.handback({
          projectId: PROJECT,
          requestId: request?.requestId ?? "",
          browser: browserSignedInAs(SEAT),
        });
      await expect(handback(first)).rejects.toThrow("process stopped");
      expect(runOf(world, "run-1").log).toEqual(PAUSED);

      // A new process knows only what the backend recorded. It sweeps, and the
      // person opens the link again; between them each run resumes once.
      const second = startProcess(world);
      const swept = await second.resumeWaiting(ACCOUNT);
      const retried = await handback(second);
      await settle(world);

      const resumed = [
        ...swept,
        ...(retried.status === "resumed" ? retried.runs : []),
      ];
      expect(
        resumed.map((run) => [run.runId, run.pendingStep.stepId]).sort(),
      ).toEqual([
        ["run-1", "step-1"],
        ["run-2", "step-1"],
      ]);
      for (const runId of ["run-1", "run-2"]) {
        expect(runOf(world, runId).log).toEqual([
          ...PAUSED,
          ...RESUMED_AND_SENT,
        ]);
      }
      expect(await second.resumeWaiting(ACCOUNT)).toEqual([]);
      expect(world.upstream.sort()).toEqual(["run-1", "run-2"]);
      expect(world.notices).toHaveLength(1);
      expect(await accountOf(world)).toMatchObject({ status: "ready" });
    },
  );

  it("refuses a handback by another seat and keeps the account waiting", async () => {
    const world = createWorld();
    const coordinator = startProcess(world);
    const markNeedsSignIn = vi.spyOn(
      world.backend,
      "markWebAccountNeedsSignIn",
    );
    await startRun(world, coordinator, "run-1", ["sign_in_page"]);
    const [request] = await requestsOf(world);
    const requestId = request?.requestId ?? "";
    const intruder = browserSignedInAs(OTHER_SEAT);

    expect(
      await coordinator.handback({
        projectId: PROJECT,
        requestId,
        browser: intruder,
      }),
    ).toEqual({
      status: "wrong_identity",
      expected: SEAT,
      observed: OTHER_SEAT,
    });
    const otherWorkspace = { ...SEAT, workspaceName: "Another workspace" };
    expect(
      await coordinator.handback({
        projectId: PROJECT,
        requestId,
        browser: browserSignedInAs(otherWorkspace),
      }),
    ).toMatchObject({ status: "wrong_identity" });
    expect(
      await coordinator.handback({
        projectId: PROJECT,
        requestId,
        browser: browserSignedInAs(undefined),
      }),
    ).toEqual({ status: "not_signed_in" });
    expect(
      await coordinator.handback({
        projectId: PROJECT,
        requestId: "no-such-request",
        browser: browserSignedInAs(SEAT),
      }),
    ).toEqual({ status: "not_found" });

    expect(intruder.captureProfile).not.toHaveBeenCalled();
    expect(markNeedsSignIn).toHaveBeenCalledWith({
      webAccountId: ACCOUNT,
      reason: "wrong_account",
    });
    expect(await accountOf(world)).toMatchObject({
      status: "needs_sign_in",
      profileVersion: 1,
      accountEmail: SEAT.accountEmail,
    });
    expect((await requestsOf(world))[0]?.status).toBe("open");
    expect(runOf(world, "run-1").log).toEqual(PAUSED);

    // The right seat resumes the run, once.
    const accepted = await coordinator.handback({
      projectId: PROJECT,
      requestId,
      browser: browserSignedInAs(SEAT),
    });
    await settle(world);
    expect(accepted).toMatchObject({ status: "resumed" });
    expect(runOf(world, "run-1").log).toEqual([...PAUSED, ...RESUMED_AND_SENT]);
    expect(world.upstream).toEqual(["run-1"]);
  });

  it("doesn't open a sign-in request when only the browser failed", async () => {
    const world = createWorld();
    const coordinator = startProcess(world);
    await startRun(world, coordinator, "run-1", [
      "browser_crash",
      "browser_asleep",
    ]);

    expect(runOf(world, "run-1").log).toEqual([
      "send step-1",
      "browser_crashed",
      "reconnect_browser",
      "reconcile: send",
      "send step-1",
      "browser_asleep",
      "reconnect_browser",
      "reconcile: send",
      "send step-1",
      "tool ran upstream",
    ]);
    expect(runOf(world, "run-1").result).toBe("completed");
    expect(await requestsOf(world)).toEqual([]);
    expect(world.notices).toEqual([]);
    expect(await accountOf(world)).toMatchObject({
      status: "ready",
      profileVersion: 1,
    });
    expect(world.upstream).toEqual(["run-1"]);
    for (const kind of [
      "browser_crashed",
      "browser_asleep",
      "stream_dropped",
      "network_error",
      "page_timeout",
    ] as const) {
      expect(classifyRunFailure({ kind })).toBe("browser");
    }
    expect(
      classifyRunFailure({ kind: "needs_sign_in", reason: "signed_out" }),
    ).toBe("account");
  });
});

describe("a tool call runs once across recovery", () => {
  it("takes a lost result from the ledger instead of running the tool again", async () => {
    const world = createWorld();
    const coordinator = startProcess(world);
    await startRun(world, coordinator, "run-1", ["reply_lost"]);

    expect(runOf(world, "run-1").log).toEqual([
      "send step-1",
      "tool ran upstream",
      "stream_dropped",
      "reconnect_browser",
      "reconcile: reconciled",
    ]);
    expect(runOf(world, "run-1").result).toBe("completed from the ledger");
    expect(world.upstream).toEqual(["run-1"]);
    // A restarted process reads the same record.
    const verdict = await startProcess(world).reconcileBeforeResend({
      runId: "run-1",
      connectorIds: [CONNECTOR],
      step: stepOf(world, "run-1"),
    });
    expect(verdict).toEqual({
      status: "reconciled",
      calls: [
        expect.objectContaining({ toolName: "create_note", state: "result" }),
      ],
    });
  });

  it("stops the step when a forwarded call never got an answer", async () => {
    const world = createWorld();
    const coordinator = startProcess(world);
    await startRun(world, coordinator, "run-1", ["no_answer"]);

    expect(runOf(world, "run-1").log).toEqual([
      "send step-1",
      "tool ran upstream",
      "stream_dropped",
      "reconnect_browser",
      "reconcile: ambiguous_execution",
    ]);
    expect(runOf(world, "run-1").result).toBe("stopped: ambiguous_execution");
    expect(world.upstream).toEqual(["run-1"]);
    const verdict = await startProcess(world).reconcileBeforeResend({
      runId: "run-1",
      connectorIds: [CONNECTOR],
      step: stepOf(world, "run-1"),
    });
    expect(verdict).toEqual({
      status: "ambiguous_execution",
      calls: [
        expect.objectContaining({
          toolName: "create_note",
          state: "forwarded",
        }),
      ],
    });
  });

  it("reads only this run's calls since the step started, and the step's own turn", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const ledger = createInMemoryToolCallLedger();
      const call = (runId: string, turnId: string) =>
        ledger.forwarded({
          connectorId: CONNECTOR,
          runId,
          turnId,
          jsonrpcId: 1,
          toolName: "create_note",
          argsHash: hashPayload({ runId }),
        });
      vi.setSystemTime(new Date("2026-11-20T10:00:00.000Z"));
      ledger.settle(call("run-1", "turn-earlier").id, { state: "result" });
      const skewed = call("run-1", "turn-now");
      ledger.settle(skewed.id, { state: "result", upstreamStatus: 200 });
      vi.setSystemTime(new Date("2026-11-20T10:01:00.000Z"));
      ledger.settle(call("run-2", "turn-other").id, { state: "result" });
      const step = { stepId: "step-1", startedAt: new Date().toISOString() };
      const input = { runId: "run-1", connectorIds: [CONNECTOR], step };

      expect(await reconcileWithLedger(ledger, input)).toEqual({
        status: "send",
      });
      // This runtime's clock ran ahead of the ledger's; the turn still finds it.
      const sameTurn = { ...input, step: { ...step, turnId: "turn-now" } };
      expect(await reconcileWithLedger(ledger, sameTurn)).toEqual({
        status: "reconciled",
        calls: [expect.objectContaining({ id: skewed.id })],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["the result", { state: "result", upstreamStatus: 200 }, "reconciled"],
    [
      "the server's own error",
      { state: "error", upstreamStatus: 500 },
      "reconciled",
    ],
    [
      "a gateway timeout",
      { state: "error", upstreamStatus: 504 },
      "ambiguous_execution",
    ],
    ["a lost reply", { state: "lost" }, "ambiguous_execution"],
    ["no answer yet", undefined, "ambiguous_execution"],
  ] as const)("treats %s as %s", async (_label, outcome, expected) => {
    const ledger = createInMemoryToolCallLedger();
    const step = { stepId: "step-1", startedAt: new Date().toISOString() };
    const call = (toolUseId: string) =>
      ledger.forwarded({
        connectorId: CONNECTOR,
        runId: "run-1",
        jsonrpcId: 1,
        toolName: "create_note",
        toolUseId,
        argsHash: hashPayload({ toolUseId }),
      });
    // Another call of the step, left unanswered: narrowing by toolUseId skips it.
    ledger.settle(call("toolu_other").id, { state: "lost" });
    const mine = call("toolu_this");
    if (outcome) ledger.settle(mine.id, outcome);
    const verdict = await reconcileWithLedger(ledger, {
      runId: "run-1",
      connectorIds: [CONNECTOR],
      step,
      toolUseId: "toolu_this",
    });
    expect(verdict.status).toBe(expected);
  });
});

describe("sign-in method", () => {
  it("signs in once for every waiting run, without a link, when the method can", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signedIn = false;
    const method = {
      id: "test-inbox",
      signIn: vi.fn(async () => {
        await gate;
        signedIn = true;
        return "signed_in" as const;
      }),
    };
    const world = createWorld(method);
    const coordinator = startProcess(world);
    const runBrowser = (): AccountBrowser => ({
      verifyAccount: async () => (signedIn ? SEAT : undefined),
      captureProfile: async () => PROFILE,
    });
    const first = startRun(world, coordinator, "run-1", ["sign_in_page"], {
      browser: runBrowser(),
    });
    await vi.waitFor(() => expect(method.signIn).toHaveBeenCalledTimes(1));
    // A second run reaches the sign-in page while the method is signing in.
    await startRun(world, coordinator, "run-2", ["sign_in_page"], {
      browser: runBrowser(),
    });
    expect(runOf(world, "run-2").result).toBe("paused");
    release();
    await first;
    await settle(world);

    expect(method.signIn).toHaveBeenCalledTimes(1);
    expect(world.notices).toEqual([]);
    expect(runOf(world, "run-1").log).toEqual([
      "send step-1",
      "signed_out page",
      "signed_in",
      "reconcile: send",
      "send step-1",
      "tool ran upstream",
    ]);
    expect(runOf(world, "run-2").log).toEqual([...PAUSED, ...RESUMED_AND_SENT]);
    expect(await accountOf(world)).toMatchObject({
      status: "ready",
      profileVersion: 2,
    });
    expect(world.upstream.sort()).toEqual(["run-1", "run-2"]);
  });

  it("hands a human check to a person without calling the method", async () => {
    const method = {
      id: "test-inbox",
      signIn: vi.fn(async () => "signed_in" as const),
    };
    const world = createWorld(method);
    await startRun(world, startProcess(world), "run-1", ["human_check"]);

    expect(method.signIn).not.toHaveBeenCalled();
    expect(runOf(world, "run-1").log).toEqual([
      "send step-1",
      "human_check page",
      "paused",
    ]);
    expect(world.notices).toEqual([
      expect.objectContaining({ reason: "human_check" }),
    ]);
  });

  it.each([
    ["fails", async () => Promise.reject(new Error("inbox unreachable"))],
    ["signs in as another seat", async () => "signed_in" as const],
  ])("asks a person when the method %s", async (_label, signIn) => {
    const method = { id: "test-inbox", signIn: vi.fn(signIn) };
    const world = createWorld(method);
    await startRun(world, startProcess(world), "run-1", ["sign_in_page"], {
      browser: browserSignedInAs(OTHER_SEAT),
    });

    expect(runOf(world, "run-1").log).toEqual(PAUSED);
    expect(world.notices).toHaveLength(1);
    expect(await accountOf(world)).toMatchObject({
      status: "needs_sign_in",
      profileVersion: 1,
    });
  });
});

describe("in-memory reconnect backend", () => {
  it("keeps one open request per account, hands back once and claims each run once", async () => {
    const world = createWorld();
    const backend = world.backend;
    const step = (stepId: string) => ({
      stepId,
      startedAt: "2026-11-20T10:00:00.000Z",
    });
    const report = (runId: string, stepId: string) =>
      backend.reportWebSignInRequired({
        webAccountId: ACCOUNT,
        runId,
        pendingStep: step(stepId),
        reason: "signed_out",
      });
    const reports = [
      await report("run-1", "step-1"),
      await report("run-1", "step-2"),
      await report("run-2", "step-1"),
    ];
    expect(reports.map((one) => one.shouldNotify)).toEqual([
      true,
      false,
      false,
    ]);
    const requestId = reports[0]?.requestId ?? "";
    expect(new Set(reports.map((one) => one.requestId))).toEqual(
      new Set([requestId]),
    );
    expect(
      await backend.claimResumableWebRuns({ webAccountId: ACCOUNT }),
    ).toEqual([]);
    const handback = (verifiedAccountEmail: string) =>
      backend.handbackWebReconnect({
        requestId,
        verifiedAccountEmail,
        verifiedWorkspace: SEAT.workspaceName,
      });
    expect(await handback(OTHER_SEAT.accountEmail)).toEqual({
      status: "wrong_identity",
    });
    expect(await handback("SEAT@example.com")).toEqual({
      status: "handed_back",
    });
    expect(await handback(SEAT.accountEmail)).toEqual({
      status: "already_handed_back",
    });

    const claims = await Promise.all([
      backend.claimResumableWebRuns({ webAccountId: ACCOUNT }),
      backend.claimResumableWebRuns({ webAccountId: ACCOUNT }),
    ]);
    expect(
      claims.flat().map((run) => [run.runId, run.pendingStep.stepId]),
    ).toEqual([
      ["run-1", "step-2"],
      ["run-2", "step-1"],
    ]);
    const next = await report("run-1", "step-3");
    expect(next.shouldNotify).toBe(true);
    expect(next.requestId).not.toBe(requestId);

    const save = (expectedProfileVersion: number) =>
      backend.saveWebAccountProfile({
        webAccountId: ACCOUNT,
        expectedProfileVersion,
        profile: PROFILE,
      });
    expect(await save(1)).toEqual({ status: "saved", profileVersion: 2 });
    expect(await save(1)).toEqual({ status: "conflict", profileVersion: 2 });
  });
});

describe("Convex reconnect backend", () => {
  it("calls the backend's webClients functions with the acting bearer", async () => {
    const sent: Array<{ path: string; args: unknown; auth: string | null }> =
      [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const body = JSON.parse(String(init?.body));
      sent.push({
        path: `${String(input).split("/api/")[1]} ${body.path}`,
        args: body.args[0],
        auth: new Headers(init?.headers).get("authorization"),
      });
      const value = String(input).endsWith("/api/query") ? [] : null;
      return new Response(JSON.stringify({ status: "success", value }));
    };
    const convex = new ConvexHttpClient("https://fixture.convex.cloud", {
      fetch,
    });
    convex.setAuth("fixture-bearer");
    const backend = createConvexWebReconnectBackend(convex);
    const pendingStep = {
      stepId: "step-1",
      startedAt: "2026-11-20T10:00:00.000Z",
    };
    await backend.listWebAccounts({ projectId: PROJECT });
    await backend.listWebReconnectRequests({ projectId: PROJECT });
    await backend.reportWebSignInRequired({
      webAccountId: ACCOUNT,
      runId: "run-1",
      pendingStep,
      reason: "signed_out",
    });
    await backend.markWebReconnectNotified({ requestId: "request-1" });
    await backend.markWebAccountNeedsSignIn({
      webAccountId: ACCOUNT,
      reason: "signed_out",
    });
    await backend.saveWebAccountProfile({
      webAccountId: ACCOUNT,
      expectedProfileVersion: 1,
      profile: PROFILE,
    });
    await backend.markWebAccountVerified({ webAccountId: ACCOUNT, ...SEAT });
    await backend.handbackWebReconnect({
      requestId: "request-1",
      verifiedAccountEmail: SEAT.accountEmail,
    });
    await backend.claimResumableWebRuns({ webAccountId: ACCOUNT });

    expect(sent.map((call) => call.path)).toEqual([
      "query webClients:listWebAccounts",
      "query webClients:listWebReconnectRequests",
      "mutation webClients:reportWebSignInRequired",
      "mutation webClients:markWebReconnectNotified",
      "mutation webClients:markWebAccountNeedsSignIn",
      "mutation webClients:saveWebAccountProfile",
      "mutation webClients:markWebAccountVerified",
      "mutation webClients:handbackWebReconnect",
      "mutation webClients:claimResumableWebRuns",
    ]);
    expect(sent[2]?.args).toEqual({
      webAccountId: ACCOUNT,
      runId: "run-1",
      pendingStep,
      reason: "signed_out",
    });
    expect(new Set(sent.map((call) => call.auth))).toEqual(
      new Set(["Bearer fixture-bearer"]),
    );
  });
});
