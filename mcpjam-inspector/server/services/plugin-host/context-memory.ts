import { PluginInvocationError } from "./invocation.js";

/** App context this process holds for one actor, and in all. */
export const PLUGIN_CONTEXT_MEMORY_PER_ACTOR = 32 * 1024 * 1024;
export const PLUGIN_CONTEXT_MEMORY_PER_PROCESS = 256 * 1024 * 1024;

/** A retained or model App: its instance and who it belongs to. */
type Holder = {
  owner: { instanceId: string; actorId: string };
  subject: string;
};
const actorKey = (holder: Holder) =>
  JSON.stringify([holder.owner.actorId, holder.subject]);

/**
 * Bytes of App context held in this process, for retained and model Apps.
 * A new update that would cross a budget is refused with
 * `PLUGIN_CONTEXT_MEMORY_LIMIT`, a known rejection, so the App keeps its last
 * context. Context already admitted is counted when it is restored but never
 * refused, and nothing is evicted to make room: a model App has no durable
 * copy to fall back on.
 */
export class PluginContextMemory {
  private readonly held = new Map<string, { actor: string; bytes: number }>();
  private readonly actors = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly perActor = PLUGIN_CONTEXT_MEMORY_PER_ACTOR,
    private readonly perProcess = PLUGIN_CONTEXT_MEMORY_PER_PROCESS,
  ) {}

  /** Refuse an update that would leave `holder` holding `bytes` past a budget. */
  check(holder: Holder, bytes: number) {
    const growth = bytes - (this.held.get(holder.owner.instanceId)?.bytes ?? 0);
    if (
      growth > 0 &&
      ((this.actors.get(actorKey(holder)) ?? 0) + growth > this.perActor ||
        this.total + growth > this.perProcess)
    )
      throw new PluginInvocationError("PLUGIN_CONTEXT_MEMORY_LIMIT");
  }

  /** What `holder` holds now, just admitted or restored. */
  hold(holder: Holder, bytes: number) {
    this.release(holder.owner.instanceId);
    const actor = actorKey(holder);
    this.held.set(holder.owner.instanceId, { actor, bytes });
    this.actors.set(actor, (this.actors.get(actor) ?? 0) + bytes);
    this.total += bytes;
  }

  release(instanceId: string) {
    const entry = this.held.get(instanceId);
    if (!entry) return;
    this.held.delete(instanceId);
    const left = this.actors.get(entry.actor)! - entry.bytes;
    if (left > 0) this.actors.set(entry.actor, left);
    else this.actors.delete(entry.actor);
    this.total -= entry.bytes;
  }
}
export const pluginContextMemory = new PluginContextMemory();
