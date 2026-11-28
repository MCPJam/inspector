/**
 * This process's copy of one launch record, kept in step with every write the
 * launch makes, so a reply can say where the launch stands without reading
 * the record back.
 *
 * It applies the transitions the backend's writers apply: an item takes what
 * its `recordItem` sent, and `finish` with `stopped` or `failed` turns every
 * item still pending or starting into `not_started`, with the stop's message
 * as the reason.
 */
import type { LaunchError } from "../../../shared/run-group-launch.js";
import type { FinishArgs, RecordItemArgs } from "./backend.js";
import type { RunGroupLaunchItem, RunGroupLaunchRecord } from "./types.js";

export type ItemUpdate = Pick<
  RecordItemArgs,
  "status" | "runId" | "deduped" | "error" | "reason"
>;

export type FinalLaunchState = FinishArgs["state"];

export class LaunchRecordState<P> {
  private readonly view: RunGroupLaunchRecord<P>;

  constructor(view: RunGroupLaunchRecord<P>) {
    this.view = structuredClone(view);
  }

  get runGroupId(): string {
    return this.view.runGroupId;
  }

  items(): readonly RunGroupLaunchItem<P>[] {
    return this.view.items;
  }

  /** The items still to launch, in launch order: a resume continues these. */
  toLaunch(): RunGroupLaunchItem<P>[] {
    return this.view.items.filter(
      (item) => item.status === "pending" || item.status === "starting",
    );
  }

  anyStarted(): boolean {
    return this.view.items.some((item) => item.status === "started");
  }

  /** The state a launch that was not stopped ends in. */
  settledState(): Exclude<FinalLaunchState, "stopped"> {
    const started = this.view.items.filter(
      (item) => item.status === "started",
    ).length;
    if (started === this.view.items.length) return "launched";
    return started > 0 ? "partial" : "failed";
  }

  counts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const item of this.view.items) {
      counts[item.status] = (counts[item.status] ?? 0) + 1;
    }
    return counts;
  }

  applyItem(itemKey: string, update: ItemUpdate): void {
    this.view.items = this.view.items.map((item) => {
      if (item.itemKey !== itemKey) return item;
      // An update states the item as it is now; what an earlier attempt
      // recorded about it goes.
      const next: RunGroupLaunchItem<P> = { ...item, status: update.status };
      delete next.runId;
      delete next.deduped;
      delete next.error;
      delete next.reason;
      return {
        ...next,
        ...(update.runId !== undefined ? { runId: update.runId } : {}),
        ...(update.deduped ? { deduped: true } : {}),
        ...(update.error ? { error: update.error } : {}),
        ...(update.reason !== undefined ? { reason: update.reason } : {}),
      };
    });
  }

  applyFinish(
    finish: {
      state: FinalLaunchState;
      stopReason?: LaunchError;
      retryAfterAt?: number;
    },
    now: number,
  ): void {
    this.view.state = finish.state;
    this.view.finishedAt = now;
    if (finish.stopReason) this.view.stopReason = finish.stopReason;
    if (finish.retryAfterAt !== undefined) {
      this.view.retryAfterAt = finish.retryAfterAt;
    }
    if (finish.state !== "stopped" && finish.state !== "failed") return;
    const reason = finish.stopReason?.message;
    this.view.items = this.view.items.map((item) =>
      item.status === "pending" || item.status === "starting"
        ? {
            ...item,
            status: "not_started",
            ...(reason !== undefined ? { reason } : {}),
          }
        : item,
    );
  }

  snapshot(): RunGroupLaunchRecord<P> {
    return structuredClone(this.view);
  }
}
