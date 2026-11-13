import {
  PluginContextWorkspace,
  type PluginContextRemoveAll,
  type PluginContextUpdate,
} from "./context.js";
import { pluginContextMemory } from "./context-memory.js";
import type { PluginContextLimits } from "../../../shared/plugin-model-context.js";
import {
  INVOCATION_RECEIPT_TTL_MS,
  type DurablePluginInstanceControl,
} from "../../../shared/plugin-invocation-receipts.js";
import {
  pluginInstances,
  type PluginFormOwner,
  type PluginInstanceAdmissionRead,
  type PluginInstanceIdentity,
} from "./instances.js";
import { pluginBindingDigest } from "./bindings.js";
import { PluginInvocationError } from "./invocation.js";
import { RequestOwnedToolInvoker } from "./request-invoker.js";
import {
  createPluginInstanceControlPort,
  type PluginInstanceControlPort,
} from "./instance-store.js";
import {
  createPluginInvocationReceiptPort,
  pluginReceiptHash,
} from "./receipt-store.js";
import {
  isModelAppControl,
  modelAppControlSchema,
  publishModelApp,
} from "./model-app-control.js";

const denied = () => new PluginInvocationError("MODEL_APP_UNAVAILABLE");
const isCode = (error: unknown, ...codes: string[]) =>
  error instanceof PluginInvocationError && codes.includes(error.code);
const sameOwner = (
  owner: PluginFormOwner["owner"],
  actor: PluginInstanceIdentity,
) =>
  owner.actorId === actor.actorId &&
  owner.projectId === actor.projectId &&
  owner.workspaceId === actor.workspaceId;
const matches = (owner: PluginFormOwner, actor: PluginInstanceIdentity) =>
  sameOwner(owner.owner, actor) && owner.subject === actor.subject;
/** Local closes are an optimization over the store's own closed rows. */
const CLOSED_TOMBSTONES = 4096;
/** A minute under the store's ceiling, so a replica whose clock runs a little
 * ahead of the store's still issues and renews leases. */
const MODEL_APP_TTL_MS = INVOCATION_RECEIPT_TTL_MS - 60_000;

/** This process's copy of a model App. The durable control is its authority;
 * everything here is rebuilt from it on any replica. */
export interface ModelApp {
  readonly owner: PluginFormOwner;
  readonly toolName: string;
  readonly revision: string;
  readonly resourceUri: string;
  readonly snapshotHash: string;
  readonly invoker: RequestOwnedToolInvoker;
  readonly abort: AbortController;
  context: PluginContextWorkspace;
  contextVersion?: number;
  /** The lease as this process last read it from the store. */
  expiresAt: number;
  /** Message bindings, kept here only when there is no receipt store. */
  messages: Map<string, string>;
  formOwner: ReturnType<typeof pluginInstances.retainModelOwner>;
  eviction?: ReturnType<typeof setTimeout>;
}

/**
 * Model Apps published by completed model calls. Each is a durable control
 * (`model-app-control.ts`) that any replica restores: same token, owner,
 * tool revision, context and receipts. A request reads the control before it
 * acts and again beside its admission reads, so a close or expiry anywhere
 * refuses it. Nothing here is closed by a local timer: an entry this process
 * stops using is dropped, never closed, since another replica may have
 * renewed it.
 */
export class ModelAppRegistry {
  private readonly entries = new Map<string, ModelApp>();
  private readonly closed = new Map<string, number>();
  constructor(
    private readonly ttlMs = MODEL_APP_TTL_MS,
    private readonly memory = pluginContextMemory,
    private readonly now: () => number = () => Date.now(),
    private readonly portFor: (
      identity: PluginInstanceIdentity,
    ) =>
      PluginInstanceControlPort | undefined = createPluginInstanceControlPort,
  ) {}

  /** Publish inside the invocation's execute/resume callback only. Its receipt
   * retains this token, so replay never publishes a replacement for a closed App. */
  publish(
    result: unknown,
    source: PluginFormOwner,
    toolName: string,
    revision: string,
    toolMeta: unknown,
    signal: AbortSignal,
  ) {
    return publishModelApp(
      {
        result,
        source,
        toolName,
        revision,
        toolMeta,
        expiresAt: this.now() + this.ttlMs,
        signal,
      },
      this.portFor,
    );
  }

