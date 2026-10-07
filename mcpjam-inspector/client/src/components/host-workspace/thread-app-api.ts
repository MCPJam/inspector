import { driveOwnedPluginMrtr } from "@/lib/apis/owned-plugin-mrtr";
import { pluginOnboardingSpecSchema } from "@/shared/plugin-onboarding";
import { z } from "zod";
import { mcpAppToolResultSchema } from "@mcpjam/sdk/widget-runtime";
import { authFetch } from "@/lib/session-token";
import type { FetchWidgetContentResponse } from "@mcpjam/widget-react";
import type { PluginWorkspaceDescriptor } from "@/shared/plugin-workspace";
import {
  pluginIconMetadataSchema,
  type PluginIconMetadata,
} from "@/shared/plugin-icons";
import {
  appendPluginDiagnostics,
  describePluginError,
} from "@/lib/plugin-diagnostics";

export type ThreadAppToolResult = z.infer<typeof mcpAppToolResultSchema>;

export interface ThreadAppScope {
  projectId: string;
  hostId: string;
  threadId: string;
  pluginWorkspace: PluginWorkspaceDescriptor;
}
export interface ThreadAppDeclaration {
  toolName: string;
  title: string;
  kind: "thread" | "global" | "quick-action" | "file";
  resourceUri?: string;
  /** The entrypoint tool's `icons` (sidebar and pane-tab icon). */
  toolIcons?: PluginIconMetadata["toolIcons"];
  /** The server's icons: the fallback when the tool declares none. Resolve
   * with `pluginIconCandidates({ toolIcons, serverIcons, theme })`, then a
   * generic icon. */
  serverIcons?: PluginIconMetadata["serverIcons"];
}
const declaredIcons = pluginIconMetadataSchema.shape.toolIcons.optional();
export interface ThreadAppHandle {
  localFilesAvailable?: boolean;
  presentation?: "app" | "result";
  deepLink?: { url: string };
  deepLinkNamespace?: { pluginId: string; runtime: "chatgpt" | "codex" };
  instanceToken: string;
  instanceId: string;
  generation: number;
  operationId: string;
  resourceUri: string;
  toolTitle: string;
  toolMetadata?: Record<string, unknown>;
  appToolsEnabled: boolean;
  contextEnabled?: boolean;
  messageEnabled?: boolean;
  contextSnapshot?: import("@/shared/plugin-model-context").PluginContextSnapshot;
  toolsMetadata?: Record<string, Record<string, unknown>>;
  widgetContent: FetchWidgetContentResponse;
  file?: { name: string; resourceUri: string };
  fileCapabilities?: { write: boolean; subscribe: boolean };
  /** The lease deadline. Renew before it; never use the handle after it. */
  expiresAt?: number;
}
export interface AppApproval {
  serverName?: string;
  id: string;
  name: string;
  params: unknown;
}
export type ApproveAppTool = (
  approval: AppApproval,
  signal: AbortSignal,
) => Promise<boolean>;

export class ThreadAppError extends Error {
  /** Plain-English description from the shared error map (or the server). */
  readonly description?: string;
  /** For ambiguous deep links: the plugins the link could mean. */
  readonly candidates?: readonly string[];
  constructor(
    readonly code: string,
    details: { description?: string; candidates?: readonly string[] } = {},
  ) {
    super(code);
    this.description = details.description ?? describePluginError(code);
    if (details.candidates?.length) this.candidates = details.candidates;
  }
}

