import { randomUUID } from "node:crypto";
import { pluginResourceToolMetadata } from "./resource-metadata.js";

export interface ResourceOwner {
  actorId: string;
  projectId: string;
  /** Verified credential subject, never taken from resource metadata. */
  subject: string;
  workspaceId: string;
  instanceId: string;
  generation: number;
  serverId: string;
  bindingId: string;
}

export interface ResourceVersion {
  bytes: Uint8Array;
  etag: string;
  mimeType?: string;
}

export type ResourceWriteOutcome =
  | { outcome: "saved" | "conflict"; etag: string }
  | { outcome: "too-large"; maxBytes: number };

/** Trusted adapter keys and authorization never cross the browser boundary. */
export interface BoundResourceAdapter {
  read(key: string, signal: AbortSignal): Promise<ResourceVersion>;
  /** Present only for an adapter with verified atomic compare-and-replace. */
  conditionalWrite?: (
    key: string,
    bytes: Uint8Array,
    ifMatch: string | undefined,
    signal: AbortSignal,
  ) => Promise<Exclude<ResourceWriteOutcome, { outcome: "too-large" }>>;
  watch?: (
    key: string,
    changed: () => void,
    signal: AbortSignal,
  ) => Promise<() => void>;
}

interface Grant {
  owner: ResourceOwner;
  uri: string;
  key: string;
  privatePath?: string;
  adapter: BoundResourceAdapter;
  controller: AbortController;
  expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout>;
  writableRead: boolean;
  /** Issued again under its URI after the previous grant was lost (a
   * restart, or a lapsed or refused renewal). Nothing carries over: the App
   * reads the file again before it may write. */
  reissued: boolean;
  stopWatch?: () => void;
  subscribing?: Promise<void>;
  watchGeneration: number;
}

export class ResourceGrantError extends Error {
  constructor(
    readonly code:
      | "RESOURCE_DENIED"
      | "RESOURCE_UNSUPPORTED"
      | "RESOURCE_TOO_LARGE"
      | "RESOURCE_INVALID"
      | "RESOURCE_NOT_TEXT"
      | "RESOURCE_OUTCOME_UNKNOWN"
      | "RESOURCE_READ_REQUIRED",
  ) {
    super(code);
    this.name = "ResourceGrantError";
  }
}

/**
 * One service per authorized workspace. Its caller derives owner/binding from
 * trusted session state, never iframe params. authorize re-resolves live scope
 * and target access for EVERY operation (including delivery of watch events).
 */
export class ResourceGrantService {
  private readonly grants = new Map<string, Grant>();
  constructor(
    private readonly options: {
      authorize: (
        owner: Readonly<ResourceOwner>,
        operation: "read" | "write" | "subscribe" | "tool",
      ) => Promise<void>;
      maxBytes: number;
      maxGrants?: number;
      mintId?: () => string;
      now?: () => number;
      maxAgeMs?: number;
    },
  ) {
    if (
      !Number.isSafeInteger(options.maxAgeMs ?? 30 * 60_000) ||
      (options.maxAgeMs ?? 30 * 60_000) < 1 ||
      (options.maxAgeMs ?? 30 * 60_000) > 30 * 60_000
    )
      throw new Error("Invalid resource lifetime");
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
      throw new Error("Invalid resource byte limit");
    if (
      !Number.isSafeInteger(options.maxGrants ?? 64) ||
      (options.maxGrants ?? 64) < 1
    )
      throw new Error("Invalid resource grant limit");
  }

