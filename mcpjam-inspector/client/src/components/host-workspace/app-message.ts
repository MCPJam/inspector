import { authFetch } from "@/lib/session-token";
import type { ThreadAppScope } from "./thread-app-api";
import type { WidgetHost } from "@mcpjam/widget-react";
import {
  parsePluginMessage,
  type PluginMessageIntent,
} from "@/shared/plugin-message";
import type { ThreadAppHandle } from "./thread-app-api";

/** Host-supplied dispatch uses the normal composer/session gates, not a second session. */
export function withAppMessages(
  owned: WidgetHost,
  policy: WidgetHost,
  handle: ThreadAppHandle,
  port: {
    /** A function is read when the request arrives (global Apps follow the current chat). */
    threadId: string | (() => string);
    isLive: () => boolean;
    send: (
      intent: PluginMessageIntent,
      isLive: () => boolean,
    ) => Promise<boolean>;
  },
): WidgetHost {
  const allowed = (
    args: Parameters<
      WidgetHost["resolvers"]["resolveEffectiveMcpAppsCapabilities"]
    >[0],
  ) =>
    !!handle.messageEnabled &&
    !!policy.resolvers.resolveEffectiveHostCapabilities(args).message &&
    policy.resolvers.resolveEffectiveMcpAppsCapabilities(args).message;
  return {
    ...owned,
    services: {
      ...owned.services,
      ...(handle.messageEnabled
        ? {
            sendMessage: async (value: unknown) => {
              if (!port.isLive()) throw new Error("This App is closed");
              const params = parsePluginMessage(value);
              const accepted = await port.send(
                {
                  instanceToken: handle.instanceToken,
                  operationId: crypto.randomUUID(),
                  sourceThreadId:
                    typeof port.threadId === "function"
                      ? port.threadId()
                      : port.threadId,
                  params,
                },
                port.isLive,
              );
              if (!accepted)
                throw new Error("The App message could not be sent");
              return {};
            },
          }
        : {}),
    },
    resolvers: {
      ...owned.resolvers,
      resolveEffectiveHostCapabilities: (args) => ({
        ...owned.resolvers.resolveEffectiveHostCapabilities(args),
        ...(allowed(args)
          ? {
              experimental: {
                ...owned.resolvers.resolveEffectiveHostCapabilities(args)
                  .experimental,
                "openai/message": {},
              },
              message:
                policy.resolvers.resolveEffectiveHostCapabilities(args).message,
            }
          : {}),
      }),
      resolveEffectiveMcpAppsCapabilities: (args) => ({
        ...owned.resolvers.resolveEffectiveMcpAppsCapabilities(args),
        message: allowed(args),
      }),
    },
  };
}

/** Called by usePluginMessage.prepareNew, before resetting the source chat. */
export async function prepareNewAppMessage(
  scope: ThreadAppScope,
  serverId: string,
  intent: PluginMessageIntent,
  isCurrent: () => boolean,
): Promise<PluginMessageIntent | null> {
  if (!isCurrent()) return null;
  const response = await authFetch(
    "/api/web/apps/plugin-instances/message/prepare",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: scope.projectId,
        pluginWorkspace: scope.pluginWorkspace,
        hostId: scope.hostId,
        serverId,
        intent,
      }),
    },
  );
  if (!response.ok) throw new Error("The App message could not be prepared");
  const value = await response.json();
  if (!isCurrent()) return null;
  if (
    typeof value.preparationToken !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value.preparationToken)
  )
    throw new Error("Invalid App message preparation");
  return { ...intent, preparationToken: value.preparationToken };
}
