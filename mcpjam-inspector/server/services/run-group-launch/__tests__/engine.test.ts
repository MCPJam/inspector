/**
 * The launch engine's rules, once, against a fake adapter: every adopter
 * (swarms first, evals later) gets this behaviour for its items.
 */
import { describe, expect, it, vi } from "vitest";
import { ConvexError } from "convex/values";
import { ErrorCode, WebRouteError } from "../../../routes/web/errors.js";
import {
  isRunGroupRefusal,
  launchRunGroup,
  refusalOf,
  resumeRunGroup,
} from "../engine.js";
import type {
  ItemFailure,
  PlannedRunGroup,
  RunGroupLaunchAdapter,
  RunGroupLaunchOutcome,
  RunGroupRefusal,
} from "../types.js";
import {
  NOW,
  REQUEST_BEARER,
  RUN_BEARER,
  createFakePorts,
  createLauncher,
  leaseLost,
  recordOf,
  type FakeBackendOptions,
  type LaunchOutcome,
} from "./fakes.js";

type Params = { n: number };

/** An error whose failure class the fake adapter reads straight off it. */
class Refused extends WebRouteError {
  constructor(
    readonly failure: ItemFailure,
    status = 400,
    message = "This item can't launch.",
  ) {
    super(status, ErrorCode.VALIDATION_ERROR, message);
  }
}

const KEYS = ["a", "b", "c"];
const ITEMS = KEYS.map((itemKey, n) => ({ itemKey, params: { n } }));

interface Setup {
  script?: Record<string, LaunchOutcome[]>;
  concurrency?: RunGroupLaunchAdapter<Params>["concurrency"];
  backend?: FakeBackendOptions<Params>;
  plan?: PlannedRunGroup<Params> | RunGroupRefusal<Params>;
  items?: typeof ITEMS;
}

function setup(options: Setup = {}) {
  const fakes = createFakePorts<Params>(options.backend);
  const launcher = createLauncher(options.script);
  const adapter: RunGroupLaunchAdapter<Params> = {
    kind: "swarm",
    concurrency: options.concurrency ?? 1,
    launchItem: vi.fn((item, context) =>
      launcher.launch(item.itemKey, context.bearer, context),
    ),
    classifyError: (error) =>
      error instanceof Refused ? error.failure : "retry",
    describeError: (error) => ({
      message: error instanceof Error ? error.message : "failed",
    }),
  };
  const deps = {
    bearerToken: REQUEST_BEARER,
    getRunBearer: vi.fn(async () => RUN_BEARER),
  };
  const plan = vi.fn(
    async () =>
      options.plan ?? { items: options.items ?? ITEMS, swarmId: "swarm-1" },
  );
  const call = { adapter, projectId: "project-1", deps, ports: fakes.ports };
  return { fakes, launcher, adapter, deps, plan, call };
}

async function launch(options: Setup = {}) {
  const env = setup(options);
  const outcome = await launchRunGroup({
    ...env.call,
    idempotencyKey: "key-1",
    request: { what: "everything" },
    plan: env.plan,
  });
  await env.fakes.settle();
  return { ...env, outcome };
}

function refused<P>(outcome: RunGroupLaunchOutcome<P>): RunGroupRefusal<P> {
  if (!isRunGroupRefusal(outcome)) throw new Error("expected a refusal");
  return outcome;
}

const STOP = {
  stop: { status: 402, code: "credit", message: "Out of credit." },
};

