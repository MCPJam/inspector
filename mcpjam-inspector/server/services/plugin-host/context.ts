import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { PLUGIN_INSTANCE_CONTEXT_BYTES } from "../../../shared/plugin-invocation-receipts.js";
import {
  createPluginSession,
  reducePluginSession,
  pluginContextForTurn,
  type PluginInstanceIdentity,
  type PluginSessionState,
} from "@mcpjam/sdk/internal/plugin-host";
import {
  parsePluginModelContext,
  pluginContextAttachments,
  type PluginContextSnapshot,
  type PluginModelContext,
} from "../../../shared/plugin-model-context.js";
import { PluginInvocationError } from "./invocation.js";

type Cursor = {
  operationId: string;
  fingerprint: string;
  sequence: number;
  updateId: string;
};
export type PluginContextUpdate = {
  operationId: string;
  sequence: number;
  params: unknown;
};
export type PluginContextRemoval = {
  operationId: string;
  updateId: string;
  index: number;
};
/** Removal receipts kept for idempotent retries. Older receipts are compacted
 * away: a retry of a compacted removal is refused as stale (its updateId no
 * longer matches), never applied twice, so the window bounds storage without
 * ever stopping context. */
export const PLUGIN_CONTEXT_REMOVAL_WINDOW = 256;
const safeCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const persistedContextSchema = z
  .object({
    version: z.literal(1),
    // Monotonic counters with no product ceiling; only the cursor's latest
    // value is kept, so a long-lived App never runs out of updates.
    revision: safeCount,
    cursor: z
      .object({
        operationId: z.string().min(1).max(128),
        fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        sequence: safeCount.min(1),
        updateId: z.string().uuid(),
      })
      .strict()
      .nullable(),
    context: z
      .object({ updateId: z.string().uuid(), params: z.unknown() })
      .strict()
      .nullable(),
    removals: z
      .array(z.tuple([z.string().min(1).max(128), z.string().max(160)]))
      .max(PLUGIN_CONTEXT_REMOVAL_WINDOW),
  })
  .strict();

/** One core session per trusted workspace namespace, shared by HTTP and run owners. */
export class PluginContextWorkspace {
  private state: PluginSessionState;
  private readonly cursors = new Map<string, Cursor>();
  private readonly revisions = new Map<string, number>();
  private readonly removals = new Map<string, Map<string, string>>();
  constructor(workspaceId: string) {
    this.state = createPluginSession(workspaceId);
  }

  attach(
    instanceId: string,
    generation: number,
    identity: PluginInstanceIdentity,
  ) {
    const transition = reducePluginSession(this.state, {
      type: "attach",
      instanceId,
      generation,
      identity,
    });
    if (transition.rejection)
      throw new PluginInvocationError(transition.rejection);
    this.state = transition.state;
  }

  /** Data-only context control; no effects, invocation history or replacement identity. */
  export(instanceId: string, generation: number): string {
    const snapshot = this.snapshot(instanceId, generation);
    const context = this.state.instances[instanceId].context;
    const json = JSON.stringify({
      version: 1,
      revision: snapshot.revision,
      cursor: this.cursors.has(instanceId)
        ? {
            operationId: this.cursors.get(instanceId)!.operationId,
            fingerprint: this.cursors.get(instanceId)!.fingerprint,
            sequence: this.cursors.get(instanceId)!.sequence,
            updateId: this.cursors.get(instanceId)!.updateId,
          }
        : null,
      context: context
        ? {
            updateId: context.updateId,
            params: {
              content: context.content,
              ...(context.structuredContent
                ? { structuredContent: context.structuredContent }
                : {}),
              ...(context.metadata ? { _meta: context.metadata } : {}),
            },
          }
        : null,
      removals: [...(this.removals.get(instanceId) ?? [])],
    });
    if (Buffer.byteLength(json, "utf8") > PLUGIN_INSTANCE_CONTEXT_BYTES)
      throw new PluginInvocationError("INSTANCE_CONTEXT_TOO_LARGE");
    return json;
  }

