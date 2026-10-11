import { modelApps } from "./model-apps.js";
import { messagePreparations } from "./message-preparations.js";
import type { Context } from "hono";
import type { UIMessage } from "ai";
import {
  pluginMessageIntentSchema,
  pluginMessageParts,
  pluginMessageTarget,
} from "../../../shared/plugin-message.js";
import type { PluginWorkspaceAdmission } from "./admission.js";
import { pluginInstances } from "./instances.js";
import { pluginBindingDigest } from "./bindings.js";
import { createPluginRequestRuntime } from "./request-runtime.js";
import { resolveOpenPluginActivation } from "./activation.js";
import { toolApprovalSubjectFromAuthHeader } from "../../utils/tool-approval-token.js";
import { PluginInvocationError } from "./invocation.js";

/** Normal chat execution rechecks the exact source before accepting an App turn. */
type MessageTurnOptions = {
  c: Context;
  intent: unknown;
  messages: UIMessage[];
  hostId?: string;
  serverIds: readonly string[];
  threadId?: string;
  admission?: PluginWorkspaceAdmission;
  bearer?: string;
  prepareOnly?: boolean;
};
export function preparePluginMessageTurn(
  options: MessageTurnOptions & { prepareOnly: true },
): Promise<string>;
export function preparePluginMessageTurn(
  options: MessageTurnOptions,
): Promise<UIMessage[]>;
export async function preparePluginMessageTurn(
  options: MessageTurnOptions,
): Promise<UIMessage[] | string> {
  if (options.intent === undefined) {
    if (options.prepareOnly)
      throw new PluginInvocationError("INSTANCE_MESSAGE_UNAVAILABLE");
    return options.messages;
  }
  const intent = pluginMessageIntentSchema.parse(options.intent);
  const { admission, bearer, c } = options;
  const deny = () => new PluginInvocationError("INSTANCE_MESSAGE_UNAVAILABLE");
  if (!admission || !bearer || !options.hostId || !options.threadId)
    throw deny();
  const actor = {
    actorId: admission.actorId,
    projectId: admission.projectId,
    workspaceId: admission.workspaceId,
    subject: toolApprovalSubjectFromAuthHeader(c.req.header("authorization")),
  };
  const { preparationToken, ...originalIntent } = intent;
  const intentDigest = pluginBindingDigest(originalIntent);
  if (preparationToken) {
    if (
      options.prepareOnly ||
      pluginMessageTarget(intent.params) !== "new" ||
      options.threadId === intent.sourceThreadId
    )
      throw deny();
    const prepared = messagePreparations.read(preparationToken, {
      actorId: actor.actorId,
      projectId: actor.projectId,
      subject: actor.subject,
      hostId: options.hostId,
      intentDigest,
    });
    const message = options.messages.at(-1);
    const parts = pluginMessageParts(intent.params);
    if (
      !message?.id ||
      message.role !== "user" ||
      !options.serverIds.includes(prepared.serverId) ||
      pluginBindingDigest(message.parts) !== pluginBindingDigest(parts)
    )
      throw deny();
    const runtime = createPluginRequestRuntime(
      c,
      admission,
      bearer,
      { hostId: prepared.hostId, serverId: prepared.serverId },
      undefined,
      { ownedForms: false },
    );
    try {
      const current = await runtime.resolve(
        prepared.toolName,
        c.req.raw.signal,
      );
      if (!current.messageEnabled || current.revision !== prepared.revision)
        throw deny();
      await admission.revalidate({ signal: c.req.raw.signal });
      c.req.raw.signal.throwIfAborted();
      messagePreparations.bind(
        preparationToken,
        pluginBindingDigest([actor.workspaceId, options.threadId, message.id]),
      );
      return options.messages.map((entry) =>
        entry === message ? { ...entry, parts } : entry,
      );
    } finally {
      await runtime.release();
    }
  }
  const model = modelApps.has(intent.instanceToken)
    ? modelApps.get(intent.instanceToken, actor)
    : undefined;
  const instance = model
    ? {
        ...model.owner,
        messageEnabled: true,
        activation: {
          toolName: model.toolName,
          revision: model.revision,
          selector: {
            kind: "thread" as const,
            threadId: intent.sourceThreadId,
          },
        },
      }
    : await pluginInstances.getPersistent(
        intent.instanceToken,
        actor,
        c.req.raw.signal,
      );
  const target = pluginMessageTarget(intent.params);
  const message = options.messages.at(-1);
  const parts = pluginMessageParts(intent.params);
  if (
    !instance.messageEnabled ||
    instance.hostId !== options.hostId ||
    !options.serverIds.includes(instance.owner.serverId) ||
    (instance.activation.selector.kind === "thread" &&
      instance.activation.selector.threadId !== intent.sourceThreadId) ||
    (!options.prepareOnly && target === "new") ||
    (target === "active"
      ? options.threadId !== intent.sourceThreadId
      : !options.prepareOnly && options.threadId === intent.sourceThreadId) ||
    !message?.id ||
    message.role !== "user" ||
    pluginBindingDigest(message.parts) !== pluginBindingDigest(parts)
  )
    throw deny();
  const runtime = createPluginRequestRuntime(
    c,
    admission,
    bearer,
    { hostId: instance.hostId, serverId: instance.owner.serverId },
    instance,
    { ownedForms: false },
  );
  try {
    const current = await resolveOpenPluginActivation(
      runtime,
      instance.activation,
      c.req.raw.signal,
    );
    if (current.extensions?.capabilities.messages === false)
      throw new PluginInvocationError("PLUGIN_EXTENSION_DISABLED");
    if (
      !current.messageEnabled ||
      current.revision !== instance.activation.revision
    )
      throw deny();
    await admission.revalidate({ signal: c.req.raw.signal });
    c.req.raw.signal.throwIfAborted();
    if (options.prepareOnly) {
      if (target !== "new") throw deny();
      // Recheck source after the asynchronous admission before granting transfer.
      if (model) modelApps.get(intent.instanceToken, actor);
      else
        await pluginInstances.getPersistent(
          intent.instanceToken,
          actor,
          c.req.raw.signal,
        );
      c.req.raw.signal.throwIfAborted();
      return messagePreparations.issue({
        actorId: actor.actorId,
        projectId: actor.projectId,
        subject: actor.subject,
        hostId: instance.hostId,
        serverId: instance.owner.serverId,
        toolName: instance.activation.toolName,
        // What the transfer re-resolves: that tool alone (a quick action's
        // activation revision also binds its source and planned call).
        revision:
          "toolRevision" in current && typeof current.toolRevision === "string"
            ? current.toolRevision
            : instance.activation.revision,
        intentDigest,
      });
    }
    (model ? modelApps : pluginInstances).prepareMessage(
      intent.instanceToken,
      actor,
      intent.operationId,
      pluginBindingDigest([
        options.threadId,
        message.id,
        intent.sourceThreadId,
        intent.params,
      ]),
    );
    return options.messages.map((entry) =>
      entry === message ? { ...entry, parts } : entry,
    );
  } finally {
    await runtime.release();
  }
}