describe.each([
  ["first", "a"],
  ["middle", "b"],
  ["last", "c"],
])("the decision table at the %s item", (_position, key) => {
  const index = KEYS.indexOf(key);

  it("item_failed fails that item, and the rest launch", async () => {
    const { fakes, outcome } = await launch({
      script: { [key]: [new Refused("item_failed")] },
    });
    expect(outcome.status).toBe(202);
    expect(fakes.recorded("failed")).toEqual([key]);
    expect(
      fakes.callsTo("recordItem").find((c) => c.args.status === "failed")?.args,
    ).toMatchObject({ error: { message: "This item can't launch." } });
    expect(fakes.recorded("started")).toEqual(KEYS.filter((k) => k !== key));
    expect(fakes.lastFinish()).toMatchObject({ state: "partial" });
  });

  it("stop stops the launch, leaving that item and the rest to a replay", async () => {
    const { fakes, launcher, outcome } = await launch({
      script: { [key]: [new Refused(STOP, 402, "Out of credit.")] },
    });
    expect(launcher.keys()).toEqual(KEYS.slice(0, index + 1));
    expect(fakes.recorded("not_started")).toEqual([key]);
    expect(fakes.lastFinish()).toMatchObject({
      state: "stopped",
      stopReason: STOP.stop,
    });
    if (index === 0) {
      const refusal = refused(outcome);
      expect(refusal.status).toBe(402);
      expect(refusal.record?.items.map((item) => item.status)).toEqual([
        "not_started",
        "not_started",
        "not_started",
      ]);
    } else {
      expect(outcome.status).toBe(202);
    }
  });

  it("wait waits that long and tries the same item again", async () => {
    const { fakes, launcher } = await launch({
      script: { [key]: [new Refused({ wait: 12_000 }, 429)] },
    });
    expect(fakes.ports.sleep).toHaveBeenCalledWith(12_000);
    expect(launcher.keys().filter((k) => k === key)).toHaveLength(2);
    expect(fakes.lastFinish()).toMatchObject({ state: "launched" });
  });

  it("retry backs off 1, 2 and 4 s, then stops the launch", async () => {
    const failure = () => new Error("socket hang up");
    const env = setup({
      script: { [key]: [failure(), failure(), failure(), failure()] },
    });
    const launched = launchRunGroup({
      ...env.call,
      request: {},
      plan: env.plan,
    });
    if (index === 0) {
      // Nothing started, and the error is not a route error: the route answers it.
      await expect(launched).rejects.toThrow("socket hang up");
    } else {
      expect((await launched).status).toBe(202);
    }
    await env.fakes.settle();
    expect(vi.mocked(env.fakes.ports.sleep).mock.calls).toEqual([
      [1000],
      [2000],
      [4000],
    ]);
    expect(env.launcher.keys().filter((k) => k === key)).toHaveLength(4);
    expect(env.fakes.lastFinish()).toMatchObject({
      state: "stopped",
      stopReason: { message: "socket hang up" },
    });
  });
});

describe("waits and stops", () => {
  it("stops instead of waiting past a minute, until the wait is over", async () => {
    const { fakes } = await launch({
      script: { b: [new Refused({ wait: 120_000 }, 429)] },
    });
    expect(fakes.ports.sleep).not.toHaveBeenCalled();
    expect(fakes.lastFinish()).toMatchObject({
      state: "stopped",
      retryAfterAt: NOW + 120_000,
    });
  });

  it("stops after waiting five times for one item", async () => {
    const wait = () => new Refused({ wait: 1_000 }, 429);
    const { fakes } = await launch({
      script: { b: [wait(), wait(), wait(), wait(), wait(), wait()] },
    });
    expect(fakes.ports.sleep).toHaveBeenCalledTimes(5);
    expect(fakes.lastFinish()).toMatchObject({ state: "stopped" });
  });

  it("keeps when a stop lifts, when the adapter knows", async () => {
    const { fakes } = await launch({
      script: { b: [new Refused({ ...STOP, retryAfterMs: 3_600_000 }, 429)] },
    });
    expect(fakes.lastFinish()).toMatchObject({ retryAfterAt: NOW + 3_600_000 });
  });

  it("holds what it records to the backend's bounds", async () => {
    const long = "x".repeat(600);
    const { fakes } = await launch({
      script: {
        b: [new Refused({ stop: { code: "c".repeat(80), message: long } })],
      },
    });
    const write = fakes
      .callsTo("recordItem")
      .find((c) => c.args.status === "not_started");
    expect((write?.args.error as { message: string }).message).toHaveLength(
      500,
    );
    expect((write?.args.error as { code: string }).code).toHaveLength(64);
    expect(write?.args.reason).toHaveLength(200);
  });

  it("answers with the first item's refusal when none can start", async () => {
    const { fakes, outcome } = await launch({
      script: {
        a: [new Refused("item_failed", 404, "Item a is gone.")],
        b: [new Refused("item_failed")],
        c: [new Refused("item_failed")],
      },
    });
    expect(refused(outcome)).toMatchObject({
      status: 404,
      error: { message: "Item a is gone." },
      record: { state: "failed" },
    });
    expect(fakes.lastFinish()).toMatchObject({ state: "failed" });
  });
});

