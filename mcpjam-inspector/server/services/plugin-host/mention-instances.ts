import { randomBytes, randomUUID } from "node:crypto";
import { RequestOwnedToolInvoker } from "./request-invoker.js";
import {
  PluginInvocationError,
  type PluginInvocationPorts,
} from "./invocation.js";
import type {
  PluginInstanceIdentity,
  PluginPreviewInstance,
} from "./instances.js";
import type { PluginServerIdentity } from "./bindings.js";
import {
  pluginMentionQuerySchema,
  parsePluginMentionItems,
} from "../../../shared/plugin-mentions.js";

type Binding = {
  runtime: "chatgpt" | "codex";
  hostId: string;
  hostRevision: string;
  serverId: string;
  bindingId: string;
  serverIdentity: Readonly<PluginServerIdentity>;
  toolName: string;
  revision: string;
};
export type PluginMentionLease = Pick<
  PluginPreviewInstance,
  "owner" | "subject" | "hostId" | "hostRevision" | "serverIdentity"
> &
  Pick<Binding, "toolName" | "revision">;

/** Headless composer lifetime. No bearer, manager, renderer or URI reader retained. */
export class PluginMentionRegistry {
  private records = new Map<
    string,
    {
      lease: PluginMentionLease;
      invoker: RequestOwnedToolInvoker;
      expires: number;
    }
  >();
  constructor(
    private now = Date.now,
    private ttlMs = 30 * 60_000,
    private capacity = 512,
  ) {}
  open(identity: PluginInstanceIdentity, binding: Binding) {
    for (const [token, record] of this.records)
      if (record.expires <= this.now()) this.release(token);
    if (
      this.records.size >= this.capacity ||
      [...this.records.values()].filter(
        ({ lease }) =>
          lease.owner.actorId === identity.actorId &&
          lease.owner.projectId === identity.projectId &&
          lease.owner.workspaceId === identity.workspaceId,
      ).length >= 64
    )
      throw new PluginInvocationError("INSTANCE_LIMIT");
    const token = randomBytes(32).toString("base64url");
    const owner: Readonly<PluginPreviewInstance["owner"]> = Object.freeze({
      actorId: identity.actorId,
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      serverId: binding.serverId,
      bindingId: binding.bindingId,
      instanceId: randomUUID(),
      generation: 1,
      placement: "interactive",
    });
    const lease = Object.freeze({
      owner,
      subject: identity.subject,
      hostId: binding.hostId,
      hostRevision: binding.hostRevision,
      serverIdentity: Object.freeze(structuredClone(binding.serverIdentity)),
      toolName: binding.toolName,
      revision: binding.revision,
    });
    const invoker = new RequestOwnedToolInvoker(owner, () => this.live(token));
    this.records.set(token, {
      lease,
      invoker,
      expires: this.now() + this.ttlMs,
    });
    return { token, lease };
  }
  private live(token: string) {
    const record = this.records.get(token);
    if (!record || record.expires <= this.now()) {
      this.release(token);
      throw new PluginInvocationError("INSTANCE_DENIED");
    }
    return record;
  }
  get(token: string, identity: PluginInstanceIdentity) {
    const { lease } = this.live(token);
    if (
      lease.owner.actorId !== identity.actorId ||
      lease.owner.projectId !== identity.projectId ||
      lease.owner.workspaceId !== identity.workspaceId ||
      lease.subject !== identity.subject
    )
      throw new PluginInvocationError("INSTANCE_DENIED");
    return lease;
  }
  async search(
    token: string,
    identity: PluginInstanceIdentity,
    ports: PluginInvocationPorts,
    id: string,
    query: unknown,
    signal: AbortSignal,
  ) {
    const lease = this.get(token, identity);
    const args = pluginMentionQuerySchema.parse(query);
    const result = await this.live(token).invoker.invoke(
      ports,
      "mention",
      id,
      { name: lease.toolName, arguments: args },
      signal,
    );
    signal.throwIfAborted();
    this.get(token, identity);
    parsePluginMentionItems(result);
    return result;
  }
  close(token: string, identity: PluginInstanceIdentity) {
    // Cleanup is authorized by ownership, even after rollout/target permission loss.
    this.get(token, identity);
    this.release(token);
  }
  private release(token: string) {
    const record = this.records.get(token);
    this.records.delete(token);
    record?.invoker.close();
  }
}
export const pluginMentionInstances = new PluginMentionRegistry();