  /** Whether this process already knows `token` as a model App (open or closed). */
  holds(token: string) {
    return this.entries.has(token) || this.closed.has(token);
  }

  private port(actor: PluginInstanceIdentity) {
    const port = this.portFor(actor);
    if (!port) throw new PluginInvocationError("INSTANCE_STORE_UNAVAILABLE");
    return port;
  }

  /** The durable control, restored into this process. */
  async restore(
    token: string,
    actor: PluginInstanceIdentity,
    signal: AbortSignal,
    port = this.port(actor),
  ) {
    signal.throwIfAborted();
    this.sweep();
    if (this.closed.has(token)) throw denied();
    const known = this.entries.get(token)?.contextVersion;
    const read = async (knownContextVersion?: number) => {
      try {
        return await port.read(token, signal, knownContextVersion);
      } catch (error) {
        throw this.refusal(token, actor, error);
      }
    };
    try {
      return this.restoreFrom(token, actor, await read(known), signal);
    } catch (error) {
      // This process released the context the reply left out: read it in full.
      if (
        known === undefined ||
        !isCode(error, "INSTANCE_CONTEXT_RECOVERY_UNAVAILABLE")
      )
        throw error;
      return this.restoreFrom(token, actor, await read(), signal);
    }
  }

  /** Restore a control the caller already read, such as `readOwnedApp`. */
  restoreFrom(
    token: string,
    actor: PluginInstanceIdentity,
    saved: DurablePluginInstanceControl | null,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    this.sweep();
    if (this.closed.has(token)) throw denied();
    // The store keys a control by identity and token, so no row means no
    // App for this caller. Only the caller's own copy is dropped.
    if (!saved) {
      if (
        this.entries.get(token) &&
        matches(this.entries.get(token)!.owner, actor)
      )
        this.tombstone(token);
      throw denied();
    }
    const parsed = isModelAppControl(saved)
      ? modelAppControlSchema.safeParse(JSON.parse(saved.snapshotJson))
      : undefined;
    if (!parsed?.success) throw denied();
    const { owner, toolName, revision, resourceUri, ...source } =
      parsed.data.instance;
    if (!sameOwner(owner, actor)) throw denied();
    const snapshotHash = pluginBindingDigest(saved.snapshotJson);
    let app = this.entries.get(token);
    if (
      !Number.isSafeInteger(saved.expiresAt) ||
      saved.expiresAt < parsed.data.expiresAt
    )
      throw denied();
    // A lease that ended in flight refuses this request, but proves no close:
    // this process may already hold a later renewal of the same App.
    if (
      saved.expiresAt <= this.now() &&
      (!app || app.snapshotHash !== snapshotHash)
    )
      throw denied();
    if (app) {
      this.get(token, actor);
      if (app.snapshotHash !== snapshotHash) throw denied();
      // A reply overtaken by a later renewal never shortens the lease.
      app.expiresAt = Math.max(app.expiresAt, saved.expiresAt);
      this.restoreContext(app, saved);
    } else {
      const abort = new AbortController();
      const formOwner: PluginFormOwner = {
        owner,
        subject: actor.subject,
        ...source,
      };
      const candidate: Omit<ModelApp, "formOwner"> = {
        owner: formOwner,
        toolName,
        revision,
        resourceUri,
        snapshotHash,
        abort,
        invoker: new RequestOwnedToolInvoker(owner, () =>
          this.get(token, actor),
        ),
        context: this.workspace({ owner: formOwner, toolName, resourceUri }),
        expiresAt: saved.expiresAt,
        messages: new Map(),
      };
      this.restoreContext(candidate as ModelApp, saved);
      try {
        app = Object.assign(candidate, {
          formOwner: pluginInstances.retainModelOwner(formOwner, abort.signal),
        });
      } catch (error) {
        this.memory.release(owner.instanceId);
        throw error;
      }
      this.entries.set(token, app);
      this.evictAtLeaseEnd(token, app);
    }
    this.keepFormOwner(app);
    return app;
  }

  /** Release this process's copy once the lease it last read ends, even if
   * no other request arrives. It drops, never closes: another replica may
   * have renewed the App, and a later read restores it. */
  private evictAtLeaseEnd(token: string, app: ModelApp) {
    clearTimeout(app.eviction);
    app.eviction = setTimeout(
      () => {
        if (this.entries.get(token) !== app) return;
        if (app.expiresAt > this.now()) this.evictAtLeaseEnd(token, app);
        else this.drop(token);
      },
      Math.max(0, app.expiresAt - this.now()),
    );
    app.eviction.unref?.();
  }

