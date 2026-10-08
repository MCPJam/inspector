import { pluginFormFileGrants } from "./form-file-grants.js";
import { pluginFormSources } from "./form-sources.js";
import {
  PluginContextWorkspace,
  type PluginContextUpdate,
  type PluginContextRemoval,
} from "./context.js";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { pluginBindingDigest, pluginServerIdentitySchema } from "./bindings.js";
import {
  createPluginInstanceControlPort,
  type PluginInstanceControlPort,
} from "./instance-store.js";
import { pluginInvocationOwnerHash } from "./receipt-store.js";
import { RequestOwnedToolInvoker } from "./request-invoker.js";
import {
  PluginInvocationError,
  type PluginInvocationPorts,
  type PluginInvocationOrigin,
  type TrustedInvocationOwner,
  type PluginToolCallParams,
} from "./invocation.js";
import {
  PLUGIN_INSTANCE_CONTROL_BYTES,
  isDurableSavedResourceDescriptor,
  type DurablePluginInstanceControl,
} from "../../../shared/plugin-invocation-receipts.js";

export interface PluginInstanceIdentity {
  actorId: string;
  projectId: string;
  workspaceId: string;
  /** Verified credential subject; never supplied by the browser body. */
  subject: string;
}
/** Coordinates two independent read-only checks. Each read still verifies the
 * original durable owner; it grants no connection, metadata or execution. */
export type PluginInstanceAdmissionRead = <T>(
  read: () => Promise<T>,
) => Promise<T>;
/** The fenced reads of one authorization taken before the invoker starts
 * (see `PluginInstanceRegistry.fence`). Opaque outside this module. */
export interface PluginInstanceFence {
  readonly read: PluginInstanceAdmissionRead;
}
type FenceState = { reads: number; reading: boolean };
const fences = new WeakMap<
  PluginInstanceFence,
  { token: string; identity: string; state: FenceState; used: boolean }
>();
export interface PluginInstanceInvocationPorts extends PluginInvocationPorts {
  /** The runtime places these fences before target authorization and after its
   * catalog wait. Other adapters retain the ordinary serial ownership checks. */
  authorizeInstance?: (
    ...args: [
      ...Parameters<PluginInvocationPorts["authorize"]>,
      PluginInstanceAdmissionRead,
    ]
  ) => ReturnType<PluginInvocationPorts["authorize"]>;
}
const id = z.string().min(1).max(4096);
const activationSchema = z.strictObject({
  selector: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("thread"), threadId: id }),
    z.strictObject({ kind: z.literal("global") }),
    z.strictObject({
      kind: z.literal("quick-action"),
      requestId: z.string().uuid(),
    }),
    z.strictObject({ kind: z.literal("settings") }),
    z.strictObject({ kind: z.literal("file"), requestId: z.string().uuid() }),
  ]),
  toolName: id,
  sourceToolName: id.optional(),
  arguments: z.record(z.string(), z.unknown()).optional(),
  presentation: z.enum(["app", "result"]).optional(),
  revision: id,
  operationId: z.string().uuid(),
  settings: z
    .strictObject({ readTool: id, updateTool: id, revision: id })
    .optional(),
  file: z
    .strictObject({
      kind: z.literal("saved-resource"),
      version: z.literal(1),
      uri: id,
      name: id,
      sourceName: id.optional(),
      localTarget: z
        .strictObject({
          root: id,
          relativePath: id,
          uri: id,
          exclusiveWrites: z.literal(true),
        })
        .optional(),
    })
    .refine(isDurableSavedResourceDescriptor)
    .optional(),
});
const instanceSchema = z.strictObject({
  owner: z.strictObject({
    actorId: id,
    projectId: id,
    workspaceId: id,
    instanceId: z.string().uuid(),
    generation: z.literal(1),
    serverId: id,
    bindingId: id,
    placement: z.literal("interactive"),
  }),
  hostId: id,
  hostRevision: id,
  resourceUri: z.string().startsWith("ui://").max(4096),
  serverIdentity: pluginServerIdentitySchema,
  activation: activationSchema,
  contextEnabled: z.boolean().optional(),
  messageEnabled: z.boolean().optional(),
});
export const rootControlSchema = z.strictObject({
  version: z.literal(1),
  runtime: z.enum(["chatgpt", "codex"]),
  expiresAt: z.number().int().positive(),
  instance: instanceSchema,
});
type RootControl = z.infer<typeof rootControlSchema>;
export type PluginPreviewInstance = Readonly<
  RootControl["instance"] & { subject: string }
