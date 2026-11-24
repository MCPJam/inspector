/**
 * Recovery against fixtures: the in-memory reconnect backend standing in for
 * the durable one, the in-memory tool-call ledger, an upstream server that
 * counts every tool it runs, and a scripted runtime that records what each run
 * did. A "process" is one coordinator; a restart is a new one over the same
 * backend and ledger.
 */
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
import {
  WebBackendRefusal,
  type PendingStep,
  type WebIdentity,
  type WebReconnectBackend,
} from "../backend.js";
import {
  classifyRunFailure,
  createWebRecoveryCoordinator,
  type AccountBrowser,
  type RunFailure,
  type SignInMethod,
  type WebRecoveryCoordinator,
} from "../coordinator.js";
import {
  createInMemoryWebReconnectBackend,
  type WebReconnectNotice,
} from "../in-memory-backend.js";
import { reconcileWithLedger, type LedgerReader } from "../reconcile.js";

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
/** Stands in for a browser profile archive. Nothing real. */
const PROFILE_TEXT = "fixture-profile";
const PROFILE = new TextEncoder().encode(PROFILE_TEXT);

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
  /** The model's reply to the step, as the runtime read it. */
  reply?: string;
  step?: PendingStep;
  restoredProfileVersion: number;
  browser: AccountBrowser;
};

type World = ReturnType<typeof createWorld>;