  /** A store refusal for this caller's own control (the store keys it by
   * identity) means the App is closed or expired everywhere. */
  private refusal(
    token: string,
    actor: PluginInstanceIdentity,
    error: unknown,
  ) {
    if (isCode(error, "INSTANCE_DENIED")) return denied();
    if (!isCode(error, "INSTANCE_UNAVAILABLE")) return error;
    const app = this.entries.get(token);
    if (!app || matches(app.owner, actor)) this.tombstone(token);
    return denied();
  }

  /** Forms opened from this App's calls find their owner while it lives. */
  private keepFormOwner(app: ModelApp) {
    try {
      app.formOwner.renew();
    } catch (error) {
      if (!isCode(error, "FORM_SOURCE_UNAVAILABLE")) throw error;
      // Released by its own idle timer while the lease went on elsewhere.
      app.formOwner = pluginInstances.retainModelOwner(
        app.owner,
        app.abort.signal,
      );
    }
  }

  private workspace({
    owner,
    toolName,
    resourceUri,
  }: Pick<ModelApp, "owner" | "toolName" | "resourceUri">) {
    const context = new PluginContextWorkspace(owner.owner.workspaceId);
    context.attach(owner.owner.instanceId, owner.owner.generation, {
      workspaceId: owner.owner.workspaceId,
      scope: { kind: "thread", threadId: owner.owner.workspaceId },
      pluginVersionId: owner.owner.bindingId,
      serverId: owner.owner.serverId,
      bindingId: owner.owner.bindingId,
      origin: { kind: "thread", id: toolName },
      resourceUri,
    });
    return context;
  }

  /** Adopt the stored context when it is newer than this process's copy. */
  private restoreContext(app: ModelApp, saved: DurablePluginInstanceControl) {
    const version = saved.contextVersion;
    if (!Number.isSafeInteger(version) || version! < 0)
      throw new PluginInvocationError("INSTANCE_CONTEXT_RECOVERY_UNAVAILABLE");
    if (app.contextVersion !== undefined && version! <= app.contextVersion)
      return;
    if (version! > 0 && !saved.contextJson)
      throw new PluginInvocationError("INSTANCE_CONTEXT_RECOVERY_UNAVAILABLE");
    const { instanceId, generation } = app.owner.owner;
    const context = this.workspace(app);
    context.restore(instanceId, generation, saved.contextJson, version);
    app.context = context;
    app.contextVersion = version;
    this.holdMemory(app);
  }

  /** What this App's context holds in this process. A removed context holds
   * nothing, though its envelope keeps the removal. */
  private holdMemory(app: ModelApp) {
    const { instanceId, generation } = app.owner.owner;
    this.memory.hold(
      app.owner,
      app.context.snapshot(instanceId, generation).state
        ? Buffer.byteLength(app.context.export(instanceId, generation))
        : 0,
    );
  }

  /** This process's copy, checked against its last durable read only. Call
   * after `restore` or a `fence` read within the same request. */
  get(token: string, actor: PluginInstanceIdentity) {
    const app = this.entries.get(token);
    if (
      !app ||
      app.abort.signal.aborted ||
      app.expiresAt <= this.now() ||
      this.closed.has(token)
    ) {
      if (app) this.drop(token);
      throw denied();
    }
    if (!matches(app.owner, actor)) throw denied();
    return app;
  }

  /** One fence: the durable control and `query` (an admission read) run side
   * by side, and both must pass. A close or expiry on any replica refuses it. */
  fence(
    token: string,
    actor: PluginInstanceIdentity,
    signal: AbortSignal,
  ): PluginInstanceAdmissionRead {
    return async (query) => {
      const [durable, admitted] = await Promise.allSettled([
        this.restore(token, actor, signal),
        Promise.resolve().then(query),
      ]);
      signal.throwIfAborted();
      if (durable.status === "rejected") throw durable.reason;
      if (admitted.status === "rejected") throw admitted.reason;
      this.get(token, actor);
      return admitted.value;
    };
  }