>;
export type PluginFormOwner = Pick<
  PluginPreviewInstance,
  "owner" | "subject" | "hostId" | "hostRevision" | "serverIdentity"
>;

export type PluginInstanceBinding = Pick<RootControl, "runtime"> &
  Pick<
    PluginPreviewInstance,
    | "hostId"
    | "hostRevision"
    | "resourceUri"
    | "serverIdentity"
    | "contextEnabled"
    | "messageEnabled"
  > & {
    serverId: string;
    bindingId: string;
    activation: Omit<PluginPreviewInstance["activation"], "operationId">;
  };
interface InstanceRecord {
  messagePreparations?: Map<string, string>;
  context?: PluginContextWorkspace;
  contextVersion?: number;
  instance: PluginPreviewInstance;
  snapshotHash: string;
  expiresAt: number;
  invoker: RequestOwnedToolInvoker;
  abort: AbortController;
}
/** Activation kinds that may own model context, messages and navigation. */
export const pluginConversationKinds: ReadonlySet<string> = new Set([
  "thread",
  "global",
  "quick-action",
  "file",
]);
const identityKey = (v: PluginInstanceIdentity) =>
  JSON.stringify([v.actorId, v.projectId, v.workspaceId, v.subject]);
/** Capacity is per verified actor and credential subject, never per
 * client-chosen workspace ID. */
const capacityKey = (v: Pick<PluginInstanceIdentity, "actorId" | "subject">) =>
  JSON.stringify([v.actorId, v.subject]);
/** Open Apps one actor may hold in this process (all projects and chats). */
export const PLUGIN_INSTANCES_PER_ACTOR = 64;
/** Local close tombstones are an optimization over the durable store's own
 * closed rows; they are bounded separately and never consume App slots. */
const CLOSED_TOMBSTONES = 4096;
const activationKey = (
  identity: PluginInstanceIdentity,
  binding: PluginInstanceBinding,
) =>
  JSON.stringify([
    identityKey(identity),
    binding.hostId,
    binding.serverId,
    binding.activation.sourceToolName ?? binding.activation.toolName,
    binding.activation.selector.kind,
    binding.activation.selector.kind === "thread"
      ? binding.activation.selector.threadId
      : binding.activation.selector.kind === "quick-action" ||
        binding.activation.selector.kind === "file"
      ? binding.activation.selector.requestId
      : null,
  ]);
/** The activation's lifetime binding (`bindingHash`), compared by the
 * durable store when a launch finds a live original for its anchor. Its host
 * half is `hostRevision` (`pluginHostBindingDigest`), which excludes the
 * client's mutable toggles. `contextEnabled` and `messageEnabled` follow those
 * same toggles and every context or message request re-checks them, so they
 * are excluded too: a toggle never turns a reopen into
 * `ACTIVATION_BINDING_CHANGED`. */
const activationBindingHash = (binding: PluginInstanceBinding) => {
  const {
    contextEnabled: _context,
    messageEnabled: _message,
    ...bound
  } = binding;
  return pluginBindingDigest({ binding: bound });
};
const bindingFromControl = (control: RootControl): PluginInstanceBinding => {
  const { owner, activation, ...root } = control.instance;
  const { operationId: _operation, ...declaration } = activation;
  return {
    ...root,
    runtime: control.runtime,
    serverId: owner.serverId,
    bindingId: owner.bindingId,
    activation: declaration,
  };
};

