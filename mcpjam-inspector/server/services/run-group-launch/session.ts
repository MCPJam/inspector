/**
 * Starting a claimed launch's items: the first inside the request, the rest
 * in the background once the caller has its reply.
 *
 * Every item goes the same way. Its record says `starting`, the adapter
 * launches it, and the record then says how that went. The adapter says what
 * kind of failure a failed start was; what happens next is the engine's, the
 * same for every adopter:
 *
 *   item_failed   the item fails and the launch goes on
 *   wait          wait and try the item again, up to MAX_WAIT_MS and
 *                 MAX_WAITS times; past either, the launch stops
 *   retry         try again after 1, 2, 4 s; after MAX_RETRIES, it stops
 *   stop          the launch stops: items already starting settle, and the
 *                 rest become `not_started`, so a replay or resume can start
 *                 them
 *
 * Before the reply the backend is reached with the request's bearer, after it
 * with a run bearer minted per call, since the request's token can expire long
 * before a large launch ends. Every write carries the record's generation; a
 * write refused with `LEASE_LOST` means the launch was stopped or resumed
 * elsewhere, and this one starts no more items and leaves the record alone.
 * A heartbeat keeps the record fresh, so the backend's sweep marks a launch
 * interrupted only once this process stopped working on it.
 */
import type { LaunchError } from "../../../shared/run-group-launch.js";
import { logger } from "../../utils/logger.js";
import { isLeaseLost, type RunGroupLaunchBackend } from "./backend.js";
import type { RunGroupLaunchPorts } from "./ports.js";
import {
  LaunchRecordState,
  type FinalLaunchState,
  type ItemUpdate,
} from "./record-state.js";
import type {
  ItemFailure,
  RunGroupLaunchAdapter,
  RunGroupLaunchDeps,
  RunGroupLaunchItem,
  RunGroupLaunchRecord,
} from "./types.js";

export const HEARTBEAT_MS = 15_000;
/** The longest wait a launch sits through in place. */
export const MAX_WAIT_MS = 60_000;
/** Waits one item sits through before the launch stops. */
export const MAX_WAITS = 5;
/** Retries of one item after a transient failure, before the launch stops. */
export const MAX_RETRIES = 3;
/** The first retry's delay; each later one doubles it. */
export const RETRY_BASE_MS = 1_000;

/** The backend's bounds on what a launch record keeps. */
const MAX_MESSAGE_LENGTH = 500;
const MAX_CODE_LENGTH = 64;
const MAX_REASON_LENGTH = 200;

function bounded(error: LaunchError): LaunchError {
  return {
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.code ? { code: error.code.slice(0, MAX_CODE_LENGTH) } : {}),
    message: error.message.slice(0, MAX_MESSAGE_LENGTH),
  };
}

export type ItemStop = {
  kind: "stop";
  error: LaunchError;
  retryAfterAt?: number;
  cause: unknown;
};

export type ItemOutcome =
  | { kind: "started" }
  | { kind: "failed"; cause: unknown }
  | ItemStop
  /** The launch stopped, here or elsewhere, before this item could start. */
  | { kind: "halted" };

