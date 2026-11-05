import type { FetchWidgetContentResponse } from "@mcpjam/widget-react";
import { PLUGIN_APP_REPLY_MAX_BYTES } from "@/shared/plugin-app-ui-limits";
import { z } from "zod";
import { mcpAppToolResultSchema } from "@mcpjam/sdk/widget-runtime";
import { authFetch } from "@/lib/session-token";
import { NativeSettingsController } from "@/shared/plugin-settings-controller";
import { PluginSettingsRequestError } from "@/shared/plugin-settings";
import type { ApproveAppTool, ThreadAppScope } from "./thread-app-api";
import { appendPluginDiagnostics } from "@/lib/plugin-diagnostics";
import { withPluginOperationAuthorization } from "@/lib/plugin-operation-authorization";
import { watchOwnedLegacyInput } from "@/lib/owned-legacy-input";
import { driveOwnedPluginMrtr } from "@/lib/apis/owned-plugin-mrtr";

export type ServerSettingsAction = {
  name: string;
  title?: string;
  kind: "tool" | "app" | "unavailable";
};
export function createServerSettingsApi(
  scope: ThreadAppScope,
  serverId: string,
  approve: ApproveAppTool,
) {
  const owner = {
    projectId: scope.projectId,
    pluginWorkspace: scope.pluginWorkspace,
  };
  async function post(path: string, body: unknown, signal: AbortSignal) {
    const init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    };
    let response: Response;
    try {
      response = await authFetch(
        `/api/web/apps/plugin-instances/settings/${path}`,
        init,
      );
    } catch {
      signal.throwIfAborted();
      try {
        response = await authFetch(
          `/api/web/apps/plugin-instances/settings/${path}`,
          init,
        );
      } catch {
        signal.throwIfAborted();
        throw new PluginSettingsRequestError("SETTINGS_UNAVAILABLE", true);
      }
    }
    const text = await response.text();
    signal.throwIfAborted();
    const limit = (path === "app/open" || path === "app/call") && response.ok
      ? PLUGIN_APP_REPLY_MAX_BYTES
      : 1024 * 1024;
    if (new TextEncoder().encode(text).byteLength > limit)
      throw new PluginSettingsRequestError("SETTINGS_RESPONSE_LIMIT", true);
    let value: Record<string, unknown>;
    try {
      value = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
    } catch {
      throw new PluginSettingsRequestError("SETTINGS_RESPONSE_INVALID", true);
    }
    // Server diagnostics (e.g. a read tool without readOnlyHint) go to Logs.
    if ("diagnostics" in value) {
      appendPluginDiagnostics(value.diagnostics, { serverId });
      const { diagnostics: _logged, ...rest } = value;
      value = rest;
    }
    return { response, value };
  }
  function accepted(reply: Awaited<ReturnType<typeof post>>) {
    if (!reply.response.ok)
      throw new PluginSettingsRequestError(
        typeof reply.value.code === "string"
          ? reply.value.code
          : "SETTINGS_UNAVAILABLE",
        reply.response.status >= 500,
      );
    return reply.value;
  }
  return {
    discover: async (signal: AbortSignal) =>
      accepted(
        await post(
          "discover",
          { ...owner, hostId: scope.hostId, serverId },
          signal,
        ),
      ).settings !== null,
    open: async (signal: AbortSignal) => {
      const opened = accepted(
        await post(
          "open",
          { ...owner, hostId: scope.hostId, serverId },
          signal,
        ),
      );
      const instanceToken = z.string().min(1).parse(opened.instanceToken);
      const instanceId =
        typeof opened.instanceId === "string" ? opened.instanceId : undefined;
      const generation =
        typeof opened.generation === "number" ? opened.generation : undefined;
      const appOperations = new Map<string, string>();
      const invoke = async (
        path: string,
        extra: Record<string, unknown>,
        active: AbortSignal,
        operationId: string = crypto.randomUUID(),
        onInputPending?: (pending: boolean) => void,
      ) => {
        const body = { ...owner, instanceToken, operationId, ...extra };
        const send = (next: Record<string, unknown>) =>
          withPluginOperationAuthorization(
            {
              kind: "call",
              invocationId: operationId,
              params: { name: path, arguments: extra },
            },
            active,
            async (operation, signal) =>
              accepted(
                await post(
                  "renew",
                  { ...owner, instanceToken, ...operation },
                  signal,
                ),
              ),
            (authorization) => {
              const stop = watchOwnedLegacyInput(
                instanceId && generation
                  ? {
                      projectId: scope.projectId,
                      workspaceId: scope.pluginWorkspace.workspaceId,
                      instanceId,
                      generation,
                      serverId,
                      invocationId: operationId,
                    }
                  : undefined,
                active,
                onInputPending,
              );
              return post(
                path,
                { ...next, ...(authorization ? { authorization } : {}) },
                active,
              ).finally(stop);
            },
          );
        let reply = await send(body);
        if (
          reply.response.status === 409 &&
          reply.value.status === "approval_required"
        ) {
          const approval = z
            .object({ id: z.string(), name: z.string(), params: z.unknown() })
            .parse(reply.value.approval);
          onInputPending?.(true);
          let approved: boolean;
          try {
            approved = await approve(approval, active);
          } finally {
            onInputPending?.(false);
          }
          active.throwIfAborted();
          reply = await send({
            ...body,
            approval: { id: approval.id, approved },
          });
        }
        const value = z.record(z.string(), z.unknown()).parse(
          await driveOwnedPluginMrtr(accepted(reply), {
            signal: active,
            onInputPending,
            formScope: {
              projectId: scope.projectId,
              workspaceId: scope.pluginWorkspace.workspaceId,
            },
            submit: async (resume) => accepted(await send({ ...body, resume })),
          }),
        );
        if (value.status !== "completed")
          throw new PluginSettingsRequestError(
            "SETTINGS_CONTINUATION_UNSUPPORTED",
            true,
          );
        return mcpAppToolResultSchema.parse(value.result);
      };
      const close = async () => {
        await post(
          "close",
          { ...owner, instanceToken },
          AbortSignal.timeout(5000),
        );
      };
      try {
        const raw = (await invoke("read", {}, signal)).structuredContent;
        const controller = new NativeSettingsController(raw, {
          read: async (active) =>
            (await invoke("read", {}, active)).structuredContent,
          update: async (args, active) =>
            (await invoke("update", args, active)).structuredContent,
        });
        const actions = z
          .array(
            z.object({
              name: z.string(),
              title: z.string().min(1).optional(),
              kind: z.enum(["tool", "app", "unavailable"]),
            }),
          )
          .parse(
            accepted(await post("actions", { ...owner, instanceToken }, signal))
              .actions,
          );
        return {
          controller,
          actions,
          openApp: async (name: string, active: AbortSignal) => {
            const openedApp = accepted(
              await post(
                "app/open",
                { ...owner, instanceToken, toolName: name },
                active,
              ),
            );
            const childToken = z.string().min(1).parse(openedApp.childToken);
            const childLifetime = new AbortController();
            const resourceUri = z
              .string()
              .startsWith("ui://")
              .parse(openedApp.resourceUri);
            const widgetContent =
              openedApp.widgetContent as FetchWidgetContentResponse;
            if (!widgetContent || typeof widgetContent.html !== "string")
              throw new PluginSettingsRequestError(
                "SETTINGS_RESPONSE_INVALID",
                false,
              );
            const closeApp = async () => {
              childLifetime.abort();
              await post(
                "app/close",
                { ...owner, instanceToken, childToken },
                AbortSignal.timeout(5000),
              );
            };
            try {
              if (!appOperations.has(name))
                appOperations.set(name, crypto.randomUUID());
              const result = await invoke(
                "action",
                { toolName: name },
                active,
                appOperations.get(name),
              );
              return {
                childToken,
                resourceUri,
                widgetContent,
                appToolsEnabled: openedApp.appToolsEnabled === true,
                toolMetadata: openedApp.toolMetadata as
                  Record<string, unknown> | undefined,
                result,
                call: (
                  toolName: string,
                  args: Record<string, unknown>,
                  requestSignal: AbortSignal,
                  onInputPending?: (pending: boolean) => void,
                ) =>
                  invoke(
                    "app/call",
                    { childToken, params: { name: toolName, arguments: args } },
                    AbortSignal.any([
                      requestSignal,
                      childLifetime.signal,
                      signal,
                    ]),
                    crypto.randomUUID(),
                    onInputPending,
                  ),
                close: closeApp,
              };
            } catch (error) {
              void closeApp().catch(() => {});
              throw error;
            }
          },
          action: (name: string, active: AbortSignal) =>
            invoke("action", { toolName: name }, active),
          close: async () => {
            controller.close();
            await close();
          },
        };
      } catch (error) {
        void close().catch(() => {});
        throw error;
      }
    },
  };
}
export type ServerSettingsSession = Awaited<
  ReturnType<ReturnType<typeof createServerSettingsApi>["open"]>
>;

export type ServerSettingsApp = Awaited<
  ReturnType<ServerSettingsSession["openApp"]>
>;