/** Private service controls retain original identity and effects across retries.
 * Data never confers current tool authority. Every request supplies fresh ports;
 * this registry retains no credentials, manager, request or approval callback.
 */
export class PluginInstanceRegistry {
  private readonly records = new Map<string, InstanceRecord>();
  private readonly modelOwners = new Map<
    string,
    { instance: PluginFormOwner; expiresAt: number; signal: AbortSignal }
  >();

  /** The normal gated model executor owns this lifetime; no UI entrypoint is invented. */
  retainModelOwner(instance: PluginFormOwner, signal: AbortSignal) {
    signal.throwIfAborted();
    this.sweep();
    if (this.modelOwners.size >= this.capacity)
      throw new PluginInvocationError("INSTANCE_LIMIT");
    const key = instance.owner.instanceId;
    if (this.modelOwners.has(key))
      throw new PluginInvocationError("INSTANCE_ALREADY_OWNED");
    const record = {
      instance: structuredClone(instance),
      signal,
      expiresAt: this.now() + this.ttlMs,
    };
    this.modelOwners.set(key, record);
    const release = () => {
      clearTimeout(expiry);
      signal.removeEventListener("abort", release);
      if (this.modelOwners.get(key) !== record) return;
      this.modelOwners.delete(key);
      pluginFormSources.closeOwner(instance.owner);
      pluginFormFileGrants.closeOwner(instance.owner);
    };
    const expiry = setTimeout(release, this.ttlMs);
    expiry.unref();
    signal.addEventListener("abort", release, { once: true });
    return release;
  }
  private readonly closed = new Map<string, number>();
  constructor(
    private readonly now = Date.now,
    private readonly ttlMs = 30 * 60_000,
    private readonly capacity = 512,
  ) {}

  async openActivationPersistent(
    identity: PluginInstanceIdentity,
    binding: PluginInstanceBinding,
    signal: AbortSignal,
    port:
      | PluginInstanceControlPort
      | undefined = createPluginInstanceControlPort(identity),
  ) {
    signal.throwIfAborted();
    // Thread, global, file-viewer and quick-action Apps each own their context
    // and message ports through their OWN instance (own token, own context
    // cursor, own chips). Nothing is inherited from the App that launched them.
    // Settings controls never carry conversation ports.
    if (!pluginConversationKinds.has(binding.activation.selector.kind)) {
      binding = { ...binding, contextEnabled: false, messageEnabled: false };
    }
    this.sweep();
    if (!port?.issueActivation)
      throw new PluginInvocationError("INSTANCE_STORE_UNAVAILABLE");
    const anchor = activationKey(identity, binding);
    const bindingHash = activationBindingHash(binding);
    // One durable round trip: the store atomically returns the live original
    // for this anchor (same token, owner and operation) or issues this
    // candidate. A separate read first would only add a second round trip.
    let saved: { token: string; control: DurablePluginInstanceControl };
    {
      const token = randomBytes(32).toString("base64url");
      const { runtime, serverId, bindingId, activation, ...root } = binding;
      const control = rootControlSchema.parse({
        version: 1,
        runtime,
        expiresAt: this.now() + this.ttlMs,
        instance: {
          ...root,
          owner: {
            actorId: identity.actorId,
            projectId: identity.projectId,
            workspaceId: identity.workspaceId,
            instanceId: randomUUID(),
            generation: 1,
            serverId,
            bindingId,
            placement: "interactive",
          },
          activation: { ...activation, operationId: randomUUID() },
        },
      });
      const snapshotJson = JSON.stringify(control);
      if (Buffer.byteLength(snapshotJson) > PLUGIN_INSTANCE_CONTROL_BYTES)
        throw new PluginInvocationError("INSTANCE_CONTROL_TOO_LARGE");
      // The store atomically returns the original winner even after a lost ACK.
      // Never close an uncertain candidate here: another opener may own its effect.
      saved = await port.issueActivation(
        token,
        {
          anchor,
          bindingHash,
          // Whether a closed or expired activation may be issued anew under
          // the same anchor. It never governs lease renewal: quick-action and
          // file anchors are per request (a retry key can never rotate), yet
          // their live leases renew like any other App's.
          renewable: !["quick-action", "file"].includes(
            activation.selector.kind,
          ),
          snapshotJson,
          ownerHash: pluginInvocationOwnerHash(
            control.instance.owner,
            identity.subject,
          ),
          expiresAt: control.expiresAt,
          ...(control.instance.contextEnabled ? { contextToken: token } : {}),
        },
        signal,
      );
      signal.throwIfAborted();
    }
    const control = this.parseControl(saved.control);
    if (activationBindingHash(bindingFromControl(control)) !== bindingHash)
      throw new PluginInvocationError("ACTIVATION_BINDING_CHANGED");
    const instance = this.restore(saved.token, identity, saved.control);
    return {
      token: saved.token,
      instance,
      /** The current lease; the client renews before it and reopens after. */
      expiresAt: this.records.get(saved.token)!.expiresAt,
    };
  }