export type FirstItemOutcome<P> =
  | { kind: "started"; rest: RunGroupLaunchItem<P>[] }
  | ItemStop
  /** The launch was stopped or resumed elsewhere. */
  | { kind: "lost" }
  /** Nothing started in this call; `firstFailure` is the first item refused. */
  | { kind: "exhausted"; firstFailure?: unknown };

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class LaunchSession<P> {
  readonly record: LaunchRecordState<P>;
  private afterReply = false;
  private stopped: ItemStop | null = null;
  /** A write was refused with `LEASE_LOST`: the record is no longer ours. */
  private lost = false;
  private stopHeartbeat: () => void = () => undefined;
  private beating = false;

  constructor(
    private readonly projectId: string,
    view: RunGroupLaunchRecord<P>,
    private readonly generation: number,
    private readonly adapter: RunGroupLaunchAdapter<P>,
    private readonly deps: RunGroupLaunchDeps,
    private readonly ports: RunGroupLaunchPorts<P>,
  ) {
    this.record = new LaunchRecordState(view);
  }

  private bearer(): Promise<string> {
    return this.afterReply
      ? this.deps.getRunBearer()
      : Promise.resolve(this.deps.bearerToken);
  }

  private written() {
    return {
      kind: this.adapter.kind,
      projectId: this.projectId,
      runGroupId: this.record.runGroupId,
      generation: this.generation,
    };
  }

  /**
   * A record write that cannot stop the launch by failing: the record reports
   * on the runs, and the backend's sweep ends a record this process can no
   * longer reach. Only `LEASE_LOST` changes what happens next.
   */
  private async write(
    what: string,
    call: (backend: RunGroupLaunchBackend<P>) => Promise<unknown>,
  ): Promise<void> {
    try {
      await call(this.ports.backend(await this.bearer()));
    } catch (error) {
      if (isLeaseLost(error)) {
        if (!this.lost) {
          logger.info(
            "[run-group-launch] launch stopped or resumed elsewhere; starting no more items",
            { runGroupId: this.record.runGroupId, kind: this.adapter.kind },
          );
        }
        this.lost = true;
        this.stopHeartbeat();
        return;
      }
      logger.warn(`[run-group-launch] ${what} was not recorded`, {
        runGroupId: this.record.runGroupId,
        error: errorText(error),
      });
    }
  }

  private async recordItem(itemKey: string, update: ItemUpdate): Promise<void> {
    this.record.applyItem(itemKey, update);
    await this.write(`item ${update.status}`, (backend) =>
      backend.recordItem({ ...this.written(), itemKey, ...update }),
    );
  }

  startHeartbeat(): void {
    this.stopHeartbeat = this.ports.every(HEARTBEAT_MS, () => {
      void this.beat();
    });
  }

  private async beat(): Promise<void> {
    if (this.beating || this.lost) return;
    this.beating = true;
    try {
      await this.write("heartbeat", (backend) =>
        backend.heartbeat(this.written()),
      );
    } finally {
      this.beating = false;
    }
  }

  /** What to do after `failure`, given the attempts so far. */
  private decide(
    failure: ItemFailure,
    error: unknown,
    attempts: { waits: number; retries: number },
  ):
    | { then: "sleep"; ms: number }
    | { then: "fail"; error: LaunchError }
    | { then: "stop"; error: LaunchError; retryAfterAt?: number } {
    const described = () => bounded(this.adapter.describeError(error));
    if (failure === "item_failed") return { then: "fail", error: described() };
    if (failure === "retry") {
      return attempts.retries < MAX_RETRIES
        ? { then: "sleep", ms: RETRY_BASE_MS * 2 ** attempts.retries }
        : { then: "stop", error: described() };
    }
    if ("wait" in failure) {
      return failure.wait <= MAX_WAIT_MS && attempts.waits < MAX_WAITS
        ? { then: "sleep", ms: failure.wait }
        : {
            then: "stop",
            error: described(),
            retryAfterAt: this.ports.now() + failure.wait,
          };
    }
    return {
      then: "stop",
      error: bounded(failure.stop),
      ...(failure.retryAfterMs !== undefined
        ? { retryAfterAt: this.ports.now() + failure.retryAfterMs }
        : {}),
    };
  }

  /** Start one item, waiting out throttles and retrying transient failures. */
  async startItem(item: RunGroupLaunchItem<P>): Promise<ItemOutcome> {
    await this.recordItem(item.itemKey, { status: "starting" });
    const attempts = { waits: 0, retries: 0 };
    for (;;) {
      // Stopped elsewhere, or by another item while this one waited: its
      // `starting` becomes `not_started` when the launch is finished.
      if (this.lost || this.stopped) return { kind: "halted" };
      let failure: ItemFailure;
      let cause: unknown;
      try {
        const result = await this.adapter.launchItem(item, {
          bearer: await this.bearer(),
          phase: this.afterReply ? "background" : "request",
          runGroupId: this.record.runGroupId,
        });
        await this.recordItem(item.itemKey, {
          status: "started",
          runId: result.runId,
          ...(result.deduped ? { deduped: true } : {}),
        });
        return { kind: "started" };
      } catch (error) {
        cause = error;
        failure = this.adapter.classifyError(error);
      }
      const decision = this.decide(failure, cause, attempts);
      if (decision.then === "sleep") {
        if (failure === "retry") attempts.retries += 1;
        else attempts.waits += 1;
        await this.ports.sleep(decision.ms);
        continue;
      }
      if (decision.then === "fail") {
        await this.recordItem(item.itemKey, {
          status: "failed",
          error: decision.error,
        });
        return { kind: "failed", cause };
      }
      // Not started rather than failed, so resuming the launch starts it.
      await this.recordItem(item.itemKey, {
        status: "not_started",
        error: decision.error,
        reason: decision.error.message.slice(0, MAX_REASON_LENGTH),
      });
      return {
        kind: "stop",
        error: decision.error,
        cause,
        ...(decision.retryAfterAt !== undefined
          ? { retryAfterAt: decision.retryAfterAt }
          : {}),
      };
    }
  }

  /**
   * Start items inside the request until one starts or the launch stops. An
   * item refused on its own is failed and the next is tried, so the caller
   * hears an error only when nothing could start.
   */
  async startFirst(): Promise<FirstItemOutcome<P>> {
    const items = this.record.toLaunch();
    let firstFailure: unknown;
    let failed = false;
    for (const [index, item] of items.entries()) {
      const outcome = await this.startItem(item);
      if (outcome.kind === "started") {
        return { kind: "started", rest: items.slice(index + 1) };
      }
      if (outcome.kind === "stop") return outcome;
      if (outcome.kind === "halted") return { kind: "lost" };
      if (!failed) {
        failed = true;
        firstFailure = outcome.cause;
      }
    }
    return { kind: "exhausted", ...(failed ? { firstFailure } : {}) };
  }

  async finish(
    state: FinalLaunchState,
    stopReason?: LaunchError,
    retryAfterAt?: number,
  ): Promise<void> {
    this.stopHeartbeat();
    if (this.lost) return;
    const finish = {
      state,
      ...(stopReason ? { stopReason } : {}),
      ...(retryAfterAt !== undefined ? { retryAfterAt } : {}),
    };
    this.record.applyFinish(finish, this.ports.now());
    await this.write("finish", (backend) =>
      backend.finish({ ...this.written(), ...finish }),
    );
    logger.info("[run-group-launch] launch finished", {
      runGroupId: this.record.runGroupId,
      kind: this.adapter.kind,
      state,
      items: this.record.counts(),
    });
  }

  /** Launch `items` after the reply, holding the drain until they settle. */
  continueInBackground(items: RunGroupLaunchItem<P>[]): void {
    this.afterReply = true;
    const { concurrency } = this.adapter;
    const parallel =
      typeof concurrency === "number"
        ? concurrency
        : concurrency(this.record.items());
    this.ports.holdDrain(this.launchRest(items, Math.max(1, parallel)));
  }

  private async launchRest(
    items: RunGroupLaunchItem<P>[],
    parallel: number,
  ): Promise<void> {
    try {
      let next = 0;
      const worker = async () => {
        while (next < items.length && !this.stopped && !this.lost) {
          const item = items[next];
          next += 1;
          const outcome = await this.startItem(item);
          // Items already starting settle; nothing new is picked up.
          if (outcome.kind === "stop") this.stopped ??= outcome;
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(parallel, items.length) }, worker),
      );
      if (this.stopped) {
        await this.finish(
          "stopped",
          this.stopped.error,
          this.stopped.retryAfterAt,
        );
      } else {
        await this.finish(this.record.settledState());
      }
    } catch (error) {
      this.stopHeartbeat();
      logger.error("[run-group-launch] background launch failed", error, {
        runGroupId: this.record.runGroupId,
      });
    }
  }
}
