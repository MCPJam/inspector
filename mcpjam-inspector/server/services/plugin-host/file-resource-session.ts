import {
  parsePluginFileInput,
  parsePluginFileRead,
  pluginFileWriteParamsSchema,
  pluginFileSubscriptionParamsSchema,
  parsePluginFileWriteResult,
} from "../../../shared/plugin-file.js";
import { pluginBindingDigest } from "./bindings.js";
import {
  ResourceGrantService,
  ResourceGrantError,
  type BoundResourceAdapter,
  type ResourceOwner,
} from "./resource-grants.js";

import { waitForPluginOperation } from "../../../shared/plugin-operation.js";

/** Only an already-authorized execution target produces this private binding. */
export interface TrustedPluginFileResource {
  /** Stable target-local identity, not a browser selected path. */
  key: string;
  name: string;
  privatePath?: string;
  adapter: BoundResourceAdapter;
  maxBytes: number;
  /** Grant expires no later than the original authorized target. */
  expiresAt?: number;
  /** Existing target/run write policy. Absence keeps even CAS adapters read-only. */
  authorizeWrite?: (signal: AbortSignal) => Promise<void>;
}

/**
 * One file per instance. The target session and live authority belong to the
 * caller; this service neither provisions a target nor retains request auth.
 */
export function createPluginFileResourceSession(options: {
  owner: ResourceOwner;
  resource: TrustedPluginFileResource;
  signal: AbortSignal;
  /** Re-resolve the existing actor/target policy, not an admission snapshot. */
  authorize: (signal: AbortSignal) => Promise<void>;
  assertLive: () => void;
  /** Host-derived original identity from verified private control recovery.
   * Read-only grants may reuse an identity on their own. A writable or
   * watched grant reuses one only with `stableIdentity`: its URI then stays
   * the same for its owner, while write receipts and watches stay volatile. */
  resourceId?: string;
  /** A writable or watched grant keeps its owner's URI. The first grant and
   * any later one share it; a later one is `reissued`. */
  stableIdentity?: boolean;
  /** This grant replaces a lost one under the same URI (a restart, or a
   * lapsed or refused renewal): nothing carries over, and the App reads the
   * file again before it may write. */
  reissued?: boolean;
}) {
  const { signal: lifetime, authorize, assertLive } = options;
  const resourceId = options.resourceId;
  /** At most one grant lifetime ahead; renewal moves it (see `renew`). */
  const deadline = () =>
    Math.min(options.resource.expiresAt ?? Infinity, Date.now() + 30 * 60_000);
  let expiresAt = deadline();
  lifetime.throwIfAborted();
  assertLive();
  const owner = Object.freeze({ ...options.owner });
  const { key, name, privatePath, adapter, maxBytes, authorizeWrite } =
    options.resource;
  if (
    resourceId !== undefined &&
    (!/^[a-f0-9]{64}$/.test(resourceId) ||
      (!options.stableIdentity &&
        ((!!authorizeWrite && !!adapter.conditionalWrite) || !!adapter.watch)))
  )
    throw new Error("PLUGIN_FILE_RECOVERY_UNSUPPORTED");
  if (
    !key ||
    (privatePath !== undefined &&
      (!privatePath.startsWith("/") || privatePath.includes("\0")))
  )
    throw new Error("PLUGIN_FILE_BINDING_INVALID");
  const authorizeOperation = async (
    operation: "read" | "write" | "subscribe" | "tool",
  ) => {
    lifetime.throwIfAborted();
    if (Date.now() >= expiresAt)
      throw new ResourceGrantError("RESOURCE_DENIED");
    assertLive();
    await authorize(lifetime);
    if (operation === "write") {
      if (!authorizeWrite) throw new Error("PLUGIN_FILE_WRITE_DENIED");
      await authorizeWrite(lifetime);
      // Approval/policy waits cannot preserve stale actor or target authority.
      await authorize(lifetime);
    }
    lifetime.throwIfAborted();
    if (Date.now() >= expiresAt)
      throw new ResourceGrantError("RESOURCE_DENIED");
    assertLive();
  };
  const ports: BoundResourceAdapter = Object.freeze({
    read: adapter.read.bind(adapter),
    ...(authorizeWrite && adapter.conditionalWrite
      ? { conditionalWrite: adapter.conditionalWrite.bind(adapter) }
      : {}),
    ...(adapter.watch ? { watch: adapter.watch.bind(adapter) } : {}),
  });
  const grants = new ResourceGrantService({
    maxBytes,
    maxGrants: 1,
    ...(resourceId ? { mintId: () => resourceId } : {}),
    authorize: (_owner, operation) => authorizeOperation(operation),
  });
  const opened = grants.open(owner, {
    key,
    adapter: ports,
    privatePath,
    expiresAt,
    reissued: options.reissued === true,
  });
  const writes = new Map<
    string,
    {
      digest: string;
      result: Promise<Awaited<ReturnType<typeof grants.write>>>;
    }
  >();
  let input: ReturnType<typeof parsePluginFileInput>;
  try {
    input = parsePluginFileInput({ file: { name, ...opened } });
  } catch (error) {
    grants.dispose();
    writes.clear();
    throw error;
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    lifetime.removeEventListener("abort", close);
    writes.clear();
    grants.dispose();
  };
  lifetime.addEventListener("abort", close, { once: true });
  // Constructors may synchronously revoke the caller's authority.
  if (lifetime.aborted) close();
  return {
    input: structuredClone(input),
    /** The grant's current deadline. `renew` moves it while its owner is
     * live and authorized; once it passes, a later grant replaces it. */
    get expiresAt() {
      return expiresAt;
    },
    /** The grant still stands: not closed, not lapsed, not revoked. */
    get live() {
      return (
        !closed &&
        !lifetime.aborted &&
        Date.now() < expiresAt &&
        grants.live(owner, opened.resourceUri)
      );
    },
    /**
     * Keep this grant for a live, renewing owner: the SAME URI, adapter,
     * read state (`writable` and its ETag semantics), write receipts and
     * watches, extended to at most one grant lifetime from now. It runs the
     * same fresh authorization as a read (actor, target and toggles); a
     * refusal leaves the grant to lapse at its current deadline.
     * A lapsed or revoked grant is never revived here.
     */
    renew: (signal?: AbortSignal) => {
      const active = signal ? AbortSignal.any([lifetime, signal]) : lifetime;
      return waitForPluginOperation(active, async () => {
        active.throwIfAborted();
        if (closed || Date.now() >= expiresAt)
          throw new ResourceGrantError("RESOURCE_DENIED");
        assertLive();
        // Writes keep their own policy check on every write.
        await authorize(active);
        active.throwIfAborted();
        assertLive();
        if (closed) throw new ResourceGrantError("RESOURCE_DENIED");
        expiresAt = grants.extend(owner, opened.resourceUri, deadline());
        return expiresAt;
      });
    },
    capabilities: Object.freeze({
      write: !!ports.conditionalWrite,
      subscribe: !!ports.watch,
    }),
    read: (params: unknown, signal?: AbortSignal) => {
      const parsed = parsePluginFileRead(params);
      const active = signal ? AbortSignal.any([lifetime, signal]) : lifetime;
      return waitForPluginOperation(active, () =>
        grants.read(owner, parsed, active),
      );
    },
    async write(operationId: string, params: unknown, signal?: AbortSignal) {
      const parsed = pluginFileWriteParamsSchema.parse(params);
      const active = signal ? AbortSignal.any([lifetime, signal]) : lifetime;
      return waitForPluginOperation(active, async () => {
        await authorizeOperation("write");
        active.throwIfAborted();
        const digest = pluginBindingDigest(parsed);
        const previous = writes.get(operationId);
        if (previous) {
          if (previous.digest !== digest)
            throw new Error("PLUGIN_FILE_OPERATION_CHANGED");
          return previous.result;
        }
        if (!operationId || operationId.length > 128 || writes.size >= 512)
          throw new Error("PLUGIN_FILE_OPERATION_DENIED");
        // Retain rejected/unknown results too: a lost acknowledgement is not a
        // license to repeat a dispatched write under the same operation ID.
        const result = grants.write(owner, parsed, active).then((value) => {
          try {
            return parsePluginFileWriteResult(value);
          } catch {
            throw new ResourceGrantError("RESOURCE_OUTCOME_UNKNOWN");
          }
        });
        writes.set(operationId, { digest, result });
        return result;
      });
    },
    subscribe(
      params: unknown,
      changed: (uri: string) => void,
      signal?: AbortSignal,
    ) {
      const parsed = pluginFileSubscriptionParamsSchema.parse(params);
      const active = signal ? AbortSignal.any([lifetime, signal]) : lifetime;
      return waitForPluginOperation(active, () =>
        grants.subscribe(owner, parsed.uri, changed, active),
      );
    },
    async unsubscribe(params: unknown) {
      const parsed = pluginFileSubscriptionParamsSchema.parse(params);
      await grants.unsubscribe(owner, parsed.uri);
    },
    toolMetadata: (metadata?: Record<string, unknown>) =>
      grants.toolMetadata(owner, opened.resourceUri, metadata),
    close,
  };
}
