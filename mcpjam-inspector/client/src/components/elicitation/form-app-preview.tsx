import { PluginFormFileServices } from "./form-files";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  WidgetWorkspaceProvider,
  WidgetWorkspaceSurfaceHost,
  useWidgetWorkspace,
  type MCPAppsRendererProps,
} from "@mcpjam/widget-react";
import { Button } from "@mcpjam/design-system/button";
import { authFetch } from "@/lib/session-token";
import { mcpAppToolResultSchema } from "@mcpjam/sdk/widget-runtime";
import { useWidgetHost } from "../chat-v2/thread/mcp-apps/use-widget-host";
import { createThreadAppHost } from "../host-workspace/thread-app-host";
import type {
  ThreadAppHandle,
  ThreadAppToolResult,
  AppApproval,
} from "../host-workspace/thread-app-api";
import {
  formResourcePreviewPorts,
  openPluginFormPreview,
  pluginFormServiceRefusal,
  type PluginFormServiceScope,
  type PluginFormServiceServer,
} from "./form-resource-preview";
import type { PluginFormParent } from "@/shared/plugin-form-services";
import type { PluginFormPorts } from "../schema-form/PluginFormFields";

type Services = {
  ports: PluginFormPorts;
  presentation: ReactNode;
  userResources: boolean;
  userResourceKinds: ("file" | "directory")[];
  origin?: "server" | "mcp-app";
  fileResources?: boolean;
};
type Props = {
  scope: PluginFormServiceScope;
  /** The server that asked for the form; previews open there. */
  server?: PluginFormServiceServer;
  sourceToken: string;
  parent: PluginFormParent;
  expiresAt: number;
  schema?: unknown;
  onCancel?: () => Promise<void>;
  children: (services: Services) => ReactNode;
};
interface App {
  handle: ThreadAppHandle & { serverId: string; toolName: string };
  result: ThreadAppToolResult;
  target: string;
  arguments: Record<string, unknown>;
}

