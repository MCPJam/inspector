/**
 * In-memory stand-ins for the launch engine's ports: a backend that records
 * every call, a launcher whose outcomes a test scripts per item, and timers
 * the test drives by hand. The swarm adapter's tests use them too.
 */
import { vi } from "vitest";
import { ConvexError } from "convex/values";
import type { RunGroupLaunchBackend } from "../backend.js";
import type { RunGroupLaunchPorts } from "../ports.js";
import type { PlannedItem, RunGroupLaunchRecord } from "../types.js";

export const REQUEST_BEARER = "request-bearer";
export const RUN_BEARER = "run-bearer";
export const NOW = 1_000_000;

type Call = { fn: string; bearer: string; args: Record<string, unknown> };

export type LaunchOutcome = "ok" | "deduped" | Error;

export function recordOf<P>(
  items: PlannedItem<P>[],
  overrides: Partial<RunGroupLaunchRecord<P>> = {},
): RunGroupLaunchRecord<P> {
  return {
    kind: "swarm",
    runGroupId: "sr_new",
    swarmId: "swarm-1",
    sourceRunGroupId: "sr_source",
    state: "launching",
    createdAt: 1,
    items: items.map((item) => ({
      ...item,
      launchKey: `swarm-launch:${item.itemKey}`,
      status: "pending" as const,
    })),
    ...overrides,
  };
}

export const leaseLost = () =>
  new ConvexError({ code: "LEASE_LOST", message: "This launch moved on." });

export interface FakeBackendOptions<P> {
  /** What `getByKey` finds. */
  recorded?: RunGroupLaunchRecord<P> | null;
  /** Overrides `begin`; by default it inserts and claims. */
  begin?: (
    args: Parameters<RunGroupLaunchBackend<P>["begin"]>[0],
  ) => Awaited<ReturnType<RunGroupLaunchBackend<P>["begin"]>>;
  resume?: (
    args: Parameters<RunGroupLaunchBackend<P>["resume"]>[0],
  ) => Awaited<ReturnType<RunGroupLaunchBackend<P>["resume"]>>;
  /** Makes a write throw. */
  failWrite?: (fn: string, args: Record<string, unknown>) => Error | undefined;
}

/** The ports with a recording backend and hand-driven timers. */
export function createFakePorts<P>(options: FakeBackendOptions<P> = {}) {
  const calls: Call[] = [];
  let ticks: Array<() => void> = [];
  let background: Promise<void> | undefined;
  const write =
    (fn: string, bearer: string) =>
    async (args: Record<string, unknown>): Promise<void> => {
      calls.push({ fn, bearer, args });
      const failure = options.failWrite?.(fn, args);
      if (failure) throw failure;
    };
  const backend = (bearer: string): RunGroupLaunchBackend<P> => ({
    getByKey: async (args) => {
      calls.push({ fn: "getByKey", bearer, args });
      return options.recorded ?? null;
    },
    begin: async (args) => {
      calls.push({ fn: "begin", bearer, args });
      return (
        options.begin?.(args) ?? {
          record: recordOf(args.items),
          replayed: false,
          claimed: true,
          generation: 1,
        }
      );
    },
    resume: async (args) => {
      calls.push({ fn: "resume", bearer, args });
      if (!options.resume) throw new Error("resume was not scripted");
      return options.resume(args);
    },
    recordItem: write("recordItem", bearer),
    heartbeat: write("heartbeat", bearer),
    finish: write("finish", bearer),
  });
  const ports: RunGroupLaunchPorts<P> = {
    backend,
    sleep: vi.fn(async () => undefined),
    every: vi.fn((_ms: number, tick: () => void) => {
      ticks.push(tick);
      return () => {
        ticks = ticks.filter((t) => t !== tick);
      };
    }),
    holdDrain: vi.fn((work: Promise<void>) => {
      background = work;
    }),
    now: () => NOW,
  };
  return {
    ports,
    calls,
    callsTo: (fn: string) => calls.filter((call) => call.fn === fn),
    /** The items recorded with `status`, in order. */
    recorded: (status: string) =>
      calls
        .filter((c) => c.fn === "recordItem" && c.args.status === status)
        .map((c) => c.args.itemKey),
    lastFinish: () => calls.filter((c) => c.fn === "finish").at(-1)?.args,
    heartbeat: () => ticks.forEach((tick) => tick()),
    heartbeatRunning: () => ticks.length > 0,
    /** Settles the background launch, if one was handed to the drain. */
    settle: async () => {
      await background;
    },
  };
}

/** A launcher whose outcome a test scripts per item; unscripted attempts succeed. */
export function createLauncher(script: Record<string, LaunchOutcome[]> = {}) {
  // Copied by hand: structuredClone would turn each error into a plain Error.
  const outcomes = Object.fromEntries(
    Object.entries(script).map(([key, list]) => [key, [...list]]),
  );
  const launches: Array<{ key: string; bearer: string; detail?: unknown }> = [];
  const held = new Set<string>();
  const gates = new Map<string, () => void>();
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    launches,
    keys: () => launches.map((launch) => launch.key),
    maxInFlight: () => maxInFlight,
    hold: (key: string) => held.add(key),
    release: (key: string) => {
      held.delete(key);
      gates.get(key)?.();
      gates.delete(key);
    },
    async launch(
      key: string,
      bearer: string,
      detail?: unknown,
    ): Promise<{ runId: string; deduped?: boolean }> {
      launches.push({ key, bearer, detail });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (held.has(key)) {
          await new Promise<void>((resolve) => gates.set(key, resolve));
        }
        const outcome = outcomes[key]?.shift() ?? "ok";
        if (outcome instanceof Error) throw outcome;
        return {
          runId: `run-${key}`,
          ...(outcome === "deduped" ? { deduped: true } : {}),
        };
      } finally {
        inFlight -= 1;
      }
    },
  };
}