  restore(
    instanceId: string,
    generation: number,
    json?: string,
    expectedRevision?: number,
  ) {
    this.snapshot(instanceId, generation);
    if (!json) {
      if (expectedRevision !== undefined && expectedRevision !== 0)
        throw new PluginInvocationError("INSTANCE_CONTEXT_INVALID");
      return;
    }
    if (Buffer.byteLength(json, "utf8") > PLUGIN_INSTANCE_CONTEXT_BYTES)
      throw new PluginInvocationError("INSTANCE_CONTEXT_INVALID");
    const saved = persistedContextSchema.parse(JSON.parse(json));
    if (expectedRevision !== undefined && saved.revision !== expectedRevision)
      throw new PluginInvocationError("INSTANCE_CONTEXT_INVALID");
    if (
      (saved.cursor?.sequence ?? 0) > saved.revision ||
      (saved.revision === 0) !== !saved.context ||
      (saved.revision === 0) !== !saved.cursor ||
      new Set(saved.removals.map(([id]) => id)).size !== saved.removals.length
    )
      throw new PluginInvocationError("INSTANCE_CONTEXT_INVALID");
    if (saved.context) {
      const params = parsePluginModelContext(saved.context.params);
      const next = reducePluginSession(this.state, {
        type: "context",
        instanceId,
        generation,
        updateId: saved.context.updateId,
        content: params.content ?? [],
        structuredContent: params.structuredContent,
        metadata: params._meta,
      });
      if (next.rejection) throw new PluginInvocationError(next.rejection);
      this.state = next.state;
    }
    if (saved.cursor) this.cursors.set(instanceId, saved.cursor);
    this.revisions.set(instanceId, saved.revision);
    this.removals.set(instanceId, new Map(saved.removals));
  }

  /** Mutations prepare on a separate core session; failed storage never leaks optimism. */
  fork(instanceId: string, generation: number) {
    this.snapshot(instanceId, generation);
    const copy = new PluginContextWorkspace(this.state.workspaceId);
    copy.attach(
      instanceId,
      generation,
      this.state.instances[instanceId].identity,
    );
    copy.restore(instanceId, generation, this.export(instanceId, generation));
    return copy;
  }