export function PluginFormPreviewServices(props: Props) {
  return (
    <WidgetWorkspaceProvider
      key={props.sourceToken}
      workspaceId={`form:${props.sourceToken}`}
    >
      <Controller {...props} />
    </WidgetWorkspaceProvider>
  );
}
function Controller(props: Props) {
  const host = useWidgetHost();
  const workspace = useWidgetWorkspace();
  const [apps, setApps] = useState<App[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [approval, setApproval] = useState<{
    value: AppApproval;
    finish: (allowed: boolean) => void;
  }>();
  const retained = useRef(new Map<string, App>());
  const opening = useRef(
    new Map<string, { operation: Promise<App>; signal: AbortSignal }>(),
  );
  const accepted = useRef(new Map<string, { id: string; approved: true }>());
  const queue = useRef(Promise.resolve());
  const lifecycle = useMemo(
    () => ({
      abort: new AbortController(),
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
    }),
    [props.sourceToken],
  );
  useEffect(() => {
    clearTimeout(lifecycle.timer);
    const expiry = setTimeout(
      () => lifecycle.abort.abort(),
      Math.max(0, props.expiresAt - Date.now()),
    );
    return () => {
      clearTimeout(expiry);
      lifecycle.timer = setTimeout(() => lifecycle.abort.abort(), 0);
    };
  }, [lifecycle, props.expiresAt]);
  const owner = {
    projectId: props.scope.projectId,
    pluginWorkspace: { version: 1, workspaceId: props.scope.workspaceId },
  };
  async function post(action: string, body: unknown, signal: AbortSignal) {
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    };
    let reply: Response;
    try {
      reply = await authFetch(
        `/api/web/apps/plugin-instances/form-preview/app/${action}`,
        init,
      );
    } catch {
      signal.throwIfAborted();
      reply = await authFetch(
        `/api/web/apps/plugin-instances/form-preview/app/${action}`,
        init,
      );
    }
    const text = await reply.text();
    if (new TextEncoder().encode(text).length > 2 * 1024 * 1024)
      throw new Error("App preview response is too large");
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      if (reply.ok) throw error;
    }
    // A refusal keeps its own description for the field and Logs. An
    // approval request (409) is answered below.
    if (!reply.ok && reply.status !== 409)
      throw pluginFormServiceRefusal(data, "PLUGIN_FORM_PREVIEW_FAILED");
    return { reply, data };
  }
  function approve(value: AppApproval, signal: AbortSignal): Promise<boolean> {
    const next = queue.current.then(
      () =>
        new Promise<boolean>((resolve) => {
          if (signal.aborted) return resolve(false);
          const finish = (allowed: boolean) => {
            signal.removeEventListener("abort", cancel);
            setApproval(undefined);
            resolve(allowed);
          };
          const cancel = () => finish(false);
          signal.addEventListener("abort", cancel, { once: true });
          setApproval({ value, finish });
        }),
    );
    queue.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  async function execute(
    handle: App["handle"],
    signal: AbortSignal,
    call?: { name: string; arguments: Record<string, unknown> },
    /** Stops an opening preview's clock while the person decides. */
    pause: <R>(wait: () => Promise<R>) => Promise<R> = (wait) => wait(),
  ) {
    const invocationId = call ? crypto.randomUUID() : handle.operationId;
    const body = {
      ...owner,
      instanceToken: handle.instanceToken,
      ...(call ? { invocationId, params: call } : {}),
      ...(accepted.current.has(invocationId)
        ? { approval: accepted.current.get(invocationId) }
        : {}),
    };
    const action = call ? "call-tool" : "execute";
    let response = await post(action, body, signal);
    if (
      response.reply.status === 409 &&
      response.data.status === "approval_required"
    ) {
      const value = response.data.approval as AppApproval;
      if (
        !value ||
        typeof value.id !== "string" ||
        typeof value.name !== "string"
      )
        throw new Error("Invalid approval");
      const allowed = await pause(() => approve(value, signal));
      if (!allowed) throw new Error("App preview was declined");
      const proof = { id: value.id, approved: true as const };
      accepted.current.set(invocationId, proof);
      response = await post(action, { ...body, approval: proof }, signal);
    }
    signal.throwIfAborted();
    if (!response.reply.ok || response.data.status !== "completed")
      throw pluginFormServiceRefusal(
        response.data,
        "PLUGIN_FORM_PREVIEW_FAILED",
      );
    return mcpAppToolResultSchema.parse(response.data.result);
  }
  const resourcePorts = formResourcePreviewPorts(
    props.scope,
    props.sourceToken,
    props.parent,
    props.expiresAt,
    props.server,
  );
  const ports: PluginFormPorts = {
    ...resourcePorts,
    preview: (target, signal) => {
      if (target.type !== "mcp_app_tool")
        return resourcePorts.preview!(target, signal);
      // Opens on the server that asked for the form, within the same
      // bounded wait as a resource preview.
      return openPluginFormPreview(
        target,
        signal,
        props.server,
        async (bounded, pause) => {
          const pending = AbortSignal.any([bounded, lifecycle.abort.signal]);
          const key = JSON.stringify(target);
          let app = retained.current.get(key);
          if (!app) {
            // An open whose wait already ended (timed out, closed) is never
            // joined: a retry starts its own.
            const joined = opening.current.get(key);
            let operation = joined?.signal.aborted
              ? undefined
              : joined?.operation;
            if (!operation) {
              operation = (async () => {
                const { reply, data } = await post(
                  "open",
                  {
                    ...owner,
                    sourceToken: props.sourceToken,
                    parent: props.parent,
                    target,
                  },
                  pending,
                );
                if (
                  !reply.ok ||
                  typeof data.instanceToken !== "string" ||
                  typeof data.instanceId !== "string" ||
                  typeof data.widgetContent?.html !== "string" ||
                  typeof data.serverId !== "string"
                )
                  throw new Error("App preview unavailable");
                const handle = data as App["handle"];
                const result = await execute(handle, pending, undefined, pause);
                pending.throwIfAborted();
                const opened = {
                  handle,
                  result,
                  target: key,
                  arguments: target.arguments ?? {},
                };
                retained.current.set(key, opened);
                setApps([...retained.current.values()]);
                return opened;
              })();
              const entry = { operation, signal: pending };
              opening.current.set(key, entry);
              void operation
                .finally(() => {
                  if (opening.current.get(key) === entry)
                    opening.current.delete(key);
                })
                .catch(() => undefined);
            }
            app = await operation;
          }
          pending.throwIfAborted();
          const id = app.handle.instanceId;
          setActive(id);
          const hide = () =>
            setActive((current) => (current === id ? null : current));
          return {
            content: <span role="status">App preview opened below.</span>,
            release: hide,
          };
        },
      );
    },
  };
  useEffect(() => {
    for (const app of apps) {
      const handle = app.handle;
      const params: MCPAppsRendererProps = {
        chatSessionId: workspace.workspaceId,
        serverId: handle.serverId,
        serverName: handle.toolTitle,
        toolCallId: handle.operationId,
        toolName: handle.toolName,
        resourceUri: handle.resourceUri,
        toolMetadata: handle.toolMetadata,
        toolState: "output-available",
        toolInput: app.arguments,
        toolOutput: app.result,
        toolResponseMetadata: app.result._meta,
        displayMode: "inline",
        onCallTool: (name, args) =>
          execute(handle, lifecycle.abort.signal, { name, arguments: args }),
      };
      workspace.surfaces
        .getState()
        .upsertRegistration(
          handle.instanceId,
          handle.operationId,
          params,
          createThreadAppHost(host, handle, handle.serverId),
          "panel",
        );
    }
  }, [apps, host, workspace, lifecycle]);
  return (
    <PluginFormFileServices
      scope={props.scope}
      sourceToken={props.sourceToken}
      parent={props.parent}
      expiresAt={props.expiresAt}
      schema={props.schema}
      {...(props.server ? { server: props.server } : {})}
      onCancel={props.onCancel}
    >
      {(files) =>
        props.children({
          userResources: files.userResources,
          userResourceKinds: files.userResourceKinds,
          ...(files.origin ? { origin: files.origin } : {}),
          ...(files.fileResources !== undefined
            ? { fileResources: files.fileResources }
            : {}),
          ports: { ...ports, ...files.ports },
          presentation: (
            <>
              {approval && (
                <section
                  className="space-y-2 rounded-md border border-border p-3"
                  aria-label="App tool approval"
                >
                  <p>Allow {approval.value.name}?</p>
                  <pre className="max-h-36 overflow-auto text-xs whitespace-pre-wrap">
                    {JSON.stringify(approval.value.params, null, 2)}
                  </pre>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      onClick={() => approval.finish(false)}
                    >
                      Deny
                    </Button>
                    <Button onClick={() => approval.finish(true)}>Allow</Button>
                  </div>
                </section>
              )}
              <div
                className={
                  active
                    ? "h-96 min-h-0 overflow-hidden border border-border"
                    : "hidden"
                }
              >
                <WidgetWorkspaceSurfaceHost activeSurfaceId={active} />
              </div>
            </>
          ),
        })
      }
    </PluginFormFileServices>
  );
}
