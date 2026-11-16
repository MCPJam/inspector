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
import type { z } from "zod";
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
import {
  DurableControlCache,
  type CachedControl,
} from "./durable-controls.js";

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
type ContextCommand =
  | {
      kind: "update";
      request: PluginContextUpdate;
      limits?: PluginContextLimits;
    }
  | { kind: "remove-all"; request: PluginContextRemoveAll };
/** A minute under the store's ceiling, so a replica whose clock runs a little
 * ahead of the store's still issues and renews leases. */
const MODEL_APP_TTL_MS = INVOCATION_RECEIPT_TTL_MS - 60_000;

/** This process's copy of a model App. The durable control is its authority;
 * everything here is rebuilt from it on any replica. */
export interface ModelApp extends CachedControl {
  readonly owner: PluginFormOwner;
  readonly toolName: string;
  readonly revision: string;
  readonly resourceUri: string;
  readonly invoker: RequestOwnedToolInvoker;
  context: PluginContextWorkspace;
  contextVersion?: number;
  /** Message bindings, kept here only when there is no receipt store. */
  messages: Map<string, string>;
  formOwner: ReturnType<typeof pluginInstances.retainModelOwner>;
}
type ModelAppSnapshot = z.infer<typeof modelAppControlSchema>;

/**
 * Model Apps published by completed model calls. Each is a durable control
 * (`model-app-control.ts`) that any replica restores through the shared
 * cache (`durable-controls.ts`): same token, owner, tool revision, context
 * and receipts. This registry adds what only Apps have: versioned context,
 * renewal and current-chat message bindings.
 */
export class ModelAppRegistry {
  private readonly controls: DurableControlCache<ModelApp, ModelAppSnapshot>;
  /** The context write each App is waiting on in this process. */
  private readonly writes = new Map<string, Promise<unknown>>();
  constructor(
    private readonly ttlMs = MODEL_APP_TTL_MS,
    private readonly memory = pluginContextMemory,
    private readonly now: () => number = () => Date.now(),
    private readonly portFor: (
      identity: PluginInstanceIdentity,
    ) =>
      PluginInstanceControlPort | undefined = createPluginInstanceControlPort,
  ) {
    this.controls = new DurableControlCache<ModelApp, ModelAppSnapshot>(
      {
        denied,
        parse: (saved) => {
          if (!isModelAppControl(saved)) return undefined;
          const parsed = modelAppControlSchema.safeParse(
            JSON.parse(saved.snapshotJson),
          );
          return parsed.success ? parsed.data : undefined;
        },
        issuedUntil: (snapshot) => snapshot.expiresAt,
        owns: (snapshot, actor) => sameOwner(snapshot.instance.owner, actor),
        matches: (app, actor) => matches(app.owner, actor),
        create: ({ actor, snapshot, saved, snapshotHash, assertLive }) =>
          this.create(actor, snapshot, saved, snapshotHash, assertLive),
        refresh: (app, saved) => this.restoreContext(app, saved),
        restored: (app) => this.keepFormOwner(app),
        release: (app) => {
          app.invoker.close();
          app.context.close(app.owner.owner.instanceId);
          this.memory.release(app.owner.owner.instanceId);
        },
        readHint: (app) => app.contextVersion,
        // This process released the context the reply left out: read it in full.
        retryFull: (error) =>
          isCode(error, "INSTANCE_CONTEXT_RECOVERY_UNAVAILABLE"),
      },
      { ttlMs, now, portFor },
    );
  }

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
    return this.controls.holds(token);
  }

  /** The durable control, restored into this process. */
  restore(
    token: string,
    actor: PluginInstanceIdentity,
    signal: AbortSignal,
    port?: PluginInstanceControlPort,
  ) {
    return this.controls.restore(token, actor, signal, port);
  }

  /** Restore a control the caller already read, such as `readOwnedApp`. */
  restoreFrom(
    token: string,
    actor: PluginInstanceIdentity,
    saved: DurablePluginInstanceControl | null,
    signal: AbortSignal,
  ) {
    return this.controls.restoreFrom(token, actor, saved, signal);
  }

  private create(
    actor: PluginInstanceIdentity,
    snapshot: ModelAppSnapshot,
    saved: DurablePluginInstanceControl,
    snapshotHash: string,
    assertLive: () => void,
  ): ModelApp {
    const { owner, toolName, revision, resourceUri, ...source } =
      snapshot.instance;
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
      invoker: new RequestOwnedToolInvoker(owner, assertLive),
      context: this.workspace({ owner: formOwner, toolName, resourceUri }),
      expiresAt: saved.expiresAt,
      messages: new Map(),
    };
    this.restoreContext(candidate as ModelApp, saved);
    try {
      return Object.assign(candidate, {
        formOwner: pluginInstances.retainModelOwner(formOwner, abort.signal),
      });
    } catch (error) {
      this.memory.release(owner.instanceId);
      throw error;
    }
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
    return this.controls.get(token, actor);
  }

  /** One fence: `query` (an admission read), then the durable control. The
   * control is read only after admission completes, so a close or expiry on
   * any replica during the admission wait refuses what follows the fence,
   * including the dispatch the invoker's last authorization leads to. */
  fence(
    token: string,
    actor: PluginInstanceIdentity,
    signal: AbortSignal,
  ): PluginInstanceAdmissionRead {
    return this.controls.fence(token, actor, signal);
  }

  /** Compare-and-set on the stored context, retried on a concurrent write.
   * Call right after a `fence` read: the first attempt stands on the copy
   * that read refreshed, and the store refuses a write to a closed App. */
  changeContext(
    token: string,
    actor: PluginInstanceIdentity,
    command: ContextCommand,
    signal: AbortSignal,
  ) {
    // One write per App at a time in this process, so each holds the App's
    // memory reservation until it commits or fails. Writes from other
    // replicas are ordered by the store's compare-and-set.
    const write = () => this.writeContext(token, actor, command, signal);
    const previous = this.writes.get(token) ?? Promise.resolve();
    const current = previous.then(write, write);
    this.writes.set(token, current);
    return current.finally(() => {
      if (this.writes.get(token) === current) this.writes.delete(token);
    });
  }

  private async writeContext(
    token: string,
    actor: PluginInstanceIdentity,
    command: ContextCommand,
    signal: AbortSignal,
  ) {
    const port = this.controls.port(actor);
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
          if (this.controls.peek(token) === app) this.holdMemory(app);
          if (isCode(error, "INSTANCE_CONTEXT_CONFLICT")) continue;
          throw this.controls.refusal(token, actor, error);
        }
        // The write is stored: this copy follows it before any abort, so its
        // memory charge matches what it holds. The reply leaves out the
        // envelope this write stored.
        this.restoreContext(
          app,
          saved.contextVersion === expectedVersion + 1
            ? { ...saved, contextJson }
            : saved,
        );
        signal.throwIfAborted();
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
    const port = this.controls.port(actor);
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
        throw this.controls.refusal(token, actor, error);
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
  close(token: string, actor: PluginInstanceIdentity, signal: AbortSignal) {
    return this.controls.close(token, actor, signal);
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