  /** The caller validates the private lease and fresh authority before this commit. */
  update(instanceId: string, generation: number, request: PluginContextUpdate) {
    const instance = this.state.instances[instanceId];
    if (
      !instance ||
      instance.lifecycle !== "active" ||
      instance.generation !== generation
    )
      throw new PluginInvocationError("INSTANCE_CONTEXT_UNAVAILABLE");
    const params = parsePluginModelContext(request.params);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(params))
      .digest("hex");
    const receipt = this.cursors.get(instanceId);
    if (receipt?.operationId === request.operationId) {
      if (
        receipt.fingerprint !== fingerprint ||
        receipt.sequence !== request.sequence
      )
        throw new PluginInvocationError("INSTANCE_CONTEXT_DUPLICATE_MISMATCH");
      return {
        _meta: { "openai/modelContext": { updateId: receipt.updateId } },
      };
    }
    // Sequences stay strictly monotonic (stale and replayed-out-of-order
    // requests are refused) without any lifetime ceiling.
    if (
      !request.operationId ||
      request.operationId.length > 128 ||
      !Number.isSafeInteger(request.sequence) ||
      request.sequence !== (receipt?.sequence ?? 0) + 1
    )
      throw new PluginInvocationError("INSTANCE_CONTEXT_SEQUENCE_DENIED");
    const updateId = randomUUID();
    const transition = reducePluginSession(this.state, {
      type: "context",
      instanceId,
      generation,
      updateId,
      content: params.content ?? [],
      structuredContent: params.structuredContent,
      metadata: params._meta,
    });
    if (transition.rejection)
      throw new PluginInvocationError(transition.rejection);
    this.state = transition.state;
    this.revisions.set(instanceId, (this.revisions.get(instanceId) ?? 0) + 1);
    this.cursors.set(instanceId, {
      operationId: request.operationId,
      sequence: request.sequence,
      fingerprint,
      updateId,
    });
    return { _meta: { "openai/modelContext": { updateId } } };
  }

  snapshot(instanceId: string, generation: number): PluginContextSnapshot {
    const instance = this.state.instances[instanceId];
    if (
      !instance ||
      instance.lifecycle !== "active" ||
      instance.generation !== generation
    )
      throw new PluginInvocationError("INSTANCE_CONTEXT_UNAVAILABLE");
    const context = instance.context;
    return {
      revision: this.revisions.get(instanceId) ?? 0,
      sequence: this.cursors.get(instanceId)?.sequence ?? 0,
      state:
        context && (context.content.length || context.structuredContent)
          ? (structuredClone({
              updateId: context.updateId,
              content: context.content,
              ...(context.structuredContent
                ? { structuredContent: context.structuredContent }
                : {}),
            }) as NonNullable<PluginContextSnapshot["state"]>)
          : null,
    };
  }

  /** An explicit composer action removes one current visible block, never app-supplied replacement data. */
  remove(
    instanceId: string,
    generation: number,
    request: PluginContextRemoval,
  ) {
    const snapshot = this.snapshot(instanceId, generation);
    const fingerprint = JSON.stringify([request.updateId, request.index]);
    const receipts = this.removals.get(instanceId) ?? new Map<string, string>();
    const previous = receipts.get(request.operationId);
    if (previous) {
      if (previous !== fingerprint)
        throw new PluginInvocationError("INSTANCE_CONTEXT_DUPLICATE_MISMATCH");
      // A retry cannot resurrect the earlier snapshot after a later app update.
      return snapshot;
    }
    if (!request.operationId || request.operationId.length > 128)
      throw new PluginInvocationError("INSTANCE_CONTEXT_REMOVAL_INVALID");
    if (
      !snapshot.state ||
      snapshot.state.updateId !== request.updateId ||
      !Number.isSafeInteger(request.index) ||
      !pluginContextAttachments(snapshot).some(
        (item) => item.index === request.index,
      )
    )
      throw new PluginInvocationError("INSTANCE_CONTEXT_REMOVAL_STALE");
    const current = this.state.instances[instanceId].context!;
    const transition = reducePluginSession(this.state, {
      type: "context",
      instanceId,
      generation,
      updateId: randomUUID(),
      content: current.content.filter((_, index) => index !== request.index),
      structuredContent:
        request.index === current.content.length
          ? undefined
          : current.structuredContent,
      metadata: current.metadata,
    });
    if (transition.rejection)
      throw new PluginInvocationError(transition.rejection);
    this.state = transition.state;
    this.revisions.set(instanceId, snapshot.revision + 1);
    receipts.set(request.operationId, fingerprint);
    // Compact: keep the most recent window in insertion order.
    for (const key of receipts.keys()) {
      if (receipts.size <= PLUGIN_CONTEXT_REMOVAL_WINDOW) break;
      receipts.delete(key);
    }
    this.removals.set(instanceId, receipts);
    return this.snapshot(instanceId, generation);
  }

  contexts(threadId: string): PluginModelContext[] {
    return pluginContextForTurn(this.state, threadId).map(
      ({ instanceId, generation, updateId, content, structuredContent }) => ({
        instanceId,
        generation,
        updateId,
        content,
        ...(structuredContent ? { structuredContent } : {}),
      }),
    );
  }

  close(instanceId: string) {
    this.state = reducePluginSession(this.state, {
      type: "close",
      instanceId,
    }).state;
    this.cursors.delete(instanceId);
    this.revisions.delete(instanceId);
    this.removals.delete(instanceId);
    const instance = this.state.instances[instanceId];
    if (instance?.lifecycle === "closed") {
      // The enclosing owner revoked/removed this UUID lease before release.
      // Adopted context instances have no operation references or live effects.
      const released = reducePluginSession(this.state, {
        type: "release-closed",
        instanceId,
        generation: instance.generation,
      });
      if (released.rejection)
        throw new PluginInvocationError(released.rejection);
      this.state = released.state;
    }
  }
}
