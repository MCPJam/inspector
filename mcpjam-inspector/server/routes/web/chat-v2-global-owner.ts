import type { ModelMessage, UserModelMessage } from "ai";
import { parsePluginWorkspaceDescriptor } from "@/shared/plugin-workspace";
import type { PluginWorkspaceAdmission } from "../../services/plugin-host/admission.js";
import { PluginInvocationError } from "../../services/plugin-host/invocation.js";

/**
 * The Playground keeps global Apps in their own workspace (one per user,
 * project and client) so they survive chat switches. Their model context and
 * messages bind to whichever chat sends the turn, so a turn may name the
 * global workspace beside its own.
 *
 * Admission is per actor and project; the workspace is a presentation
 * namespace. The global owner therefore reuses the chat's admission and only
 * changes the namespace its instances are looked up in.
 */
export function globalOwnerAdmission(
  chat: PluginWorkspaceAdmission | undefined,
  descriptor: unknown,
): PluginWorkspaceAdmission | undefined {
  if (!chat || descriptor === undefined) return undefined;
  const global = parsePluginWorkspaceDescriptor(descriptor);
  if (!global || global.workspaceId === chat.workspaceId) return undefined;
  return Object.freeze({
    actorId: chat.actorId,
    projectId: chat.projectId,
    workspaceId: global.workspaceId,
    revalidate: (options?: Parameters<PluginWorkspaceAdmission["revalidate"]>[0]) =>
      chat.revalidate(options),
  });
}

/** Both owners' context, as one ephemeral user message. */
export function mergePluginContextMessages(
  ...messages: (ModelMessage | undefined)[]
): ModelMessage | undefined {
  const present = messages.filter(
    (message): message is UserModelMessage =>
      !!message && message.role === "user" && Array.isArray(message.content),
  );
  if (present.length <= 1) return present[0];
  const merged: UserModelMessage = {
    role: "user",
    content: present.flatMap((message) =>
      Array.isArray(message.content) ? message.content : [],
    ),
  };
  return merged;
}

/**
 * An App message names its instance, not its owner. Try the chat's own
 * workspace first, then the global owner's. Every check runs before the
 * preparation records anything, so a refused first attempt has no effect.
 */
export async function withGlobalOwnerFallback<T>(
  run: (admission: PluginWorkspaceAdmission | undefined) => Promise<T>,
  chat: PluginWorkspaceAdmission | undefined,
  global: PluginWorkspaceAdmission | undefined,
): Promise<T> {
  try {
    return await run(chat);
  } catch (error) {
    if (!global || !(error instanceof PluginInvocationError)) throw error;
    return run(global);
  }
}
