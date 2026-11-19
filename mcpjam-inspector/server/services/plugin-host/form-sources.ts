import { randomBytes } from "node:crypto";
import { logger } from "../../utils/logger.js";
import { PLUGIN_FORM_SCHEMA_MAX_BYTES } from "../../../shared/plugin-form-payload-limits.js";
import { pluginBindingDigest } from "./bindings.js";
import {
  PluginInvocationError,
  type ResolvedInvocationContext,
  type TrustedInvocationOwner,
} from "./invocation.js";
import type { PluginInstanceIdentity } from "./instances.js";
import {
  createPluginInstanceControlPort,
  type PluginInstanceControlPort,
} from "./instance-store.js";
import {
  formSourceFromRow,
  parseFormSource,
  readFormSourceSchema,
  storeFormSource,
  type PluginFormOwnerRef,
} from "./form-source-control.js";

import type { PluginFormParent } from "../../../shared/plugin-form-services.js";
export type { PluginFormParent } from "../../../shared/plugin-form-services.js";

export interface PluginFormSource {
  owner: TrustedInvocationOwner;
  hostId: string;
  hostRevision: string;
  invocationId: string;
  origin: ResolvedInvocationContext["origin"];
  revision: string;
  toolName: string;
  parent: PluginFormParent;
  requestedSchema: unknown;
  expiresAt: number;
  /** Where accepted uploads are placed: this machine (local stdio servers)
   * or the project's Computer (hosted servers running there). */
  uploadTarget?: "local-stdio" | "computer";
  /** The client's File resources toggle when the form was elicited; absent
   * counts as off. */
  fileResources?: boolean;
}

type SourceRecord = {
  source: PluginFormSource;
  /** The credential subject the form was elicited under. */
  subject: string;
  /** The stored row's owner, for an MRTR source any replica can restore. */
  ownerRef?: PluginFormOwnerRef;
  fingerprint: string;
  bytes: number;
  abort: AbortController;
  expiry: ReturnType<typeof setTimeout>;
};
const fail = (): never => {
  throw new PluginInvocationError("FORM_SOURCE_UNAVAILABLE");
};
/** An unreachable store, reported as the form's. */
const storeError = (error: unknown) =>
  error instanceof PluginInvocationError &&
  error.code === "INSTANCE_STORE_UNAVAILABLE"
    ? new PluginInvocationError("FORM_STORE_UNAVAILABLE")
    : error;
const sameOwner = (a: TrustedInvocationOwner, b: TrustedInvocationOwner) =>
  pluginBindingDigest(a) === pluginBindingDigest(b);

/**
 * Links a human form to the admitted operation that actually elicited it.
 * Contains immutable data only, never bearers, managers or request closures.
 * Handles confer no resource/execution authority: consumers must additionally
 * resolve the original live instance and revalidate its saved host and target.
 * An MRTR source with an owner row is stored (`bindStored`), so any replica
 * restores it; this map is then a cache. Other sources live in this process
 * only, and a restart loses them and fails closed.
 */
export class PluginFormSourceRegistry {
  private readonly records = new Map<string, SourceRecord>();
  constructor(
    private readonly now = Date.now,
    private readonly capacity = 1024,
    private readonly byteCapacity = 16 * 1024 * 1024,
    private readonly portFor: (
      identity: PluginInstanceIdentity,
    ) => PluginInstanceControlPort | undefined = createPluginInstanceControlPort,
  ) {}

  /** A process-local source, as legacy and inline forms use. */
  bind(source: PluginFormSource, subject: string) {
    const prepared = this.prepare(source, subject);
    return (
      prepared.existing ??
      this.insert(randomBytes(32).toString("base64url"), prepared, subject)
    );
  }

  /** An MRTR source stored before its token reaches the browser, so any
   * replica can serve the form and its answer. A store failure refuses it. */
  async bindStored(
    source: PluginFormSource,
    identity: PluginInstanceIdentity,
    ownerRef: PluginFormOwnerRef,
    signal: AbortSignal,
  ) {
    const prepared = this.prepare(source, identity.subject);
    if (prepared.existing) return prepared.existing;
    const port = this.portFor(identity);
    if (!port) throw new PluginInvocationError("FORM_NOT_SAVED");
    const token = randomBytes(32).toString("base64url");
    try {
      await storeFormSource(
        port,
        token,
        identity,
        prepared.snapshot,
        ownerRef,
        signal,
      );
    } catch (error) {
      signal.throwIfAborted();
      logger.warn("Form not shown: its source was not stored", {
        code: error instanceof PluginInvocationError ? error.code : undefined,
      });
      throw new PluginInvocationError("FORM_NOT_SAVED");
    }
    signal.throwIfAborted();
    // A concurrent bind of the same parent here won; this row expires unused.
    const again = this.prepare(source, identity.subject);
    if (again.existing) return again.existing;
    return this.insert(token, again, identity.subject, ownerRef);
  }