describe("the launch", () => {
  it("plans and begins with the request bearer, then launches the rest as the run bearer", async () => {
    const { fakes, launcher, outcome } = await launch();
    expect(outcome.status).toBe(202);
    for (const fn of ["getByKey", "begin"]) {
      expect(fakes.callsTo(fn).map((c) => c.bearer)).toEqual([REQUEST_BEARER]);
    }
    expect(fakes.callsTo("begin")[0]?.args).toEqual({
      kind: "swarm",
      projectId: "project-1",
      swarmId: "swarm-1",
      idempotencyKey: "key-1",
      request: { what: "everything" },
      items: ITEMS,
    });
    expect(
      launcher.launches.map((l) => [
        l.key,
        l.bearer,
        (l.detail as { phase: string }).phase,
      ]),
    ).toEqual([
      ["a", REQUEST_BEARER, "request"],
      ["b", RUN_BEARER, "background"],
      ["c", RUN_BEARER, "background"],
    ]);
    expect(fakes.callsTo("finish")[0]).toMatchObject({
      bearer: RUN_BEARER,
      args: {
        kind: "swarm",
        runGroupId: "sr_new",
        generation: 1,
        state: "launched",
      },
    });
  });

  it("replies once the first item started, with the record as it stood", async () => {
    const env = setup();
    env.launcher.hold("b");
    const outcome = await launchRunGroup({
      ...env.call,
      request: {},
      plan: env.plan,
    });
    if (isRunGroupRefusal(outcome)) throw new Error("expected a launch");
    expect(outcome.record.items.map((item) => item.status)).toEqual([
      "started",
      "pending",
      "pending",
    ]);
    expect(env.fakes.ports.holdDrain).toHaveBeenCalledTimes(1);
    env.launcher.release("b");
    await env.fakes.settle();
  });

  it.each([
    ["a number", 4],
    [
      "a rule over the record's items",
      (items: readonly unknown[]) => (items.length > 5 ? 4 : 1),
    ],
  ])(
    "starts as many at once as its concurrency says, as %s",
    async (_n, concurrency) => {
      const keys = Array.from({ length: 10 }, (_, i) => `i${i}`);
      const env = setup({
        concurrency,
        items: keys.map((itemKey, n) => ({ itemKey, params: { n } })),
      });
      keys.slice(1).forEach((k) => env.launcher.hold(k));
      await launchRunGroup({ ...env.call, request: {}, plan: env.plan });
      await vi.waitFor(() => expect(env.launcher.launches).toHaveLength(5));
      for (const k of keys.slice(1)) {
        env.launcher.release(k);
        await vi.waitFor(() =>
          expect(env.fakes.recorded("started")).toContain(k),
        );
      }
      await env.fakes.settle();
      expect(env.launcher.maxInFlight()).toBe(4);
      expect(env.launcher.keys()).toEqual(keys);
    },
  );

  it("lets items already launching settle when one stops the launch", async () => {
    const keys = ["i1", "i2", "i3", "i4", "i5", "i6"];
    const env = setup({
      concurrency: 4,
      items: keys.map((itemKey, n) => ({ itemKey, params: { n } })),
      script: { i3: [new Refused(STOP, 402)] },
    });
    ["i2", "i4", "i5"].forEach((k) => env.launcher.hold(k));
    await launchRunGroup({ ...env.call, request: {}, plan: env.plan });
    await vi.waitFor(() =>
      expect(env.fakes.recorded("not_started")).toEqual(["i3"]),
    );
    ["i2", "i4", "i5"].forEach((k) => env.launcher.release(k));
    await env.fakes.settle();
    expect(env.launcher.keys()).toEqual(keys.slice(0, 5));
    expect(env.fakes.recorded("started")).toEqual(["i1", "i2", "i4", "i5"]);
    expect(env.fakes.lastFinish()).toMatchObject({ state: "stopped" });
  });

  it("records a start that replayed an earlier run as deduped", async () => {
    const { fakes } = await launch({ script: { b: ["deduped"] } });
    expect(
      fakes
        .callsTo("recordItem")
        .find((c) => c.args.itemKey === "b" && c.args.status === "started")
        ?.args,
    ).toMatchObject({ runId: "run-b", deduped: true });
  });

  it("heartbeats with its generation until the launch finishes", async () => {
    const env = setup();
    env.launcher.hold("b");
    await launchRunGroup({ ...env.call, request: {}, plan: env.plan });
    expect(env.fakes.heartbeatRunning()).toBe(true);
    env.fakes.heartbeat();
    await vi.waitFor(() =>
      expect(env.fakes.callsTo("heartbeat")[0]).toMatchObject({
        bearer: RUN_BEARER,
        args: { kind: "swarm", runGroupId: "sr_new", generation: 1 },
      }),
    );
    env.launcher.release("b");
    await env.fakes.settle();
    expect(env.fakes.heartbeatRunning()).toBe(false);
  });

  it("starts no more items, and leaves the record alone, once a write says LEASE_LOST", async () => {
    const { fakes, launcher } = await launch({
      backend: {
        failWrite: (fn, args) =>
          fn === "recordItem" && args.itemKey === "b" ? leaseLost() : undefined,
      },
    });
    expect(launcher.keys()).toEqual(["a"]);
    expect(fakes.callsTo("finish")).toEqual([]);
    expect(fakes.heartbeatRunning()).toBe(false);
  });

  it("launches on when a write fails for another reason", async () => {
    const { fakes, launcher } = await launch({
      backend: {
        failWrite: (fn, args) =>
          fn === "recordItem" && args.status === "starting"
            ? new Error("Convex is unavailable")
            : undefined,
      },
    });
    expect(launcher.keys()).toEqual(KEYS);
    expect(fakes.lastFinish()).toMatchObject({ state: "launched" });
  });
});

