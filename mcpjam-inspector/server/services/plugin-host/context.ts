import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { PLUGIN_INSTANCE_CONTEXT_BYTES } from "../../../shared/plugin-invocation-receipts.js";
import {
  MODEL_CONTEXT_POLICY_CEILINGS,
  MODEL_CONTEXT_POLICY_DEFAULTS,
} from "@mcpjam/sdk/host-config/internal";
import {
  createPluginSession,
  reducePluginSession,
  pluginContextForTurn,
  type PluginInstanceIdentity,
  type PluginSessionState,
} from "@mcpjam/sdk/internal/plugin-host";
import {
  parsePluginModelContext,
  type PluginContextLimits,
  type PluginContextRemoveAllResult,
  type PluginContextSnapshot,
  type PluginModelContext,
} from "../../../shared/plugin-model-context.js";
import { PluginInvocationError } from "./invocation.js";
import {
  contextRemovalSnapshot,
  decideContextRemoveAll,
  NO_CONTEXT_REMOVALS,
  persistedRemovalCursorSchema,
  PLUGIN_CONTEXT_REMOVAL_WINDOW,
  recordContextRemoveAll,
  recordContextUserAttach,
  type PluginContextRemovalCursor,
  type PluginContextRemoveAll,
} from "./context-removal.js";

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
  /** The person was using the App when it sent this (see `held` below). */
  attach?: "user";
};
export { PLUGIN_CONTEXT_REMOVAL_WINDOW, type PluginContextRemoveAll };
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
    held: z.literal(true).optional(),
    // Absent in context saved before remove-all existed: no removals yet.
    removal: persistedRemovalCursorSchema.optional(),
  })
  .strict();

/** One core session per trusted workspace namespace, shared by HTTP and run owners. */
export class PluginContextWorkspace {
  private state: PluginSessionState;
  private readonly cursors = new Map<string, Cursor>();
  private readonly revisions = new Map<string, number>();
  private readonly removals = new Map<string, Map<string, string>>();
  /**
   * Instances whose context the person removed. The spec has the host send
   * the App `null` and leaves the rest to the App, and some Apps post their
   * view again at once (Bits & Bolts redraws, its camera settles, and it
   * re-sends). A removal stays removed: until the person uses the App again
   * (an update marked `attach: "user"`), its updates are refused.
   */
  private readonly held = new Set<string>();
  private readonly removalCursors = new Map<
    string,
    PluginContextRemovalCursor
  >();
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
      ...(this.held.has(instanceId) ? { held: true } : {}),
      ...(this.removal(instanceId).cursor
        ? { removal: this.removal(instanceId) }
        : {}),
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
      // Admitted when it was stored, under whatever policy and `_meta` cap
      // held then.
      const params = parsePluginModelContext(saved.context.params, {
        ...MODEL_CONTEXT_POLICY_CEILINGS,
        metaMaxBytes: MODEL_CONTEXT_POLICY_CEILINGS.updateMaxBytes,
      });
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
    if (saved.held) this.held.add(instanceId);
    else this.held.delete(instanceId);
    this.removalCursors.set(instanceId, saved.removal ?? NO_CONTEXT_REMOVALS);
  }

  private removal(instanceId: string) {
    return this.removalCursors.get(instanceId) ?? NO_CONTEXT_REMOVALS;
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

  /** The caller validates the private lease and fresh authority before this
   * commit. `limits` are the budgets this new update is admitted against. */
  update(
    instanceId: string,
    generation: number,
    request: PluginContextUpdate,
    limits: PluginContextLimits = MODEL_CONTEXT_POLICY_DEFAULTS,
  ) {
    const instance = this.state.instances[instanceId];
    if (
      !instance ||
      instance.lifecycle !== "active" ||
      instance.generation !== generation
    )
      throw new PluginInvocationError("INSTANCE_CONTEXT_UNAVAILABLE");
    const params = parsePluginModelContext(request.params, limits);
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
    if (this.held.has(instanceId) && request.attach !== "user")
      throw new PluginInvocationError("INSTANCE_CONTEXT_HELD");
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
    this.held.delete(instanceId);
    if (request.attach === "user")
      this.removalCursors.set(
        instanceId,
        recordContextUserAttach(this.removal(instanceId)),
      );
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
      ...contextRemovalSnapshot(
        this.held.has(instanceId),
        this.removal(instanceId),
      ),
    };
  }

  /**
   * The person removed this App's context from the chat: clear all of it
   * (visible blocks, assistant-only blocks and structured content) and hold
   * the App until they use it again. A retry with the same operation is
   * decided by its basis (`decideContextRemoveAll`); only an applied removal
   * changes anything.
   */
  removeAll(
    instanceId: string,
    generation: number,
    request: PluginContextRemoveAll,
  ): PluginContextRemoveAllResult {
    this.snapshot(instanceId, generation);
    const receipts = this.removals.get(instanceId) ?? new Map<string, string>();
    const decision = decideContextRemoveAll({
      request,
      receipt: receipts.get(request.operationId),
      held: this.held.has(instanceId),
      removal: this.removal(instanceId),
    });
    if (decision !== "apply")
      return {
        outcome: decision,
        snapshot: this.snapshot(instanceId, generation),
      };
    const transition = reducePluginSession(this.state, {
      type: "context",
      instanceId,
      generation,
      updateId: randomUUID(),
      content: [],
      structuredContent: undefined,
      metadata: undefined,
    });
    if (transition.rejection)
      throw new PluginInvocationError(transition.rejection);
    this.state = transition.state;
    this.revisions.set(instanceId, (this.revisions.get(instanceId) ?? 0) + 1);
    this.removalCursors.set(
      instanceId,
      recordContextRemoveAll(receipts, request, this.removal(instanceId)),
    );
    this.removals.set(instanceId, receipts);
    this.held.add(instanceId);
    return {
      outcome: "applied",
      snapshot: this.snapshot(instanceId, generation),
    };
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
    this.held.delete(instanceId);
    this.removalCursors.delete(instanceId);
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