  /**
   * This process's copy of a stored MRTR source, restored on a miss. The
   * schema comes from `knownSchema` when it matches the row's digest (the
   * resume has the pending form), otherwise from the call's receipt.
   */
  async restore(
    token: string,
    identity: PluginInstanceIdentity,
    parent: PluginFormParent,
    signal: AbortSignal,
    knownSchema?: unknown,
  ) {
    this.sweep();
    if (this.records.has(token)) return this.get(token, identity, parent);
    if (parent.kind !== "mrtr") return fail();
    const port = this.portFor(identity);
    if (!port) throw new PluginInvocationError("FORM_STORE_UNAVAILABLE");
    let saved;
    try {
      saved = await port.read(token, signal);
    } catch (error) {
      // Closed, expired or another identity's row: the form is gone for this caller.
      if (
        error instanceof PluginInvocationError &&
        ["INSTANCE_UNAVAILABLE", "INSTANCE_DENIED"].includes(error.code)
      )
        return fail();
      throw storeError(error);
    }
    signal.throwIfAborted();
    const row = saved ? parseFormSource(saved) : undefined;
    if (
      !row ||
      row.source.owner.actorId !== identity.actorId ||
      row.source.owner.projectId !== identity.projectId ||
      row.source.owner.workspaceId !== identity.workspaceId ||
      pluginBindingDigest(row.source.parent) !== pluginBindingDigest(parent)
    )
      return fail();
    const schema =
      knownSchema !== undefined &&
      pluginBindingDigest(knownSchema) === row.source.schemaDigest
        ? knownSchema
        : await readFormSourceSchema(row, identity, signal);
    signal.throwIfAborted();
    if (!this.records.has(token)) {
      const prepared = this.prepare(formSourceFromRow(row, schema), identity.subject);
      if (prepared.existing) return fail();
      this.insert(token, prepared, identity.subject, row.ownerRef);
    }
    return this.get(token, identity, parent);
  }

  /** Read a stored source again, after a wait. A row closed or expired on
   * any replica drops this process's copy, which aborts what it started. */
  async refresh(
    token: string,
    identity: PluginInstanceIdentity,
    parent: PluginFormParent,
    signal: AbortSignal,
  ) {
    this.get(token, identity, parent);
    const port = this.portFor(identity);
    if (!port) throw new PluginInvocationError("FORM_STORE_UNAVAILABLE");
    let saved;
    try {
      saved = await port.read(token, signal);
    } catch (error) {
      if (
        !(error instanceof PluginInvocationError) ||
        !["INSTANCE_UNAVAILABLE", "INSTANCE_DENIED"].includes(error.code)
      )
        throw storeError(error);
      saved = null;
    }
    if (!saved || !parseFormSource(saved)) {
      this.remove(token);
      return fail();
    }
    return this.get(token, identity, parent);
  }

  private prepare(
    source: PluginFormSource,
    subject: string,
  ):
    | { existing: { token: string; release: () => void } }
    | {
        existing?: undefined;
        snapshot: PluginFormSource;
        fingerprint: string;
        bytes: number;
      } {
    this.sweep();
    if (
      Object.values(source.owner).some(
        (value) => typeof value === "string" && !value,
      ) ||
      !source.owner.actorId ||
      !source.owner.projectId ||
      !source.owner.workspaceId ||
      !source.owner.instanceId ||
      !source.owner.serverId ||
      !source.owner.bindingId ||
      !Number.isSafeInteger(source.owner.generation) ||
      source.owner.generation < 1 ||
      !source.hostId ||
      !source.hostRevision ||
      !source.revision ||
      !source.toolName ||
      !source.invocationId ||
      source.invocationId.length > 128 ||
      !source.parent.id ||
      source.parent.id.length > 256 ||
      !Number.isFinite(source.expiresAt) ||
      source.expiresAt <= this.now() ||
      source.expiresAt > this.now() + 30 * 60_000 ||
      (source.parent.kind === "legacy" && source.parent.round !== 0) ||
      (source.parent.kind === "mrtr" &&
        (!Number.isSafeInteger(source.parent.round) ||
          source.parent.round < 1 ||
          !source.parent.inputRequestKey ||
          source.parent.inputRequestKey.length > 256))
    )
      fail();
    const snapshot = structuredClone(source);
    const schemaBytes = Buffer.byteLength(
      JSON.stringify(snapshot.requestedSchema) ?? "",
    );
    if (!schemaBytes || schemaBytes > PLUGIN_FORM_SCHEMA_MAX_BYTES) fail();
    const bytes = Buffer.byteLength(JSON.stringify(snapshot));
    const fingerprint = pluginBindingDigest(snapshot);
    for (const [token, record] of this.records) {
      if (
        pluginBindingDigest(record.source.parent) !==
        pluginBindingDigest(snapshot.parent)
      )
        continue;
      // A parent identifies one immutable origin, not a replaceable browser label.
      if (record.fingerprint !== fingerprint || record.subject !== subject)
        fail();
      return { existing: { token, release: () => this.remove(token) } };
    }
    const owned = [...this.records.values()].filter(
      ({ source: value }) =>
        value.owner.actorId === source.owner.actorId &&
        value.owner.projectId === source.owner.projectId &&
        value.owner.workspaceId === source.owner.workspaceId,
    );
    if (
      this.records.size >= this.capacity ||
      owned.length >= 32 ||
      [...this.records.values()].reduce(
        (sum, value) => sum + value.bytes,
        bytes,
      ) > this.byteCapacity
    )
      throw new PluginInvocationError("FORM_SOURCE_LIMIT");
    return { snapshot, fingerprint, bytes };
  }

