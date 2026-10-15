import { PluginContextWorkspace } from "./context.js";
import { randomBytes, randomUUID } from "node:crypto";
import { PLUGIN_MODEL_APP_META } from "../../../shared/plugin-model-app.js";
import type { PluginFormOwner, PluginInstanceIdentity } from "./instances.js";
import { pluginBindingDigest, pluginResourceUri } from "./bindings.js";
import { PluginInvocationError } from "./invocation.js";
import { RequestOwnedToolInvoker } from "./request-invoker.js";
const denied = () => new PluginInvocationError("MODEL_APP_UNAVAILABLE");
const identity = (owner: PluginFormOwner) => ({
  ...owner.owner,
  subject: owner.subject,
});
function matches(owner: PluginFormOwner, actor: PluginInstanceIdentity) {
  const expected = identity(owner);
  return (
    expected.actorId === actor.actorId &&
    expected.projectId === actor.projectId &&
    expected.workspaceId === actor.workspaceId &&
    expected.subject === actor.subject
  );
}
export class ModelAppRegistry {
  private readonly entries = new Map<
    string,
    {
      context: PluginContextWorkspace;
      messages: Map<string, string>;
      owner: PluginFormOwner;
      toolName: string;
      revision: string;
      resourceUri: string;
      invoker: RequestOwnedToolInvoker;
      abort: AbortController;
      expiry: ReturnType<typeof setTimeout>;
      expiresAt: number;
    }
  >();
  private readonly sources = new Map<string, string>();
  constructor(private readonly ttlMs = 30 * 60_000) {}
  /** Trusted completion only: callers have already passed the original model approval. */
  publish(
    result: unknown,
    source: PluginFormOwner,
    toolName: string,
    revision: string,
    toolMeta: unknown,
  ) {
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      (result as any).isError === true
    )
      return result;
    let resourceUri: string;
    try {
      resourceUri = pluginResourceUri(
        toolMeta && typeof toolMeta === "object" && !Array.isArray(toolMeta)
          ? (toolMeta as Record<string, unknown>)
          : undefined,
      );
    } catch {
      return result;
    }
    const anchor = pluginBindingDigest([source, toolName, revision]);
    let token = this.sources.get(anchor);
    if (!token) {
      if (this.sources.size >= 512)
        return {
          ...result,
          _meta: { [PLUGIN_MODEL_APP_META]: { unavailable: true } },
        };
      token = randomBytes(32).toString("base64url");
      const owner: PluginFormOwner = {
        ...structuredClone(source),
        owner: { ...source.owner, instanceId: randomUUID() },
      };
      const actor = identity(owner);
      const abort = new AbortController();
      const key = token;
      const invoker = new RequestOwnedToolInvoker(owner.owner, () =>
        this.get(key, actor),
      );
      const expiry = setTimeout(() => this.close(key, actor), this.ttlMs);
      expiry.unref();
      const context = new PluginContextWorkspace(owner.owner.workspaceId);
      context.attach(owner.owner.instanceId, owner.owner.generation, {
        workspaceId: owner.owner.workspaceId,
        scope: {
          kind: "thread",
          threadId: owner.owner.workspaceId,
        },
        pluginVersionId: owner.owner.bindingId,
        serverId: owner.owner.serverId,
        bindingId: owner.owner.bindingId,
        origin: { kind: "thread", id: toolName },
        resourceUri,
      });
      this.entries.set(key, {
        context,
        messages: new Map(),
        owner,
        toolName,
        revision,
        resourceUri,
        invoker,
        abort,
        expiry,
        expiresAt: Date.now() + this.ttlMs,
      });
      this.sources.set(anchor, key);
    }
    const meta = (result as any)._meta;
    return {
      ...result,
      _meta: {
        ...(meta && typeof meta === "object" && !Array.isArray(meta)
          ? meta
          : {}),
        [PLUGIN_MODEL_APP_META]: {
          instanceToken: token,
          projectId: source.owner.projectId,
          workspaceId: source.owner.workspaceId,
          hostId: source.hostId,
          serverId: source.owner.serverId,
        },
      },
    };
  }
  has(token: string) {
    return this.entries.has(token);
  }
  prepareMessage(
    token: string,
    actor: PluginInstanceIdentity,
    id: string,
    fingerprint: string,
  ) {
    const record = this.get(token, actor);
    const previous = record.messages.get(id);
    if (previous && previous !== fingerprint)
      throw new PluginInvocationError("INSTANCE_MESSAGE_CHANGED");
    record.messages.set(id, fingerprint);
    // Bounded recent window; a long-lived App never runs out of messages.
    for (const key of record.messages.keys()) {
      if (record.messages.size <= 2048) break;
      record.messages.delete(key);
    }
  }
  /** Extend a retained model App's lifetime; the same App and its effect
   * history continue. Closed or expired Apps cannot be renewed. */
  renew(token: string, actor: PluginInstanceIdentity) {
    const entry = this.get(token, actor);
    clearTimeout(entry.expiry);
    entry.expiry = setTimeout(() => this.close(token, actor), this.ttlMs);
    entry.expiry.unref();
    entry.expiresAt = Date.now() + this.ttlMs;
    return entry.expiresAt;
  }
  get(token: string, actor: PluginInstanceIdentity) {
    const entry = this.entries.get(token);
    if (!entry || entry.abort.signal.aborted || !matches(entry.owner, actor))
      throw denied();
    return entry;
  }
  close(token: string, actor: PluginInstanceIdentity) {
    const entry = this.entries.get(token);
    if (!entry) return;
    if (!matches(entry.owner, actor)) throw denied();
    this.entries.delete(token);
    clearTimeout(entry.expiry);
    entry.abort.abort();
    entry.invoker.close();
    entry.context.close(entry.owner.owner.instanceId);
    // Retain source tombstones so replaying a completed tool never mints a new App.
  }
}
export const modelApps = new ModelAppRegistry();
