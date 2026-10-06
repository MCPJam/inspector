import { randomBytes } from "node:crypto";
import { PLUGIN_FORM_SCHEMA_MAX_BYTES } from "../../../shared/plugin-form-payload-limits.js";
import { pluginBindingDigest } from "./bindings.js";
import {
  PluginInvocationError,
  type ResolvedInvocationContext,
  type TrustedInvocationOwner,
} from "./invocation.js";

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
  fingerprint: string;
  bytes: number;
  abort: AbortController;
  expiry: ReturnType<typeof setTimeout>;
};
const fail = (): never => {
  throw new PluginInvocationError("FORM_SOURCE_UNAVAILABLE");
};
const sameOwner = (a: TrustedInvocationOwner, b: TrustedInvocationOwner) =>
  pluginBindingDigest(a) === pluginBindingDigest(b);

/**
 * Links a human form to the admitted operation that actually elicited it.
 * Contains immutable data only, never bearers, managers or request closures.
 * Handles confer no resource/execution authority: consumers must additionally
 * resolve the original live instance and revalidate its saved host and target.
 * Process-local prototype: restart loses the link and fails closed.
 */
export class PluginFormSourceRegistry {
  private readonly records = new Map<string, SourceRecord>();
  constructor(
    private readonly now = Date.now,
    private readonly capacity = 1024,
    private readonly byteCapacity = 16 * 1024 * 1024,
  ) {}

  bind(source: PluginFormSource) {
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
      if (record.fingerprint !== fingerprint) fail();
      return { token, release: () => this.remove(token) };
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
    const token = randomBytes(32).toString("base64url");
    const expiry = setTimeout(
      () => this.remove(token),
      Math.max(0, snapshot.expiresAt - this.now()),
    );
    expiry.unref();
    this.records.set(token, {
      source: snapshot,
      fingerprint,
      bytes,
      abort: new AbortController(),
      expiry,
    });
    return { token, release: () => this.remove(token) };
  }

  get(
    token: string,
    actor: Pick<
      TrustedInvocationOwner,
      "actorId" | "projectId" | "workspaceId"
    >,
    parent: PluginFormParent,
  ) {
    this.sweep();
    const record = this.records.get(token);
    if (
      !record ||
      record.source.owner.actorId !== actor.actorId ||
      record.source.owner.projectId !== actor.projectId ||
      record.source.owner.workspaceId !== actor.workspaceId ||
      pluginBindingDigest(parent) !== pluginBindingDigest(record.source.parent)
    )
      return fail();
    return {
      source: structuredClone(record.source),
      signal: record.abort.signal,
    };
  }

  /** Trusted original-operation lookup. Caller must still revalidate durable admission. */
  find(
    owner: TrustedInvocationOwner,
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
        return { token, ...this.get(token, owner, parent) };
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