describe("refusals before the launch", () => {
  it("answers the adapter's own refusal from planning, and writes nothing", async () => {
    const plan = refusalOf<Params>(
      new WebRouteError(400, ErrorCode.VALIDATION_ERROR, "Nothing to launch."),
    );
    const { fakes, outcome } = await launch({ plan });
    expect(outcome).toEqual(plan);
    expect(fakes.callsTo("begin")).toEqual([]);
  });

  it.each([
    ["IDEMPOTENCY_KEY_REUSED", 409, "CONFLICT"],
    ["not_found", 404, "NOT_FOUND"],
  ])("answers begin's %s as %i", async (code, status, routeCode) => {
    const { outcome } = await launch({
      backend: {
        begin: () => {
          throw new ConvexError({ code, message: "Refused by the backend." });
        },
      },
    });
    expect(refused(outcome)).toMatchObject({
      status,
      error: {
        code: routeCode,
        message: "Refused by the backend.",
        details: { code },
      },
    });
  });

  it("rethrows a failure that is not a refusal", async () => {
    const env = setup({
      backend: {
        begin: () => {
          throw new Error("Convex is down");
        },
      },
    });
    await expect(
      launchRunGroup({ ...env.call, request: {}, plan: env.plan }),
    ).rejects.toThrow("Convex is down");
  });
});

describe("replays and resuming", () => {
  const stopped = recordOf(ITEMS, { state: "stopped" });
  stopped.items = stopped.items.map((item, index) =>
    index === 0
      ? { ...item, status: "started" as const, runId: "run-a" }
      : { ...item, status: "not_started" as const },
  );
  const reclaimed = {
    record: {
      ...stopped,
      state: "launching" as const,
      items: stopped.items.map((item) =>
        item.status === "not_started"
          ? { ...item, status: "pending" as const }
          : item,
      ),
    },
    claimed: true,
    generation: 2,
  };

  it("replays a key from its record: no new plan, the record's items, its pending ones launched", async () => {
    const { fakes, launcher, plan } = await launch({
      backend: {
        recorded: stopped,
        begin: () => ({ ...reclaimed, replayed: true }),
      },
    });
    expect(plan).not.toHaveBeenCalled();
    expect(fakes.callsTo("begin")[0]?.args).toMatchObject({
      idempotencyKey: "key-1",
      request: { what: "everything" },
      items: ITEMS,
      swarmId: "swarm-1",
      sourceRunGroupId: "sr_source",
    });
    expect(launcher.keys()).toEqual(["b", "c"]);
    expect(
      fakes.callsTo("recordItem").every((c) => c.args.generation === 2),
    ).toBe(true);
    expect(fakes.lastFinish()).toMatchObject({
      state: "launched",
      generation: 2,
    });
  });

  it("answers a launch still running elsewhere with its record, and starts nothing", async () => {
    const running = recordOf(ITEMS);
    const { launcher, outcome, fakes } = await launch({
      backend: {
        recorded: running,
        begin: () => ({
          record: running,
          replayed: true,
          claimed: false,
          generation: 1,
        }),
      },
    });
    expect(outcome).toEqual({ status: 202, record: running });
    expect(launcher.launches).toEqual([]);
    expect(fakes.ports.every).not.toHaveBeenCalled();
  });

  it("resumes the caller's own launch by its id, launching what did not start", async () => {
    const env = setup({ backend: { resume: () => reclaimed } });
    const outcome = await resumeRunGroup({ ...env.call, runGroupId: "sr_new" });
    await env.fakes.settle();
    expect(outcome.status).toBe(202);
    expect(env.fakes.callsTo("resume")[0]).toMatchObject({
      bearer: REQUEST_BEARER,
      args: { kind: "swarm", projectId: "project-1", runGroupId: "sr_new" },
    });
    expect(env.launcher.keys()).toEqual(["b", "c"]);
    expect(env.fakes.lastFinish()).toMatchObject({ state: "launched" });
  });

  it("answers a resume it cannot claim with the record as it stands", async () => {
    const env = setup({
      backend: { resume: () => ({ record: stopped, claimed: false }) },
    });
    const outcome = await resumeRunGroup({ ...env.call, runGroupId: "sr_new" });
    expect(outcome).toEqual({ status: 202, record: stopped });
    expect(env.launcher.launches).toEqual([]);
  });
});