  async getPersistent(
    token: string,
    identity: PluginInstanceIdentity,
    signal: AbortSignal,
    port:
      | PluginInstanceControlPort
      | undefined = createPluginInstanceControlPort(identity),
  ) {
    signal.throwIfAborted();
    if (this.closed.has(token))
      throw new PluginInvocationError("INSTANCE_UNAVAILABLE");
    if (!port) throw new PluginInvocationError("INSTANCE_STORE_UNAVAILABLE");
    const saved = await port.read(token, signal);
    signal.throwIfAborted();
    return this.restore(token, identity, saved);
  }

  /** The immutable snapshot carries the original expiry; the durable row's
   * `expiresAt` is the current lease, which renewal may only extend. */
  private parseControl(saved: DurablePluginInstanceControl) {
    if (Buffer.byteLength(saved.snapshotJson) > PLUGIN_INSTANCE_CONTROL_BYTES)
      throw new PluginInvocationError("INSTANCE_CONTROL_INVALID");
    const control = rootControlSchema.parse(JSON.parse(saved.snapshotJson));
    if (
      !Number.isSafeInteger(saved.expiresAt) ||
      saved.expiresAt < control.expiresAt ||
      saved.expiresAt <= this.now()
    )
      throw new PluginInvocationError("INSTANCE_UNAVAILABLE");
    return control;
  }

  private restore(
    token: string,
    identity: PluginInstanceIdentity,
    saved: DurablePluginInstanceControl | null,
  ) {
    this.sweep();
    if (!saved || this.closed.has(token))
      throw new PluginInvocationError("INSTANCE_UNAVAILABLE");
    const control = this.parseControl(saved);
    const owner = control.instance.owner;
    if (
      owner.actorId !== identity.actorId ||
      owner.projectId !== identity.projectId ||
      owner.workspaceId !== identity.workspaceId
    )
      throw new PluginInvocationError("INSTANCE_DENIED");
    const snapshotHash = pluginBindingDigest(saved.snapshotJson);
    const current = this.records.get(token);
    if (current) {
      this.get(token, identity);
      if (
        current.snapshotHash !== snapshotHash ||
        saved.expiresAt < current.expiresAt
      )
        throw new PluginInvocationError("INSTANCE_CONTROL_CHANGED");
      // A renewal (here or in another process) extends the same activation.
      current.expiresAt = saved.expiresAt;
      this.restoreContext(current, saved);
      return current.instance;
    }
    if (
      this.records.size >= this.capacity ||
      [...this.records.values()].filter(
        ({ instance }) =>
          capacityKey({ ...instance.owner, subject: instance.subject }) ===
          capacityKey(identity),
      ).length >= PLUGIN_INSTANCES_PER_ACTOR
    )
      throw new PluginInvocationError("INSTANCE_LIMIT");
    const instance: PluginPreviewInstance = Object.freeze({
      ...control.instance,
      subject: identity.subject,
      owner: Object.freeze(owner),
      serverIdentity: Object.freeze(control.instance.serverIdentity),
      activation: Object.freeze({
        ...control.instance.activation,
        selector: Object.freeze(control.instance.activation.selector),
      }),
    });
    const invoker = new RequestOwnedToolInvoker(owner, () => {
      this.get(token, identity);
    });
    const record: InstanceRecord = {
      instance,
      snapshotHash,
      invoker,
      expiresAt: saved.expiresAt,
      abort: new AbortController(),
    };
    this.restoreContext(record, saved);
    this.records.set(token, record);
    return instance;
  }