  /** Compare-and-set on the stored context, retried on a concurrent write.
   * Call right after a `fence` read: the first attempt stands on the copy
   * that read refreshed, and the store refuses a write to a closed App. */
  async changeContext(
    token: string,
    actor: PluginInstanceIdentity,
    command:
      | {
          kind: "update";
          request: PluginContextUpdate;
          limits?: PluginContextLimits;
        }
      | { kind: "remove-all"; request: PluginContextRemoveAll },
    signal: AbortSignal,
  ) {
    const port = this.port(actor);
    if (!port.writeContext)
      throw new PluginInvocationError("INSTANCE_CONTEXT_UNAVAILABLE");
    for (let attempt = 0; attempt < 3; attempt++) {
      const app = attempt
        ? await this.restore(token, actor, signal, port)
        : this.get(token, actor);
      const { instanceId, generation } = app.owner.owner;
      const candidate = app.context.fork(instanceId, generation);
      const before = candidate.export(instanceId, generation);
      const result =
        command.kind === "update"
          ? candidate.update(
              instanceId,
              generation,
              command.request,
              command.limits,
            )
          : candidate.removeAll(instanceId, generation, command.request);
      const contextJson = candidate.export(instanceId, generation);
      const expectedVersion = app.contextVersion!;
      signal.throwIfAborted();
      // A retry of a change already stored writes nothing and is not charged.
      if (contextJson !== before) {
        // The person's removal is never refused: it adds only removal state.
        // An update reserves its bytes before the write, so concurrent writes
        // for the same actor see each other against the budget.
        if (command.kind === "update") {
          this.memory.check(app.owner, Buffer.byteLength(contextJson));
          this.memory.hold(app.owner, Buffer.byteLength(contextJson));
        }
        let saved: DurablePluginInstanceControl;
        try {
          saved = await port.writeContext(
            token,
            { expectedVersion, contextJson },
            AbortSignal.any([signal, app.abort.signal]),
          );
        } catch (error) {
          // Back to what this process holds; a dropped copy holds nothing.
          if (this.entries.get(token) === app) this.holdMemory(app);
          if (isCode(error, "INSTANCE_CONTEXT_CONFLICT")) continue;
          throw this.refusal(token, actor, error);
        }
        signal.throwIfAborted();
        // The reply leaves out the envelope this write stored.
        this.restoreContext(
          app,
          saved.contextVersion === expectedVersion + 1
            ? { ...saved, contextJson }
            : saved,
        );
      }
      return { result, snapshot: app.context.snapshot(instanceId, generation) };
    }
    throw new PluginInvocationError("INSTANCE_CONTEXT_CONFLICT");
  }

  /**
   * Bind a current-chat message operation to its payload. The App's receipt
   * store holds the binding, so a retry on any replica with different content
   * is refused, and a closed App's claim is refused there too. Without a
   * receipt store (a local install, one process) this process keeps it.
   */
  async prepareMessage(
    app: ModelApp,
    actor: PluginInstanceIdentity,
    operationId: string,
    fingerprint: string,
    signal: AbortSignal,
  ) {
    if (!matches(app.owner, actor)) throw denied();
    const receipts = createPluginInvocationReceiptPort(
      app.owner.owner,
      app.owner.subject,
    );
    if (!receipts) {
      const previous = app.messages.get(operationId);
      if (previous && previous !== fingerprint)
        throw new PluginInvocationError("INSTANCE_MESSAGE_CHANGED");
      app.messages.set(operationId, fingerprint);
      // Bounded recent window; a long-lived App never runs out of messages.
      for (const key of app.messages.keys()) {
        if (app.messages.size <= 2048) break;
        app.messages.delete(key);
      }
      return;
    }
    const digest = pluginReceiptHash(["model-app-message-v1", fingerprint]);
    try {
      await receipts.claim(
        `message:${operationId}`,
        {
          fingerprint: digest,
          legFingerprint: digest,
          revision: app.revision,
          writerHash: pluginReceiptHash([
            "model-app-message-writer-v1",
            operationId,
          ]),
          round: 0,
        },
        signal,
      );
    } catch (error) {
      if (isCode(error, "INVOCATION_ID_REUSED"))
        throw new PluginInvocationError("INSTANCE_MESSAGE_CHANGED");
      throw error;
    }
  }