/** Retry transport loss using the same immutable body, never a replacement operation. */
async function post(
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<{ response: Response; value: Record<string, unknown> }> {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  };
  let response: Response;
  try {
    response = await authFetch(`/api/web/apps/plugin-instances/${path}`, init);
  } catch (error) {
    signal.throwIfAborted();
    // An unknown wire outcome is recoverable only through the original receipt.
    response = await authFetch(`/api/web/apps/plugin-instances/${path}`, init);
  }
  signal.throwIfAborted();
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 2 * 1024 * 1024)
    throw new ThreadAppError("INSTANCE_RESPONSE_TOO_LARGE");
  let value: Record<string, unknown>;
  try {
    value = z.record(z.string(), z.unknown()).parse(JSON.parse(text));
  } catch {
    throw new ThreadAppError("INSTANCE_RESPONSE_INVALID");
  }
  // Server diagnostics go to the existing Logs panel and never reach an App.
  if ("diagnostics" in value) {
    appendPluginDiagnostics(value.diagnostics);
    const { diagnostics: _logged, ...rest } = value;
    value = rest;
  }
  return { response, value };
}
function accepted(response: Response, value: Record<string, unknown>) {
  if (!response.ok)
    throw new ThreadAppError(
      typeof value.code === "string" ? value.code : "INSTANCE_UNAVAILABLE",
      {
        ...(typeof value.description === "string"
          ? { description: value.description.slice(0, 1000) }
          : {}),
        ...(Array.isArray(value.candidates)
          ? {
              candidates: value.candidates
                .filter((item): item is string => typeof item === "string")
                .slice(0, 16),
            }
          : {}),
      },
    );
}
export function createThreadAppApi(scope: ThreadAppScope, routePrefix = "") {
  const owner = {
    projectId: scope.projectId,
    pluginWorkspace: scope.pluginWorkspace,
  };
  async function discoverServer(
    serverId: string,
    signal: AbortSignal,
  ): Promise<{
    entries: ThreadAppDeclaration[];
    /** The server's icons (`server/discover`, else `initialize`). */
    serverIcons?: PluginIconMetadata["serverIcons"];
    /** The installed plugin that owns this server, when one does. */
    pluginId?: string;
    mentions: { available: boolean; toolName?: string; title?: string };
    /** False when the server's response predates the `mentions` field. */
    mentionsReported: boolean;
  }> {
    const { response, value } = await post(
      "discover",
      { ...owner, hostId: scope.hostId, serverId },
      signal,
    );
    accepted(response, value);
    const entries = z
      .array(
        z.object({
          kind: z.enum(["thread", "global", "quick-action"]),
          toolName: z.string().min(1).max(256),
          title: z.string().max(4096),
          toolIcons: declaredIcons,
        }),
      )
      .max(4096)
      .safeParse(value.entries);
    const serverIcons = declaredIcons.safeParse(value.serverIcons);
    // Display only; an unusable value is dropped, never an error.
    const pluginId = z.string().min(1).max(256).safeParse(value.pluginId);
    const mentions = z
      .object({
        available: z.boolean(),
        toolName: z.string().min(1).max(256).optional(),
        title: z.string().max(4096).optional(),
      })
      .safeParse(value.mentions ?? { available: false });
    if (!entries.success || !serverIcons.success || !mentions.success)
      throw new ThreadAppError("INSTANCE_RESPONSE_INVALID");
    return {
      entries: entries.data.map(({ toolIcons, ...entry }) => ({
        ...entry,
        ...(toolIcons?.length ? { toolIcons } : {}),
        ...(serverIcons.data?.length ? { serverIcons: serverIcons.data } : {}),
      })),
      ...(serverIcons.data?.length ? { serverIcons: serverIcons.data } : {}),
      ...(pluginId.success ? { pluginId: pluginId.data } : {}),
      mentions: mentions.data,
      mentionsReported: value.mentions !== undefined,
    };
  }
  return {
    onboarding: async (
      serverId: string,
      content: boolean,
      signal: AbortSignal,
    ) => {
      const { response, value } = await post(
        "onboarding",
        {
          projectId: scope.projectId,
          pluginWorkspace: scope.pluginWorkspace,
          hostId: scope.hostId,
          serverId,
          content,
        },
        signal,
      );
      accepted(response, value);
      return z
        .strictObject({
          available: z.boolean(),
          spec: pluginOnboardingSpecSchema.optional(),
        })
        .parse(value);
    },
    context: async (
      instanceToken: string,
      action: "update" | "read" | "remove",
      request: Record<string, unknown>,
      signal: AbortSignal,
    ) => {
      const { response, value } = await post(
        `${routePrefix}${
          action === "update" ? "context" : `context/${action}`
        }`,
        { ...owner, instanceToken, ...request },
        signal,
      );
      accepted(response, value);
      return value;
    },

    discoverFile: async (
      serverId: string,
      resourceUri: string,
      signal: AbortSignal,
    ): Promise<ThreadAppDeclaration[]> => {
      const { response, value } = await post(
        "files/discover",
        { ...owner, hostId: scope.hostId, serverId, resourceUri },
        signal,
      );
      accepted(response, value);
      const entries = z
        .array(
          z.object({
            toolName: z.string().min(1).max(256),
            title: z.string().max(4096),
            toolIcons: declaredIcons,
          }),
        )
        .max(4096)
        .safeParse(value.entries);
      const serverIcons = declaredIcons.safeParse(value.serverIcons);
      if (!entries.success || !serverIcons.success)
        throw new ThreadAppError("INSTANCE_RESPONSE_INVALID");
      return entries.data.map(({ toolIcons, ...entry }) => ({
        ...entry,
        kind: "file" as const,
        resourceUri,
        ...(toolIcons?.length ? { toolIcons } : {}),
        ...(serverIcons.data?.length ? { serverIcons: serverIcons.data } : {}),
      }));
    },
    readFile: async (
      handle: ThreadAppHandle,
      params: unknown,
      signal: AbortSignal,
    ) => {
      if (!handle.file)
        throw new ThreadAppError("INSTANCE_RESOURCE_UNAVAILABLE");
      const { response, value } = await post(
        "files/read",
        { ...owner, instanceToken: handle.instanceToken, params },
        signal,
      );
      accepted(response, value);
      const result = z
        .object({
          contents: z.array(
            z.union([
              z
                .object({
                  uri: z.string(),
                  text: z.string(),
                  mimeType: z.string().optional(),
                  _meta: z.record(z.string(), z.unknown()).optional(),
                })
                .passthrough(),
              z
                .object({
                  uri: z.string(),
                  blob: z.string(),
                  mimeType: z.string().optional(),
                  _meta: z.record(z.string(), z.unknown()).optional(),
                })
                .passthrough(),
            ]),
          ),
        })
        .passthrough()
        .safeParse(value);
      if (!result.success)
        throw new ThreadAppError("INSTANCE_RESPONSE_INVALID");
      return result.data;
    },
    resolveLocalFile: async (
      handle: ThreadAppHandle,
      path: string,
      signal: AbortSignal,
    ) => {
      const { response, value } = await post(
        "files/open",
        { ...owner, instanceToken: handle.instanceToken, path },
        signal,
      );
      accepted(response, value);
      const result = z
        .object({
          file: z.object({ uri: z.string(), name: z.string() }),
          entries: z.array(
            z.object({
              toolName: z.string(),
              title: z.string(),
              toolIcons: declaredIcons,
            }),
          ),
          serverIcons: declaredIcons,
        })
        .parse(value);
      return result.entries.map(({ toolIcons, ...entry }) => ({
        ...entry,
        kind: "file" as const,
        resourceUri: result.file.uri,
        ...(toolIcons?.length ? { toolIcons } : {}),
        ...(result.serverIcons?.length
          ? { serverIcons: result.serverIcons }
          : {}),
      }));
    },
    writeFile: async (
      handle: ThreadAppHandle,
      params: unknown,
      signal: AbortSignal,
    ) => {
      if (!handle.fileCapabilities?.write)
        throw new ThreadAppError("INSTANCE_RESOURCE_UNAVAILABLE");
      const { response, value } = await post(
        "files/write",
        {
          ...owner,
          instanceToken: handle.instanceToken,
          operationId: crypto.randomUUID(),
          params,
        },
        signal,
      );
      accepted(response, value);
      return value;
    },
    watchFile: async (
      handle: ThreadAppHandle,
      onUpdate: (uri: string) => void,
      signal: AbortSignal,
      onReady?: () => void,
    ): Promise<void> => {
      if (!handle.file || !handle.fileCapabilities?.subscribe)
        throw new ThreadAppError("INSTANCE_RESOURCE_UNAVAILABLE");
      while (!signal.aborted) {
        const started = Date.now();
        const response = await authFetch(
          "/api/web/apps/plugin-instances/files/subscribe",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal,
            body: JSON.stringify({
              ...owner,
              instanceToken: handle.instanceToken,
              params: { uri: handle.file.resourceUri },
            }),
          },
        );
        if (!response.ok || !response.body)
          throw new ThreadAppError("INSTANCE_RESOURCE_UNAVAILABLE");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "";
        try {
          while (true) {
            const item = await reader.read();
            signal.throwIfAborted();
            if (item.done) break;
            pending += decoder.decode(item.value, { stream: true });
            if (pending.length > 4096)
              throw new ThreadAppError("INSTANCE_RESPONSE_TOO_LARGE");
            let newline: number;
            while ((newline = pending.indexOf("\n")) >= 0) {
              const line = pending.slice(0, newline);
              pending = pending.slice(newline + 1);
              if (line === '{"ready":true}') {
                onReady?.();
                continue;
              }
              const message = z
                .object({ uri: z.literal(handle.file.resourceUri) })
                .strict()
                .safeParse(JSON.parse(line));
              if (!message.success)
                throw new ThreadAppError("INSTANCE_RESPONSE_INVALID");
              onUpdate(message.data.uri);
            }
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        signal.throwIfAborted();
        if (pending || Date.now() - started < 1000)
          throw new ThreadAppError("INSTANCE_RESOURCE_UNAVAILABLE");
      }
    },
    discover: async (
      serverId: string,
      signal: AbortSignal,
    ): Promise<ThreadAppDeclaration[]> =>
      (await discoverServer(serverId, signal)).entries,
    /** Entrypoints plus whether the server offers @ mention search (exactly
     * one app-visible mention tool, with the client's mentions extension on). */
    discoverServer: (serverId: string, signal: AbortSignal) =>
      discoverServer(serverId, signal),
    open: async (
      serverId: string,
      toolName: string,
      signal: AbortSignal,
      kind: ThreadAppDeclaration["kind"] = "thread",
      deepLink?: string,
      resourceUri?: string,
    ): Promise<ThreadAppHandle> => {
      const { response, value } = await post(
        "activation/open",
        {
          ...scope,
          serverId,
          toolName,
          kind,
          ...(kind === "file"
            ? { resourceUri, requestId: crypto.randomUUID() }
            : kind === "quick-action"
              ? { requestId: crypto.randomUUID() }
              : {}),
          ...(deepLink ? { deepLink } : {}),
        },
        signal,
      );
      accepted(response, value);
      const handle = z
        .custom<ThreadAppHandle>((value) => {
          if (!value || typeof value !== "object") return false;
          const handle = value as Partial<ThreadAppHandle>;
          return (
            (handle.deepLink === undefined ||
              (typeof handle.deepLink.url === "string" &&
                handle.deepLink.url.length <= 8192)) &&
            (handle.deepLinkNamespace === undefined ||
              (typeof handle.deepLinkNamespace.pluginId === "string" &&
                ["chatgpt", "codex"].includes(
                  handle.deepLinkNamespace.runtime,
                ))) &&
            typeof handle.instanceToken === "string" &&
            typeof handle.instanceId === "string" &&
            Number.isSafeInteger(handle.generation) &&
            Number(handle.generation) > 0 &&
            typeof handle.operationId === "string" &&
            typeof handle.resourceUri === "string" &&
            typeof handle.toolTitle === "string" &&
            typeof handle.widgetContent?.html === "string" &&
            typeof handle.appToolsEnabled === "boolean" &&
            (handle.expiresAt === undefined ||
              Number.isSafeInteger(handle.expiresAt)) &&
            (handle.presentation === undefined ||
              handle.presentation === "app" ||
              handle.presentation === "result")
          );
        })
        .safeParse(value);
      if (!handle.success)
        throw new ThreadAppError("INSTANCE_RESPONSE_INVALID");
      return handle.data;
    },
    invoke: async (
      handle: ThreadAppHandle,
      signal: AbortSignal,
      approve: ApproveAppTool,
      call?: { name: string; arguments: Record<string, unknown> },
    ): Promise<ThreadAppToolResult> => {
      const path = routePrefix + (call ? "call" : "activation/execute");
      const body = {
        ...owner,
        instanceToken: handle.instanceToken,
        ...(call ? { invocationId: crypto.randomUUID(), params: call } : {}),
      };
      let reply = await post(path, body, signal);
      if (
        reply.response.status === 409 &&
        reply.value?.status === "approval_required"
      ) {
        const parsed = z
          .object({ id: z.string(), name: z.string(), params: z.unknown() })
          .safeParse(reply.value.approval);
        if (!parsed.success)
          throw new ThreadAppError("INSTANCE_RESPONSE_INVALID");
        const approval = parsed.data;
        const approved = await approve(approval, signal);
        signal.throwIfAborted();
        reply = await post(
          path,
          { ...body, approval: { id: approval.id, approved } },
          signal,
        );
      }
      accepted(reply.response, reply.value);
      reply.value = (await driveOwnedPluginMrtr(reply.value, {
        signal,
        formScope: {
          projectId: scope.projectId,
          workspaceId: scope.pluginWorkspace.workspaceId,
        },
        submit: async (resume) => {
          const next = await post(path, { ...body, resume }, signal);
          accepted(next.response, next.value);
          return next.value;
        },
      })) as Record<string, unknown>;
      if (reply.value?.status !== "completed")
        throw new ThreadAppError("INSTANCE_UNSUPPORTED_CONTINUATION");
      const result = mcpAppToolResultSchema.safeParse(reply.value.result);
      if (!result.success)
        throw new ThreadAppError("INSTANCE_RESPONSE_INVALID");
      return result.data;
    },
    /** Resolve a plugin deep link clicked or pasted in a chat message to the
     * enabled server whose global App it opens. Accepts the plugin's
     * installation ID, manifest name or published ID, a plain server's
     * emulated ID, and `@marketplace`. Then open that server's global App for
     * `toolName` with the same `url` as its deep link (the open admits it
     * again). Ambiguous or unknown links are refused with a described error. */
    resolveDeepLink: async (
      url: string,
      serverIds: readonly string[],
      signal: AbortSignal,
    ): Promise<{ serverId: string; toolName: string; url: string }> => {
      const { response, value } = await post(
        "deep-link/resolve",
        { ...owner, hostId: scope.hostId, serverIds, url },
        signal,
      );
      accepted(response, value);
      const parsed = z
        .object({
          serverId: z.string().min(1).max(256),
          toolName: z.string().min(1).max(256),
          url: z.string().startsWith("/").max(8192),
        })
        .safeParse(value);
      if (!parsed.success) throw new ThreadAppError("INSTANCE_RESPONSE_INVALID");
      return parsed.data;
    },
    /** Extend a retained App's lease before its 30-minute expiry. Call it for
     * every retained App regardless of visibility (hidden tabs, Apps kept
     * while another chat is selected); stop when the App closes. The same
     * instance and activation continue; nothing is reopened. */
    renew: async (
      handle: Pick<ThreadAppHandle, "instanceToken">,
      signal: AbortSignal,
    ): Promise<{ expiresAt: number }> => {
      const { response, value } = await post(
        routePrefix + "renew",
        { ...owner, instanceToken: handle.instanceToken },
        signal,
      );
      accepted(response, value);
      const parsed = z
        .object({ expiresAt: z.number().int().positive() })
        .safeParse(value);
      if (!parsed.success) throw new ThreadAppError("INSTANCE_RESPONSE_INVALID");
      return parsed.data;
    },
    close: async (handle: ThreadAppHandle, signal: AbortSignal) => {
      const { response, value } = await post(
        routePrefix + "close",
        { ...owner, instanceToken: handle.instanceToken },
        signal,
      );
      accepted(response, value);
    },
  };
}
export type ThreadAppApi = ReturnType<typeof createThreadAppApi>;