  /** A form handle never substitutes for the original live instance authority. */
  getFormOwner(
    owner: TrustedInvocationOwner,
    identity: PluginInstanceIdentity,
  ): PluginFormOwner {
    const model = this.modelOwners.get(owner.instanceId);
    if (
      model &&
      !model.signal.aborted &&
      model.expiresAt > this.now() &&
      identityKey({
        ...model.instance.owner,
        subject: model.instance.subject,
      }) === identityKey(identity) &&
      pluginBindingDigest(model.instance.owner) === pluginBindingDigest(owner)
    )
      return model.instance;
    for (const [token, { instance }] of this.records) {
      if (instance.owner.instanceId !== owner.instanceId) continue;
      const live = this.get(token, identity);
      if (pluginBindingDigest(live.owner) !== pluginBindingDigest(owner))
        throw new PluginInvocationError("FORM_SOURCE_UNAVAILABLE");
      return live;
    }
    throw new PluginInvocationError("FORM_SOURCE_UNAVAILABLE");
  }

  private restoreContext(
    record: InstanceRecord,
    saved: DurablePluginInstanceControl,
  ) {
    const instance = record.instance;
    if (!instance.contextEnabled) return;
    const selector = instance.activation.selector;
    if (!pluginConversationKinds.has(selector.kind))
      throw new PluginInvocationError("INSTANCE_CONTEXT_UNAVAILABLE");
    if (
      !Number.isSafeInteger(saved.contextVersion) ||
      saved.contextVersion! < 0 ||
      (saved.contextVersion! > 0 && !saved.contextJson)
    )
      throw new PluginInvocationError("INSTANCE_CONTEXT_RECOVERY_UNAVAILABLE");
    if (
      record.contextVersion !== undefined &&
      saved.contextVersion! <= record.contextVersion
    )
      return;
    if (!record.context) {
      record.context = new PluginContextWorkspace(instance.owner.workspaceId);
      record.context.attach(
        instance.owner.instanceId,
        instance.owner.generation,
        {
          workspaceId: instance.owner.workspaceId,
          // The session scope is data only: the browser chooses which handles
          // join a turn. File viewers and quick-action Apps are not thread
          // scoped; they follow the active conversation like global Apps.
          scope:
            selector.kind === "thread"
              ? { kind: "thread", threadId: selector.threadId }
              : { kind: "global" },
          pluginVersionId:
            instance.serverIdentity.kind === "plugin"
              ? instance.serverIdentity.pluginVersionId
              : instance.owner.bindingId,
          serverId: instance.owner.serverId,
          bindingId: instance.owner.bindingId,
          origin: {
            kind: selector.kind as "thread" | "global" | "quick-action" | "file",
            id: instance.activation.toolName,
          },
          resourceUri: instance.resourceUri,
        },
      );
    }
    record.context.restore(
      instance.owner.instanceId,
      instance.owner.generation,
      saved.contextJson,
      saved.contextVersion,
    );
    record.contextVersion = saved.contextVersion;
  }
  prepareMessage(
    token: string,
    identity: PluginInstanceIdentity,
    operationId: string,
    fingerprint: string,
  ) {
    const instance = this.get(token, identity);
    if (!instance.messageEnabled)
      throw new PluginInvocationError("INSTANCE_MESSAGE_UNAVAILABLE");
    const record = this.records.get(token)!;
    const receipts = (record.messagePreparations ??= new Map());
    const previous = receipts.get(operationId);
    if (previous && previous !== fingerprint)
      throw new PluginInvocationError("INSTANCE_MESSAGE_CHANGED");
    receipts.set(operationId, fingerprint);
    // Keep a bounded recent window; a long-lived App never runs out of messages.
    for (const key of receipts.keys()) {
      if (receipts.size <= 2048) break;
      receipts.delete(key);
    }
  }