  /** Extend the same App's lease past its original lifetime; its owner,
   * context and effect history continue. A closed or expired App cannot be
   * renewed. Another replica may already have extended it further. */
  async renew(
    token: string,
    actor: PluginInstanceIdentity,
    signal: AbortSignal,
    authorize: (app: ModelApp) => Promise<void>,
  ) {
    const port = this.port(actor);
    if (!port.renew)
      throw new PluginInvocationError("INSTANCE_RENEWAL_UNAVAILABLE");
    const app = await this.restore(token, actor, signal, port);
    await authorize(app);
    signal.throwIfAborted();
    this.get(token, actor);
    const expiresAt = this.now() + this.ttlMs;
    if (expiresAt <= app.expiresAt)
      return { expiresAt: app.expiresAt, renewed: false };
    let saved: DurablePluginInstanceControl;
    try {
      saved = await port.renew(
        token,
        { expiresAt, knownContextVersion: app.contextVersion },
        AbortSignal.any([signal, app.abort.signal]),
      );
    } catch (error) {
      // A lost race (another replica extended further) or a store that
      // predates model App renewal. Neither ends a live App: report the
      // stored lease as it stands, or refuse if it is gone.
      if (!isCode(error, "INVALID_INSTANCE_CONTROL", "INSTANCE_UNAVAILABLE"))
        throw this.refusal(token, actor, error);
      const current = await this.restore(token, actor, signal, port);
      return { expiresAt: current.expiresAt, renewed: false };
    }
    signal.throwIfAborted();
    let renewed: ModelApp;
    try {
      renewed = this.restoreFrom(token, actor, saved, signal);
    } catch (error) {
      if (!isCode(error, "INSTANCE_CONTEXT_RECOVERY_UNAVAILABLE")) throw error;
      // This process dropped its copy while the renewal was in flight, and
      // the reply left out the context it held: read it in full.
      renewed = await this.restore(token, actor, signal, port);
    }
    return { expiresAt: renewed.expiresAt, renewed: true };
  }

  /** Close everywhere: the store refuses the token on every replica. Cleanup
   * survives rollout denial; the caller still proves actor and subject. */
  async close(
    token: string,
    actor: PluginInstanceIdentity,
    signal: AbortSignal,
  ) {
    const app = this.entries.get(token);
    if (app && !matches(app.owner, actor)) throw denied();
    const port = this.port(actor);
    // Stop this process's use at once; an unknown handle is tombstoned only
    // once the store confirms it was this caller's App.
    if (app) this.tombstone(token);
    const closed = await port.close(token, signal);
    if (closed?.ownerHash) this.tombstone(token);
  }

  private drop(token: string) {
    const app = this.entries.get(token);
    if (!app) return;
    this.entries.delete(token);
    clearTimeout(app.eviction);
    app.abort.abort();
    app.invoker.close();
    app.context.close(app.owner.owner.instanceId);
    this.memory.release(app.owner.owner.instanceId);
  }
  private tombstone(token: string) {
    this.drop(token);
    this.closed.delete(token);
    this.closed.set(token, this.now() + this.ttlMs);
    for (const key of this.closed.keys()) {
      if (this.closed.size <= CLOSED_TOMBSTONES) break;
      this.closed.delete(key);
    }
  }
  private sweep() {
    for (const [token, expiry] of this.closed)
      if (expiry <= this.now()) this.closed.delete(token);
    for (const [token, app] of this.entries)
      if (app.expiresAt <= this.now()) this.drop(token);
  }
}
export const modelApps = new ModelAppRegistry();

/** Which registry owns a browser-supplied App handle, from its durable
 * control. One store read decides it when this process holds neither. */
export async function readOwnedApp(
  token: string,
  actor: PluginInstanceIdentity,
  signal: AbortSignal,
) {
  if (modelApps.holds(token))
    return {
      kind: "model" as const,
      app: await modelApps.restore(token, actor, signal),
    };
  if (pluginInstances.holds(token))
    return {
      kind: "instance" as const,
      instance: await pluginInstances.getPersistent(token, actor, signal),
    };
  const port = createPluginInstanceControlPort(actor);
  if (!port) throw new PluginInvocationError("INSTANCE_STORE_UNAVAILABLE");
  const saved = await port.read(token, signal);
  signal.throwIfAborted();
  return isModelAppControl(saved)
    ? {
        kind: "model" as const,
        app: modelApps.restoreFrom(token, actor, saved, signal),
      }
    : {
        kind: "instance" as const,
        instance: await pluginInstances.getPersistentFrom(
          token,
          actor,
          saved,
          signal,
          port,
        ),
      };
}