  private insert(
    token: string,
    prepared: { snapshot: PluginFormSource; fingerprint: string; bytes: number },
    subject: string,
    ownerRef?: PluginFormOwnerRef,
  ) {
    const expiry = setTimeout(
      () => this.remove(token),
      Math.max(0, prepared.snapshot.expiresAt - this.now()),
    );
    expiry.unref();
    this.records.set(token, {
      source: prepared.snapshot,
      subject,
      ...(ownerRef ? { ownerRef } : {}),
      fingerprint: prepared.fingerprint,
      bytes: prepared.bytes,
      abort: new AbortController(),
      expiry,
    });
    return { token, release: () => this.remove(token) };
  }

  /** This process's copy, checked against the caller's full identity,
   * credential subject included. */
  get(token: string, actor: PluginInstanceIdentity, parent: PluginFormParent) {
    this.sweep();
    const record = this.records.get(token);
    if (
      !record ||
      record.subject !== actor.subject ||
      record.source.owner.actorId !== actor.actorId ||
      record.source.owner.projectId !== actor.projectId ||
      record.source.owner.workspaceId !== actor.workspaceId ||
      pluginBindingDigest(parent) !== pluginBindingDigest(record.source.parent)
    )
      return fail();
    return {
      source: structuredClone(record.source),
      signal: record.abort.signal,
      ownerRef: record.ownerRef,
    };
  }

  /** Trusted original-operation lookup. Caller must still revalidate durable admission. */
  find(
    owner: TrustedInvocationOwner,
    subject: string,
    invocationId: string,
    parent: PluginFormParent,
  ) {
    this.sweep();
    for (const [token, { source }] of this.records)
      if (
        sameOwner(owner, source.owner) &&
        source.invocationId === invocationId &&
        pluginBindingDigest(parent) === pluginBindingDigest(source.parent)
      )
        return { token, ...this.get(token, { ...owner, subject }, parent) };
    return fail();
  }

  closeRound(
    owner: TrustedInvocationOwner,
    invocationId: string,
    id: string,
    round: number,
  ) {
    for (const [token, { source }] of this.records)
      if (
        sameOwner(owner, source.owner) &&
        source.invocationId === invocationId &&
        source.parent.id === id &&
        source.parent.round === round
      )
        this.remove(token);
  }

  closeOperation(owner: TrustedInvocationOwner, invocationId: string) {
    for (const [token, { source }] of this.records)
      if (
        sameOwner(owner, source.owner) &&
        source.invocationId === invocationId
      )
        this.remove(token);
  }

  closeOwner(owner: TrustedInvocationOwner) {
    for (const [token, { source }] of this.records)
      if (sameOwner(owner, source.owner)) this.remove(token);
  }

  /** Call only after the actor-owned durable store confirms cancel/terminal ACK. */
  closeSettledMrtrParent(id: string) {
    for (const [token, { source }] of this.records)
      if (source.parent.kind === "mrtr" && source.parent.id === id)
        this.remove(token);
  }

  private remove(token: string) {
    const record = this.records.get(token);
    this.records.delete(token);
    if (record) clearTimeout(record.expiry);
    record?.abort.abort();
  }
  private sweep() {
    for (const [token, { source }] of this.records)
      if (source.expiresAt <= this.now()) this.remove(token);
  }
}

export const pluginFormSources = new PluginFormSourceRegistry();