  /** Host-only: adapter and key must come from an already authorized open. */
  open(
    owner: ResourceOwner,
    resource: {
      key: string;
      adapter: BoundResourceAdapter;
      privatePath?: string;
      expiresAt?: number;
      reissued?: boolean;
    },
  ) {
    for (const [uri, grant] of this.grants)
      if (grant.expiresAt <= this.now()) this.revoke(uri);
    if (
      [
        owner.actorId,
        owner.projectId,
        owner.subject,
        owner.workspaceId,
        owner.instanceId,
        owner.serverId,
        owner.bindingId,
      ].some((value) => typeof value !== "string" || !value.trim()) ||
      !Number.isSafeInteger(owner.generation) ||
      owner.generation < 1
    )
      throw new ResourceGrantError("RESOURCE_DENIED");
    const now = this.now();
    const expiresAt = Math.min(
      resource.expiresAt ?? Infinity,
      now + (this.options.maxAgeMs ?? 30 * 60_000),
    );
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now)
      throw new ResourceGrantError("RESOURCE_DENIED");
    if (this.grants.size >= (this.options.maxGrants ?? 64))
      throw new ResourceGrantError("RESOURCE_DENIED");
    const uri = `host-resource://${(this.options.mintId ?? randomUUID)()}`;
    if (this.grants.has(uri)) throw new Error("Resource grant ID collision");
    const expiryTimer = setTimeout(() => this.revoke(uri), expiresAt - now);
    expiryTimer.unref?.();
    this.grants.set(uri, {
      ...resource,
      uri,
      owner: { ...owner },
      expiresAt,
      expiryTimer,
      controller: new AbortController(),
      writableRead: false,
      reissued: resource.reissued === true,
      watchGeneration: 0,
    });
    return { resourceUri: uri };
  }

  /** Whether this owner still holds a live grant for the URI. */
  live(owner: ResourceOwner, uri: string) {
    try {
      this.require(owner, uri);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Extend a live grant: the SAME URI, adapter, read state and watches,
   * never past one grant lifetime from now. The caller authorizes first
   * (its owner is live, its target and toggles still allow it). A lapsed or
   * revoked grant is never revived. Returns the grant's deadline.
   */
  extend(owner: ResourceOwner, uri: string, expiresAt: number) {
    const grant = this.require(owner, uri);
    const now = this.now();
    const next = Math.min(
      expiresAt,
      now + (this.options.maxAgeMs ?? 30 * 60_000),
    );
    if (!Number.isSafeInteger(next) || next <= grant.expiresAt)
      return grant.expiresAt;
    clearTimeout(grant.expiryTimer);
    grant.expiresAt = next;
    grant.expiryTimer = setTimeout(() => this.revoke(uri), next - now);
    grant.expiryTimer.unref?.();
    return next;
  }

  private now() {
    return (this.options.now ?? Date.now)();
  }

  private require(owner: ResourceOwner, uri: string): Grant {
    const grant = this.grants.get(uri);
    if (grant && grant.expiresAt <= this.now()) {
      this.revoke(uri);
      throw new ResourceGrantError("RESOURCE_DENIED");
    }
    if (
      !grant ||
      grant.controller.signal.aborted ||
      Object.keys(grant.owner).some(
        (key) =>
          grant.owner[key as keyof ResourceOwner] !==
          owner[key as keyof ResourceOwner],
      )
    ) {
      throw new ResourceGrantError("RESOURCE_DENIED");
    }
    return grant;
  }

  private async authorize(
    owner: ResourceOwner,
    uri: string,
    operation: "read" | "write" | "subscribe" | "tool",
  ) {
    const grant = this.require(owner, uri);
    try {
      await this.options.authorize(grant.owner, operation);
    } catch {
      this.revoke(uri);
      throw new ResourceGrantError("RESOURCE_DENIED");
    }
    if (this.require(owner, uri) !== grant)
      throw new ResourceGrantError("RESOURCE_DENIED");
    return grant;
  }

  async read(
    owner: ResourceOwner,
    params: { uri: string; representation?: "text" | "blob" },
    signal?: AbortSignal,
  ) {
    const grant = await this.authorize(owner, params.uri, "read");
    const activeSignal = signal
      ? AbortSignal.any([signal, grant.controller.signal])
      : grant.controller.signal;
    activeSignal.throwIfAborted();
    const version = await grant.adapter.read(grant.key, activeSignal);
    activeSignal.throwIfAborted();
    await this.authorize(owner, params.uri, "read");
    if (version.bytes.byteLength > this.options.maxBytes)
      throw new ResourceGrantError("RESOURCE_TOO_LARGE");
    let text: string | undefined;
    if (params.representation !== "blob") {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(version.bytes);
      } catch {
        if (params.representation === "text")
          throw new ResourceGrantError("RESOURCE_NOT_TEXT");
      }
    }
    grant.writableRead = !!grant.adapter.conditionalWrite;
    return {
      contents: [
        {
          uri: grant.uri,
          ...(version.mimeType ? { mimeType: version.mimeType } : {}),
          ...(text === undefined
            ? { blob: Buffer.from(version.bytes).toString("base64") }
            : { text }),
          _meta: {
            "openai/resource": {
              etag: version.etag,
              writable: grant.writableRead,
            },
          },
        },
      ],
    };
  }

  async write(
    owner: ResourceOwner,
    params: { uri: string; ifMatch?: string; text?: string; blob?: string },
    signal?: AbortSignal,
  ): Promise<ResourceWriteOutcome> {
    const grant = await this.authorize(owner, params.uri, "write");
    if (!grant.adapter.conditionalWrite)
      throw new ResourceGrantError("RESOURCE_DENIED");
    // A write follows a read that reported the file writable. A grant issued
    // again says so plainly: the App's unsaved state is its own, and the
    // read gives it the current version (and ETag) to save against.
    if (!grant.writableRead)
      throw new ResourceGrantError(
        grant.reissued ? "RESOURCE_READ_REQUIRED" : "RESOURCE_DENIED",
      );
    if (
      (typeof params.text === "string") === (typeof params.blob === "string") ||
      (params.ifMatch !== undefined && params.ifMatch.length === 0)
    )
      throw new ResourceGrantError("RESOURCE_INVALID");
    if (
      params.blob !== undefined &&
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        params.blob,
      )
    )
      throw new ResourceGrantError("RESOURCE_INVALID");
    const byteLength =
      params.text !== undefined
        ? Buffer.byteLength(params.text)
        : Buffer.byteLength(params.blob!, "base64");
    if (byteLength > this.options.maxBytes)
      return { outcome: "too-large", maxBytes: this.options.maxBytes };
    const bytes =
      params.text !== undefined
        ? new TextEncoder().encode(params.text)
        : Buffer.from(params.blob!, "base64");
    const activeSignal = signal
      ? AbortSignal.any([signal, grant.controller.signal])
      : grant.controller.signal;
    activeSignal.throwIfAborted();
    // After dispatch a lost acknowledgement cannot justify an automatic retry.
    let result: Exclude<ResourceWriteOutcome, { outcome: "too-large" }>;
    try {
      result = await grant.adapter.conditionalWrite(
        grant.key,
        bytes,
        params.ifMatch,
        activeSignal,
      );
      activeSignal.throwIfAborted();
      await this.authorize(owner, params.uri, "write");
    } catch {
      throw new ResourceGrantError("RESOURCE_OUTCOME_UNKNOWN");
    }
    return result;
  }

  async subscribe(
    owner: ResourceOwner,
    uri: string,
    changed: (uri: string) => void,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const grant = await this.authorize(owner, uri, "subscribe");
    signal?.throwIfAborted();
    if (!grant.adapter.watch)
      throw new ResourceGrantError("RESOURCE_UNSUPPORTED");
    if (grant.stopWatch) return;
    if (grant.subscribing) return grant.subscribing;
    const generation = ++grant.watchGeneration;
    const installing = new AbortController();
    const active = AbortSignal.any([
      grant.controller.signal,
      installing.signal,
    ]);
    const cancel = () => installing.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    let scheduled = false;
    const notify = () => {
      if (scheduled || grant.controller.signal.aborted) return;
      scheduled = true;
      queueMicrotask(() => {
        void this.authorize(owner, uri, "subscribe")
          .then(() => {
            if (grant.stopWatch && grant.watchGeneration === generation)
              changed(uri);
          })
          .catch(() => {})
          .finally(() => {
            scheduled = false;
          });
      });
    };
    grant.subscribing = (async () => {
      const stop = await grant.adapter.watch!(grant.key, notify, active);
      if (this.grants.get(uri) !== grant || active.aborted) {
        stop();
        throw new ResourceGrantError("RESOURCE_DENIED");
      }
      grant.stopWatch = () => {
        installing.abort();
        stop();
      };
      await this.authorize(owner, uri, "subscribe");
      if (active.aborted) {
        grant.stopWatch?.();
        grant.stopWatch = undefined;
        throw new ResourceGrantError("RESOURCE_DENIED");
      }
    })();
    try {
      await grant.subscribing;
    } finally {
      signal?.removeEventListener("abort", cancel);
      grant.subscribing = undefined;
    }
  }

  async unsubscribe(owner: ResourceOwner, uri: string) {
    // Fence already queued delivery synchronously, after the ownership check.
    ++this.require(owner, uri).watchGeneration;
    const grant = await this.authorize(owner, uri, "subscribe");
    // Await an in-flight install so unsubscribe cannot race it into a leak.
    await grant.subscribing;
    grant.stopWatch?.();
    grant.stopWatch = undefined;
  }

  /** Reserved path is derived here for the trusted server call, never from app metadata. */
  async toolMetadata(
    owner: ResourceOwner,
    uri: string,
    metadata: Record<string, unknown> = {},
  ) {
    const grant = await this.authorize(owner, uri, "tool");
    return pluginResourceToolMetadata(metadata, grant.privatePath);
  }

  revoke(uri: string) {
    const grant = this.grants.get(uri);
    if (!grant) return;
    this.grants.delete(uri);
    clearTimeout(grant.expiryTimer);
    grant.controller.abort();
    grant.stopWatch?.();
  }

  closeInstance(instanceId: string) {
    this.revokeMatching((grant) => grant.owner.instanceId === instanceId);
  }

  closeBinding(bindingId: string) {
    this.revokeMatching((grant) => grant.owner.bindingId === bindingId);
  }

  dispose() {
    this.revokeMatching(() => true);
  }

  private revokeMatching(matches: (grant: Grant) => boolean) {
    const failures: unknown[] = [];
    for (const [uri, grant] of this.grants) {
      if (!matches(grant)) continue;
      try {
        this.revoke(uri);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Resource cleanup failed");
  }
}