  contextSnapshot(token: string, identity: PluginInstanceIdentity) {
    const instance = this.get(token, identity);
    const context = this.records.get(token)!.context;
    if (!context)
      throw new PluginInvocationError("INSTANCE_CONTEXT_UNAVAILABLE");
    return context.snapshot(
      instance.owner.instanceId,
      instance.owner.generation,
    );
  }
  async changeContextPersistent(
    token: string,
    identity: PluginInstanceIdentity,
    command:
      | { kind: "update"; request: PluginContextUpdate }
      | { kind: "remove"; request: PluginContextRemoval },
    signal: AbortSignal,
    authorize: () => Promise<void>,
    port:
      | PluginInstanceControlPort
      | undefined = createPluginInstanceControlPort(identity),
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const instance = await this.getPersistent(token, identity, signal, port);
      const record = this.records.get(token)!;
      if (!record.context || !port?.writeContext)
        throw new PluginInvocationError("INSTANCE_CONTEXT_UNAVAILABLE");
      const candidate = record.context.fork(
        instance.owner.instanceId,
        instance.owner.generation,
      );
      const before = candidate.export(
        instance.owner.instanceId,
        instance.owner.generation,
      );
      const result =
        command.kind === "update"
          ? candidate.update(
              instance.owner.instanceId,
              instance.owner.generation,
              command.request,
            )
          : candidate.remove(
              instance.owner.instanceId,
              instance.owner.generation,
              command.request,
            );
      const contextJson = candidate.export(
        instance.owner.instanceId,
        instance.owner.generation,
      );
      const expectedVersion = record.contextVersion!;
      await authorize();
      this.get(token, identity);
      signal.throwIfAborted();
      if (contextJson !== before) {
        try {
          const saved = await port.writeContext(
            token,
            { expectedVersion, contextJson },
            AbortSignal.any([signal, record.abort.signal]),
          );
          signal.throwIfAborted();
          this.restoreContext(record, saved);
        } catch (error) {
          if (
            error instanceof PluginInvocationError &&
            error.code === "INSTANCE_CONTEXT_CONFLICT"
          )
            continue;
          throw error;
        }
      }
      await authorize();
      await this.getPersistent(token, identity, signal, port);
      return { result, snapshot: this.contextSnapshot(token, identity) };
    }
    throw new PluginInvocationError("INSTANCE_CONTEXT_CONFLICT");
  }

  /** Extend a retained, authorized instance's lease before it expires. The
   * SAME activation, owner, operation and effect history continue; nothing is
   * re-issued. Visibility is irrelevant: hidden tabs and Apps kept while
   * another chat is selected renew the same way, as do quick-action and
   * file-viewer Apps. A writable file viewer has no fixed ceiling: its file
   * grant renews with it (`ownedFileResources.renew`), so unsaved App state
   * survives a long session. A closed or expired instance cannot be renewed
   * (reopening it is a new activation). */
  async renewPersistent(
    token: string,
    identity: PluginInstanceIdentity,
    signal: AbortSignal,
    authorize: (instance: PluginPreviewInstance) => Promise<void>,
    port:
      | PluginInstanceControlPort
      | undefined = createPluginInstanceControlPort(identity),
  ) {
    const instance = await this.getPersistent(token, identity, signal, port);
    if (!port?.renew)
      throw new PluginInvocationError("INSTANCE_RENEWAL_UNAVAILABLE");
    await authorize(instance);
    signal.throwIfAborted();
    const record = this.records.get(token);
    this.get(token, identity);
    const expiresAt = this.now() + this.ttlMs;
    if (!record || expiresAt <= record.expiresAt)
      return { expiresAt: record?.expiresAt ?? expiresAt, renewed: false };
    let saved: DurablePluginInstanceControl;
    try {
      saved = await port.renew(
        token,
        { expiresAt },
        AbortSignal.any([signal, record.abort.signal]),
      );
    } catch (error) {
      // The store's renew is strictly extend-only. Another process may have
      // already extended further (a lost race), or this activation keeps a
      // fixed deadline (unattended runs, host-selected file bytes). Neither is
      // a failure: report the stored lease as it stands.
      if (
        !(error instanceof PluginInvocationError) ||
        error.code !== "INVALID_INSTANCE_CONTROL"
      )
        throw error;
      signal.throwIfAborted();
      await this.getPersistent(token, identity, signal, port);
      return { expiresAt: this.records.get(token)!.expiresAt, renewed: false };
    }
    signal.throwIfAborted();
    // Re-validate the returned control against the same retained snapshot.
    this.restore(token, identity, saved);
    return { expiresAt: this.records.get(token)!.expiresAt, renewed: true };
  }

  get(token: string, identity: PluginInstanceIdentity) {
    const record = this.records.get(token);
    if (!record || record.expiresAt <= this.now() || this.closed.has(token)) {
      if (record) this.release(token, record);
      throw new PluginInvocationError("INSTANCE_UNAVAILABLE");
    }
    if (
      identityKey({
        ...record.instance.owner,
        subject: record.instance.subject,
      }) !== identityKey(identity)
    )
      throw new PluginInvocationError("INSTANCE_DENIED");
    return record.instance;
  }

  /** One authorization's two reads, each the instance's durable control and
   * the caller's admission query side by side. Both legs are observed,
   * including late failure of either; neither permits the next step alone. */
  private fencedReads(
    token: string,
    identity: PluginInstanceIdentity,
    requestSignal: AbortSignal,
  ) {
    const state: FenceState = { reads: 0, reading: false };
    const read: PluginInstanceAdmissionRead = async (query) => {
      requestSignal.throwIfAborted();
      this.get(token, identity);
      if (state.reading || state.reads >= 2)
        throw new PluginInvocationError("INSTANCE_AUTHORIZATION_INVALID");
      state.reading = true;
      try {
        const [control, admission] = await Promise.allSettled([
          this.getPersistent(token, identity, requestSignal),
          Promise.resolve().then(query),
        ]);
        requestSignal.throwIfAborted();
        if (control.status === "rejected") throw control.reason;
        if (admission.status === "rejected") throw admission.reason;
        this.get(token, identity);
        state.reads++;
        return admission.value;
      } finally {
        state.reading = false;
      }
    };
    return { read, state };
  }

  /**
   * Fenced reads for a request's FIRST authorization, run by the route before
   * the invoker starts (it needs the result to decide approval and to check
   * the call's origin and arguments). They are exactly the reads an invoker
   * authorization makes. Pass the fence to `invoke`: the invoker's first
   * authorization may then reuse that resolution instead of repeating the same
   * two reads with nothing in between, but only when it completed both reads
   * and no other authorization has used it.
   */
  fence(
    token: string,
    identity: PluginInstanceIdentity,
    signal: AbortSignal,
  ): PluginInstanceFence {
    this.get(token, identity);
    const { read, state } = this.fencedReads(token, identity, signal);
    const fence: PluginInstanceFence = Object.freeze({ read });
    fences.set(fence, {
      token,
      identity: identityKey(identity),
      state,
      used: false,
    });
    return fence;
  }

  invoke(
    token: string,
    identity: PluginInstanceIdentity,
    ports: PluginInstanceInvocationPorts,
    invocationId: string,
    params: PluginToolCallParams,
    signal?: AbortSignal,
    origin: PluginInvocationOrigin = "app",
    fence?: PluginInstanceFence,
  ) {
    const instance = this.get(token, identity);
    let first = fence ? fences.get(fence) : undefined;
    if (
      fence &&
      (!first ||
        first.token !== token ||
        first.identity !== identityKey(identity))
    )
      throw new PluginInvocationError("INSTANCE_AUTHORIZATION_INVALID");
    if (
      origin !== "app" &&
      !(
        origin === "settings" &&
        instance.activation.selector.kind === "settings" &&
        instance.activation.settings
      ) &&
      !(
        (origin === "entrypoint" || origin === "quick-action") &&
        invocationId === instance.activation.operationId &&
        params.name === instance.activation.toolName
      )
    )
      throw new PluginInvocationError("INSTANCE_DENIED");
    return this.records.get(token)!.invoker.invoke(
      {
        ...ports,
        authorize: async (owner, callOrigin, next, requestSignal) => {
          if (ports.authorizeInstance) {
            // Only the first authorization may stand on the route's fence,
            // and only when that fence made both of its reads.
            const prior =
              first &&
              !first.used &&
              !first.state.reading &&
              first.state.reads === 2
                ? first
                : undefined;
            first = undefined;
            const { read, state } = this.fencedReads(
              token,
              identity,
              requestSignal,
            );
            const authorization = await ports.authorizeInstance(
              owner,
              callOrigin,
              next,
              requestSignal,
              read,
            );
            if (state.reading)
              throw new PluginInvocationError("INSTANCE_AUTHORIZATION_INVALID");
            if (state.reads !== 2) {
              if (state.reads !== 0 || !prior || prior.used)
                throw new PluginInvocationError(
                  "INSTANCE_AUTHORIZATION_INVALID",
                );
              prior.used = true;
            }
            this.get(token, identity);
            return authorization;
          }
          await this.getPersistent(token, identity, requestSignal);
          const authorization = await ports.authorize(
            owner,
            callOrigin,
            next,
            requestSignal,
          );
          await this.getPersistent(token, identity, requestSignal);
          return authorization;
        },
      },
      origin,
      invocationId,
      params,
      signal,
    );
  }

  signal(token: string, identity: PluginInstanceIdentity) {
    this.get(token, identity);
    return this.records.get(token)!.abort.signal;
  }

  /** Cleanup survives rollout denial. The caller still proves actor and subject. */
  async closePersistent(
    token: string,
    identity: PluginInstanceIdentity,
    signal: AbortSignal,
    port:
      | PluginInstanceControlPort
      | undefined = createPluginInstanceControlPort(identity),
  ) {
    const record = this.records.get(token);
    if (
      record &&
      identityKey({
        ...record.instance.owner,
        subject: record.instance.subject,
      }) !== identityKey(identity)
    )
      throw new PluginInvocationError("INSTANCE_DENIED");
    if (!port) throw new PluginInvocationError("INSTANCE_STORE_UNAVAILABLE");
    // Verify an unknown handle before allocating a local tombstone.
    if (!record && !this.closed.has(token)) {
      const saved = await port.read(token, signal);
      signal.throwIfAborted();
      if (!saved) return;
    }
    this.tombstone(token, record?.expiresAt ?? this.now() + this.ttlMs);
    if (record) this.release(token, record);
    await port.close(token, signal);
  }

  private release(token: string, record: InstanceRecord) {
    this.records.delete(token);
    record.context?.close(record.instance.owner.instanceId);
    record.abort.abort();
    pluginFormSources.closeOwner(record.instance.owner);
    pluginFormFileGrants.closeOwner(record.instance.owner);
    record.invoker.close();
  }
  private tombstone(token: string, expiresAt: number) {
    this.closed.delete(token);
    this.closed.set(token, expiresAt);
    // The durable store keeps refusing an evicted tombstone's handle.
    for (const key of this.closed.keys()) {
      if (this.closed.size <= CLOSED_TOMBSTONES) break;
      this.closed.delete(key);
    }
  }
  private sweep() {
    for (const [token, expiry] of this.closed)
      if (expiry <= this.now()) this.closed.delete(token);
    for (const [token, record] of this.records)
      if (record.expiresAt <= this.now()) this.release(token, record);
  }
}
export const pluginInstances = new PluginInstanceRegistry();