function createWorld(signInMethod?: SignInMethod) {
  const notices: WebReconnectNotice[] = [];
  return {
    backend: createInMemoryWebReconnectBackend(
      [
        {
          webAccountId: ACCOUNT,
          projectId: PROJECT,
          status: "ready",
          ...SEAT,
          profileVersion: 1,
        },
      ],
      (notice) => {
        notices.push(notice);
      },
    ),
    ledger: createInMemoryToolCallLedger(),
    /** One entry per tool the upstream server actually ran. */
    upstream: [] as string[],
    /** The vendor's saved conversations: the model's reply, by run. */
    conversation: new Map<string, string>(),
    notices,
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
    ...(method ? { signInMethodFor: () => method } : {}),
    resumeRun: async ({ runId, pendingStep }) => {
      const run = runOf(world, runId);
      run.log.push(`resume ${pendingStep.stepId}`);
      run.restoredProfileVersion = (await accountOf(world)).profileVersion;
      world.inFlight.push(execute(world, coordinator, run, pendingStep, true));
      return true;
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
    jsonrpcId: "1",
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
    // The model has the tool's result and replies in its conversation.
    world.conversation.set(run.runId, `Created the note ${run.runId}.`);
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
        // The model already replied, so the reply is read, not asked for again.
        run.reply = world.conversation.get(run.runId);
        run.result = "completed from the vendor's conversation";
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

/**
 * The first thing in a logged value that must not be there: a profile
 * archive (any typed array), or a string holding the profile or a seat's
 * address. Looks at every depth, at keys, and at an error's message, stack
 * and cause, which `JSON.stringify` leaves out.
 */
function leakIn(value: unknown, seen = new Set<object>()): string | undefined {
  if (typeof value === "string") {
    return [PROFILE_TEXT, SEAT.accountEmail, OTHER_SEAT.accountEmail].find(
      (secret) => value.includes(secret),
    );
  }
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return "a profile archive";
  }
  const parts: unknown[] = Object.entries(value).flat();
  if (value instanceof Error) {
    parts.push(value.message, value.stack, value.cause);
  }
  for (const part of parts) {
    const leak = leakIn(part, seen);
    if (leak) return leak;
  }
  return undefined;
}

afterEach(() => {
  // Profiles and seat addresses never reach the logs.
  expect(leakIn(logged)).toBeUndefined();
  logged.length = 0;
});

describe("the log check", () => {
  it("finds a profile or a seat's address at any depth, errors included", () => {
    expect(leakIn([["done", { runId: "run-1" }]])).toBeUndefined();
    expect(
      leakIn([["saved", { run: { profile: { archive: PROFILE } } }]]),
    ).toBe("a profile archive");
    expect(
      leakIn([["failed", new Error(`signed in as ${SEAT.accountEmail}`)]]),
    ).toBe(SEAT.accountEmail);
    const cause = new Error(`signed in as ${SEAT.accountEmail}`);
    expect(leakIn([["failed", new Error("refused", { cause })]])).toBe(
      SEAT.accountEmail,
    );
  });
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
    expect(request).toMatchObject({
      status: "open",
      waitingRunCount: 2,
      notificationCount: 1,
      notifiedAt: expect.any(Number),
    });
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
      expect(again).toMatchObject({ status: "paused" });
    }
    const [request] = await requestsOf(world);
    expect(world.notices).toHaveLength(1);
    expect(request?.waitingRunCount).toBe(2);

    await coordinator.handback({
      projectId: PROJECT,
      requestId: request?.requestId ?? "",
      browserFor: () => browserSignedInAs(SEAT),
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
        browserFor: () => browserSignedInAs(SEAT),
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
          browserFor: () => browserSignedInAs(SEAT),
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
        browserFor: () => intruder,
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
        browserFor: () => browserSignedInAs(otherWorkspace),
      }),
    ).toMatchObject({ status: "wrong_identity" });
    expect(
      await coordinator.handback({
        projectId: PROJECT,
        requestId,
        browserFor: () => browserSignedInAs(undefined),
      }),
    ).toEqual({ status: "not_signed_in" });
    expect(
      await coordinator.handback({
        projectId: PROJECT,
        requestId: "no-such-request",
        browserFor: () => browserSignedInAs(SEAT),
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
      browserFor: () => browserSignedInAs(SEAT),
    });
    await settle(world);
    expect(accepted).toMatchObject({ status: "resumed" });
    expect(runOf(world, "run-1").log).toEqual([...PAUSED, ...RESUMED_AND_SENT]);
    expect(world.upstream).toEqual(["run-1"]);
  });

  it("records the seat a new account is first handed back with, then holds it", async () => {
    const world = createWorld();
    // No one has signed this account in yet: it has no seat and no profile.
    world.backend = createInMemoryWebReconnectBackend([
      {
        webAccountId: ACCOUNT,
        projectId: PROJECT,
        status: "needs_sign_in",
        profileVersion: 0,
      },
    ]);
    const coordinator = startProcess(world);
    await startRun(world, coordinator, "run-1", ["sign_in_page"], {
      restoredProfileVersion: 0,
    });
    const [request] = await requestsOf(world);

    const accepted = await coordinator.handback({
      projectId: PROJECT,
      requestId: request?.requestId ?? "",
      browserFor: () => browserSignedInAs(SEAT),
    });
    await settle(world);
    expect(accepted).toMatchObject({ status: "resumed" });
    expect(runOf(world, "run-1").log).toEqual([...PAUSED, ...RESUMED_AND_SENT]);
    expect(await accountOf(world)).toMatchObject({
      status: "ready",
      ...SEAT,
      profileVersion: 1,
    });

    // The recorded seat holds from then on.
    await startRun(world, coordinator, "run-2", ["sign_in_page"]);
    const [next] = await requestsOf(world);
    expect(
      await coordinator.handback({
        projectId: PROJECT,
        requestId: next?.requestId ?? "",
        browserFor: () => browserSignedInAs(OTHER_SEAT),
      }),
    ).toEqual({
      status: "wrong_identity",
      expected: SEAT,
      observed: OTHER_SEAT,
    });
    expect(await accountOf(world)).toMatchObject({
      ...SEAT,
      profileVersion: 1,
    });
  });

  it("refuses a new account's handback once another seat was recorded after the account was read", async () => {
    const world = createWorld();
    // An admin verified OTHER_SEAT for the new account after this process
    // read it, so the process still reads the account with no seat.
    world.backend = createInMemoryWebReconnectBackend([
      {
        webAccountId: ACCOUNT,
        projectId: PROJECT,
        status: "needs_sign_in",
        ...OTHER_SEAT,
        profileVersion: 0,
      },
    ]);
    const readBefore: WebReconnectBackend = {
      ...world.backend,
      listWebAccounts: async (args) =>
        (await world.backend.listWebAccounts(args)).map(
          ({ accountEmail: _email, workspaceName: _workspace, ...account }) =>
            account,
        ),
    };
    const coordinator = startProcess(world, readBefore);
    await startRun(world, coordinator, "run-1", ["sign_in_page"], {
      restoredProfileVersion: 0,
    });
    const [request] = await requestsOf(world);

    expect(
      await coordinator.handback({
        projectId: PROJECT,
        requestId: request?.requestId ?? "",
        browserFor: () => browserSignedInAs(SEAT),
      }),
    ).toEqual({ status: "wrong_identity", observed: SEAT });
    expect((await requestsOf(world))[0]?.status).toBe("open");
    expect(runOf(world, "run-1").log).toEqual(PAUSED);
    expect(await accountOf(world)).toMatchObject(OTHER_SEAT);
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

  it("resumes the other claimed runs when resuming one throws before it starts", async () => {
    const world = createWorld();
    const coordinator = startProcess(world);
    await startRun(world, coordinator, "run-1", ["sign_in_page"]);
    await startRun(world, coordinator, "run-2", ["sign_in_page"]);
    const [request] = await requestsOf(world);
    await world.backend.handbackWebReconnect({
      requestId: request?.requestId ?? "",
      verifiedAccountEmail: SEAT.accountEmail,
      verifiedWorkspace: SEAT.workspaceName,
    });
    const started: string[] = [];
    const sweeper = createWebRecoveryCoordinator({
      backend: world.backend,
      ledger: world.ledger,
      // Not async, so its throw comes before any promise.
      resumeRun: ({ runId }) => {
        if (runId === "run-1") throw new Error("resume refused");
        started.push(runId);
        return Promise.resolve(true);
      },
    });

    const resumed = await sweeper.resumeWaiting(ACCOUNT);

    expect(resumed.map((run) => [run.runId, run.status])).toEqual([
      ["run-1", "failed"],
      ["run-2", "resumed"],
    ]);
    expect(started).toEqual(["run-2"]);
  });

  it("keeps the account ready when a wrong seat's check ends after a valid handback", async () => {
    const world = createWorld();
    const coordinator = startProcess(world);
    await startRun(world, coordinator, "run-1", ["sign_in_page"]);
    const [request] = await requestsOf(world);
    const requestId = request?.requestId ?? "";
    let finishCheck = () => {};
    const checking = new Promise<void>((resolve) => {
      finishCheck = resolve;
    });
    const slowIntruder = {
      verifyAccount: vi.fn(async () => {
        await checking;
        return OTHER_SEAT;
      }),
      captureProfile: vi.fn(async () => PROFILE),
    };

    const refused = coordinator.handback({
      projectId: PROJECT,
      requestId,
      browserFor: () => slowIntruder,
    });
    await vi.waitFor(() =>
      expect(slowIntruder.verifyAccount).toHaveBeenCalled(),
    );
    const accepted = await coordinator.handback({
      projectId: PROJECT,
      requestId,
      browserFor: () => browserSignedInAs(SEAT),
    });
    finishCheck();
    expect(await refused).toMatchObject({ status: "wrong_identity" });
    await settle(world);

    expect(accepted).toMatchObject({ status: "resumed" });
    expect(slowIntruder.captureProfile).not.toHaveBeenCalled();
    expect(await accountOf(world)).toMatchObject({
      status: "ready",
      profileVersion: 2,
    });
    expect(runOf(world, "run-1").log).toEqual([...PAUSED, ...RESUMED_AND_SENT]);
  });

  it("reloads without a second link when a handback lands between a run's read and its report", async () => {
    const world = createWorld();
    const coordinator = startProcess(world);
    await startRun(world, coordinator, "run-1", ["sign_in_page"]);
    const [request] = await requestsOf(world);
    // run-2 read the account as waiting for a person; the person hands it
    // back before run-2's report arrives.
    const late: WebReconnectBackend = {
      ...world.backend,
      reportWebSignInRequired: async (args) => {
        await coordinator.handback({
          projectId: PROJECT,
          requestId: request?.requestId ?? "",
          browserFor: () => browserSignedInAs(SEAT),
        });
        return world.backend.reportWebSignInRequired(args);
      },
    };
    const lateProcess = startProcess(world, late);
    await startRun(world, lateProcess, "run-2", ["sign_in_page"], {
      restoredProfileVersion: 1,
    });
    await settle(world);

    expect(runOf(world, "run-2").log).toEqual([
      "send step-1",
      "signed_out page",
      "reload_profile",
      "reconcile: send",
      "send step-1",
      "tool ran upstream",
    ]);
    expect(world.notices).toHaveLength(1);
    expect(await requestsOf(world)).toHaveLength(1);
    expect(await accountOf(world)).toMatchObject({
      status: "ready",
      profileVersion: 2,
    });
    expect(world.upstream.sort()).toEqual(["run-1", "run-2"]);
  });
});

describe("a tool call runs once across recovery", () => {
  it("reads a lost reply from the vendor's conversation instead of running the tool again", async () => {
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
    expect(runOf(world, "run-1").result).toBe(
      "completed from the vendor's conversation",
    );
    expect(runOf(world, "run-1").reply).toBe("Created the note run-1.");
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
          jsonrpcId: "1",
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
        jsonrpcId: "1",
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

  it("refuses a step with no turn and no connector to read", async () => {
    const ledger = createInMemoryToolCallLedger();
    const step = { stepId: "step-1", startedAt: new Date().toISOString() };

    // Nothing could show a forwarded call, so nothing may be sent again.
    await expect(
      reconcileWithLedger(ledger, { runId: "run-1", step }),
    ).rejects.toThrow("can't be checked against the ledger");
    await expect(
      reconcileWithLedger(ledger, { runId: "run-1", connectorIds: [], step }),
    ).rejects.toThrow("can't be checked against the ledger");
  });

  it.each(["turn", "connector"] as const)(
    "keeps a call's answer when the %s read saw it before it settled",
    async (stale) => {
      const ledger = createInMemoryToolCallLedger();
      const step = {
        stepId: "step-1",
        startedAt: new Date().toISOString(),
        turnId: "turn-1",
      };
      const call = ledger.forwarded({
        connectorId: CONNECTOR,
        runId: "run-1",
        turnId: step.turnId,
        jsonrpcId: "1",
        toolName: "create_note",
        argsHash: hashPayload({ title: "run-1" }),
      });
      // One read runs before the call settles, the other after.
      const before = ledger.forTurn(step.turnId);
      ledger.settle(call.id, { state: "result", upstreamStatus: 200 });
      const reader: LedgerReader = {
        find: (match) => (stale === "connector" ? before : ledger.find(match)),
        forTurn: (turnId) =>
          stale === "turn" ? before : ledger.forTurn(turnId),
      };

      expect(
        await reconcileWithLedger(reader, {
          runId: "run-1",
          connectorIds: [CONNECTOR],
          step,
        }),
      ).toEqual({
        status: "reconciled",
        calls: [expect.objectContaining({ id: call.id, state: "result" })],
      });
    },
  );
});

describe("sign-in method", () => {
  /** A sign-in method that signs in only when the test releases it. */
  function gatedSignIn() {
    let open = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
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
    const browser = (): AccountBrowser => ({
      verifyAccount: async () => (signedIn ? SEAT : undefined),
      captureProfile: async () => PROFILE,
    });
    return { method, browser, release: () => open() };
  }

  it("signs in once, without a link, for every run that fails meanwhile", async () => {
    const signIn = gatedSignIn();
    const world = createWorld(signIn.method);
    const coordinator = startProcess(world);
    const first = startRun(world, coordinator, "run-1", ["sign_in_page"], {
      browser: signIn.browser(),
    });
    await vi.waitFor(() =>
      expect(signIn.method.signIn).toHaveBeenCalledTimes(1),
    );
    // A second run reaches the sign-in page while the method is signing in.
    const second = startRun(world, coordinator, "run-2", ["sign_in_page"]);
    signIn.release();
    await Promise.all([first, second]);

    expect(signIn.method.signIn).toHaveBeenCalledTimes(1);
    expect(runOf(world, "run-1").log).toEqual([
      "send step-1",
      "signed_out page",
      "signed_in",
      "reconcile: send",
      "send step-1",
      "tool ran upstream",
    ]);
    // The other run's browser is still signed out: it reloads the new profile.
    expect(runOf(world, "run-2").log).toEqual([
      "send step-1",
      "signed_out page",
      "reload_profile",
      "reconcile: send",
      "send step-1",
      "tool ran upstream",
    ]);
    expect(world.notices).toEqual([]);
    expect(await requestsOf(world)).toEqual([]);
    expect(await accountOf(world)).toMatchObject({
      status: "ready",
      profileVersion: 2,
    });
    expect(world.upstream.sort()).toEqual(["run-1", "run-2"]);
  });

  it("signs a run in again, not reload, when the shared attempt saved the profile it failed on", async () => {
    const method = {
      id: "test-inbox",
      signIn: vi.fn(async () => "signed_in" as const),
    };
    const world = createWorld(method);
    // The first attempt's save lands, but its answer is slow.
    let answerSave = () => {};
    const slowAnswer = new Promise<void>((resolve) => {
      answerSave = resolve;
    });
    const slowSave: WebReconnectBackend = {
      ...world.backend,
      saveWebAccountProfile: async (args) => {
        const saved = await world.backend.saveWebAccountProfile(args);
        if (saved.profileVersion === 2) await slowAnswer;
        return saved;
      },
    };
    const coordinator = startProcess(world, slowSave);
    const report = (runId: string, restoredProfileVersion: number) =>
      coordinator.reportNeedsSignIn({
        projectId: PROJECT,
        webAccountId: ACCOUNT,
        runId,
        pendingStep: { stepId: "step-1", startedAt: new Date().toISOString() },
        reason: "signed_out",
        browser: browserSignedInAs(SEAT),
        restoredProfileVersion,
      });

    const first = report("run-1", 1);
    await vi.waitFor(async () =>
      expect((await accountOf(world)).profileVersion).toBe(2),
    );
    // run-2 restored that new profile and was signed out on it anyway, then
    // found the first attempt still running.
    const second = report("run-2", 2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    answerSave();

    expect(await first).toEqual({ status: "signed_in" });
    expect(await second).toEqual({ status: "signed_in" });
    expect(method.signIn).toHaveBeenCalledTimes(2);
    expect(await accountOf(world)).toMatchObject({
      status: "ready",
      profileVersion: 3,
    });
  });

  it("asks once, then lets later runs join the request without another attempt", async () => {
    const method = {
      id: "test-inbox",
      signIn: vi.fn(async () => "needs_person" as const),
    };
    const world = createWorld(method);
    const coordinator = startProcess(world);
    await startRun(world, coordinator, "run-1", ["sign_in_page"]);
    await startRun(world, coordinator, "run-2", ["sign_in_page"]);

    expect(method.signIn).toHaveBeenCalledTimes(1);
    expect(runOf(world, "run-2").log).toEqual(PAUSED);
    expect(world.notices).toHaveLength(1);
    expect((await requestsOf(world))[0]?.waitingRunCount).toBe(2);
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
    const report = async (runId: string, stepId: string) => {
      const reported = await backend.reportWebSignInRequired({
        webAccountId: ACCOUNT,
        runId,
        pendingStep: step(stepId),
        reason: "signed_out",
      });
      if (!("requestId" in reported)) throw new Error("No request opened.");
      return reported;
    };
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
    const handback = (verifiedAccountEmail: string, id = requestId) =>
      backend.handbackWebReconnect({
        requestId: id,
        verifiedAccountEmail,
        verifiedWorkspace: SEAT.workspaceName,
      });
    await expect(handback(OTHER_SEAT.accountEmail)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(handback(SEAT.accountEmail, "missing")).rejects.toThrow(
      WebBackendRefusal,
    );
    const resolved = { resumableRunIds: ["run-1", "run-2"] };
    expect(await handback("SEAT@example.com")).toEqual(resolved);
    expect(await handback(SEAT.accountEmail)).toEqual(resolved);

    const claims = await Promise.all([
      backend.claimResumableWebRuns({ webAccountId: ACCOUNT }),
      backend.claimResumableWebRuns({ webAccountId: ACCOUNT }),
    ]);
    // A run that reported twice keeps its first step, as the backend does.
    expect(
      claims.flat().map((run) => [run.runId, run.pendingStep.stepId]),
    ).toEqual([
      ["run-1", "step-1"],
      ["run-2", "step-1"],
    ]);
    const next = await report("run-1", "step-3");
    expect(next.shouldNotify).toBe(true);
    expect(next.requestId).not.toBe(requestId);
    await vi.waitFor(() => expect(world.notices).toHaveLength(2));

    const save = (expectedProfileVersion: number) =>
      backend.saveWebAccountProfile({
        webAccountId: ACCOUNT,
        expectedProfileVersion,
        profile: PROFILE,
      });
    expect(await save(1)).toEqual({ ok: true, profileVersion: 2 });
    expect(await save(1)).toEqual({
      ok: false,
      reason: "version_conflict",
      profileVersion: 2,
    });
  });

  it("compares the stored email trimmed, as sameWebIdentity does", async () => {
    const backend = createInMemoryWebReconnectBackend([
      {
        webAccountId: ACCOUNT,
        projectId: PROJECT,
        status: "ready",
        accountEmail: ` ${SEAT.accountEmail} `,
        profileVersion: 1,
      },
    ]);
    const reported = await backend.reportWebSignInRequired({
      webAccountId: ACCOUNT,
      runId: "run-1",
      pendingStep: { stepId: "step-1", startedAt: "2026-11-20T10:00:00.000Z" },
      reason: "signed_out",
    });
    if (!("requestId" in reported)) throw new Error("No request opened.");
    const handback = (verifiedAccountEmail: string) =>
      backend.handbackWebReconnect({
        requestId: reported.requestId,
        verifiedAccountEmail,
      });

    await expect(handback(OTHER_SEAT.accountEmail)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await handback(SEAT.accountEmail)).toEqual({
      resumableRunIds: ["run-1"],
    });
  });

  it("refuses the recorded email in another workspace, not the same seat written differently", async () => {
    const world = createWorld();
    const reported = await world.backend.reportWebSignInRequired({
      webAccountId: ACCOUNT,
      runId: "run-1",
      pendingStep: { stepId: "step-1", startedAt: "2026-11-20T10:00:00.000Z" },
      reason: "signed_out",
    });
    if (!("requestId" in reported)) throw new Error("No request opened.");
    const handback = (
      verifiedAccountEmail: string,
      verifiedWorkspace?: string,
    ) =>
      world.backend.handbackWebReconnect({
        requestId: reported.requestId,
        verifiedAccountEmail,
        ...(verifiedWorkspace ? { verifiedWorkspace } : {}),
      });

    for (const workspace of ["Another workspace", undefined]) {
      await expect(
        handback(SEAT.accountEmail, workspace),
      ).rejects.toMatchObject({ code: "CONFLICT" });
    }
    expect(await accountOf(world)).toMatchObject({
      status: "needs_sign_in",
      workspaceName: SEAT.workspaceName,
    });
    expect((await requestsOf(world))[0]?.status).toBe("open");
    expect(await handback(" SEAT@Example.com ", " test WORKSPACE ")).toEqual({
      resumableRunIds: ["run-1"],
    });
    expect(await accountOf(world)).toMatchObject({ status: "ready" });
  });
});
