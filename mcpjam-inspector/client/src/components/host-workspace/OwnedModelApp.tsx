import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  WidgetHostProvider,
  MCPAppsRenderer,
  type MCPAppsRendererProps,
} from "@mcpjam/widget-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@mcpjam/design-system/dialog";
import {
  pluginModelAppSchema,
  PLUGIN_MODEL_APP_META,
  withoutModelAppControl,
} from "@/shared/plugin-model-app";
import { authFetch } from "@/lib/session-token";
import { useWidgetHost } from "../chat-v2/thread/mcp-apps/use-widget-host";
import type { PluginMessageIntent } from "@/shared/plugin-message";
import type { ContextAttachment } from "../chat-v2/chat-input/attachments/context-attachment-chip";
import { withAppMessages, prepareNewAppMessage } from "./app-message";
import { useAppContext, withAppContext } from "./use-app-context";
import {
  serverDisplayName,
  usePluginIconDirectory,
  useServerIconSources,
} from "./plugin-icon-directory";
import { createThreadAppHost } from "./thread-app-host";
import {
  createThreadAppApi,
  ThreadAppError,
  type ThreadAppHandle,
  type AppApproval,
} from "./thread-app-api";

/** Model Apps hold a 30-minute lease on the server; renew well inside it. */
const MODEL_APP_RENEW_INTERVAL_MS = 10 * 60_000;

export interface ModelAppWorkspaceScope {
  key: string;
  projectId: string;
  hostId: string;
  workspaceId: string;
}
type ModelMessageSource = {
  serverId: string;
  threadId: string;
  isLive: () => boolean;
};
export interface OwnedModelAppPorts {
  registerMessageSource: (
    token: string,
    source: ModelMessageSource,
    owner: Pick<ModelAppWorkspaceScope, "projectId" | "hostId" | "workspaceId">,
  ) => () => void;
  publishContext: (
    token: string,
    attachments: ContextAttachment[] | null,
    owner: Pick<ModelAppWorkspaceScope, "projectId" | "hostId" | "workspaceId">,
  ) => void;
  sendMessage: (
    intent: PluginMessageIntent,
    isLive: () => boolean,
  ) => Promise<boolean>;
}
const ModelAppPortsContext = createContext<OwnedModelAppPorts | null>(null);
/** Root composer owns publication and dispatch; render leaves own no chat session. */
export const OwnedModelAppPortsProvider = ModelAppPortsContext.Provider;

export function useOwnedModelAppWorkspace(
  sendMessage: OwnedModelAppPorts["sendMessage"],
  scope: ModelAppWorkspaceScope | null,
) {
  // Rotate synchronously: old asynchronous publications cannot enter a new chat,
  // even before the previous leaf's passive cleanup has run.
  const identity = scope
    ? JSON.stringify([
        scope.key,
        scope.projectId,
        scope.hostId,
        scope.workspaceId,
      ])
    : null;
  const current = useRef({
    identity,
    epoch: 0,
    sources: new Map<string, ModelMessageSource>(),
  });
  if (current.current.identity !== identity)
    current.current = {
      identity,
      epoch: current.current.epoch + 1,
      sources: new Map(),
    };
  const epoch = current.current.epoch;
  const [state, setState] = useState<{
    epoch: number;
    contexts: Record<string, ContextAttachment[]>;
  }>({ epoch, contexts: {} });
  const publishContext = useCallback<OwnedModelAppPorts["publishContext"]>(
    (token, attachments, owner) => {
      if (
        !scope ||
        current.current.epoch !== epoch ||
        owner.projectId !== scope.projectId ||
        owner.hostId !== scope.hostId ||
        owner.workspaceId !== scope.workspaceId
      )
        return;
      setState((previous) => {
        if (current.current.epoch !== epoch) return previous;
        const contexts = previous.epoch === epoch ? previous.contexts : {};
        if (attachments === null) {
          if (!(token in contexts)) return previous;
          const next = { ...contexts };
          delete next[token];
          return { epoch, contexts: next };
        }
        if (contexts[token] === attachments) return previous;
        return { epoch, contexts: { ...contexts, [token]: attachments } };
      });
    },
    [identity, epoch],
  );
  const dispatch = useCallback<OwnedModelAppPorts["sendMessage"]>(
    (intent, isLive) => {
      const live = () => !!scope && current.current.epoch === epoch && isLive();
      return live() ? sendMessage(intent, live) : Promise.resolve(false);
    },
    [sendMessage, identity, epoch],
  );
  const registerMessageSource = useCallback<
    OwnedModelAppPorts["registerMessageSource"]
  >(
    (token, source, owner) => {
      if (
        !scope ||
        current.current.epoch !== epoch ||
        owner.projectId !== scope.projectId ||
        owner.hostId !== scope.hostId ||
        owner.workspaceId !== scope.workspaceId ||
        !source.isLive()
      )
        return () => {};
      const sources = current.current.sources;
      sources.set(token, source);
      return () => {
        if (sources.get(token) === source) sources.delete(token);
      };
    },
    [identity, epoch],
  );
  const prepareMessage = useCallback(
    async (
      intent: PluginMessageIntent,
      isCurrent: () => boolean,
    ): Promise<PluginMessageIntent | null> => {
      const source = current.current.sources.get(intent.instanceToken);
      const live = () =>
        !!scope &&
        current.current.epoch === epoch &&
        current.current.sources.get(intent.instanceToken) === source &&
        !!source?.isLive() &&
        isCurrent();
      if (
        !scope ||
        !source ||
        source.threadId !== intent.sourceThreadId ||
        !live()
      )
        return null;
      return prepareNewAppMessage(
        {
          projectId: scope.projectId,
          hostId: scope.hostId,
          threadId: source.threadId,
          pluginWorkspace: { version: 1, workspaceId: scope.workspaceId },
        },
        source.serverId,
        intent,
        live,
      );
    },
    [identity, epoch],
  );
  const value = useMemo(
    () => ({ publishContext, sendMessage: dispatch, registerMessageSource }),
    [publishContext, dispatch, registerMessageSource],
  );
  const contexts = scope && state.epoch === epoch ? state.contexts : {};
  return {
    value,
    prepareMessage,
    attachments: Object.values(contexts).flat(),
    references: Object.keys(contexts),
  };
}

/** The marker is only a handle. Its server endpoint rechecks every saved binding. */
export function OwnedModelApp({
  marker,
  renderProps,
}: {
  marker: unknown;
  renderProps: MCPAppsRendererProps;
}) {
  const parsed = pluginModelAppSchema.safeParse(marker);
  if (!parsed.success) return <div role="alert">This App is unavailable.</div>;
  return (
    <ModelApp
      key={parsed.data.instanceToken}
      marker={parsed.data}
      renderProps={renderProps}
    />
  );
}
function ModelApp({
  marker,
  renderProps,
}: {
  marker: ReturnType<typeof pluginModelAppSchema.parse>;
  renderProps: MCPAppsRendererProps;
}) {
  const base = useWidgetHost();
  const currentPorts = useContext(ModelAppPortsContext);
  // A retained leaf keeps its original workspace admission. Changing chat or
  // account cannot rebind its publications or messages through a new provider.
  const ports = useRef(currentPorts).current;
  const [handle, setHandle] = useState<ThreadAppHandle | null>(null);
  const [error, setError] = useState(false);
  const [approval, setApproval] = useState<{
    value: AppApproval;
    finish: (answer: boolean) => void;
  } | null>(null);
  const mounted = useRef(false);
  const lifetime = useMemo(() => new AbortController(), []);
  const scope = useMemo(
    () => ({
      projectId: marker.projectId,
      hostId: marker.hostId,
      threadId: renderProps.chatSessionId ?? marker.workspaceId,
      pluginWorkspace: { version: 1 as const, workspaceId: marker.workspaceId },
    }),
    [
      marker.projectId,
      marker.hostId,
      marker.workspaceId,
      renderProps.chatSessionId,
    ],
  );
  const api = useMemo(() => createThreadAppApi(scope, "model/"), [scope]);
  useEffect(() => {
    mounted.current = true;
    void authFetch("/api/web/apps/plugin-instances/model/open", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: scope.projectId,
        pluginWorkspace: scope.pluginWorkspace,
        instanceToken: marker.instanceToken,
      }),
      signal: lifetime.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("App unavailable");
        const value = await response.json();
        if (
          !value ||
          value.instanceToken !== marker.instanceToken ||
          typeof value.widgetContent?.html !== "string" ||
          typeof value.resourceUri !== "string"
        )
          throw new Error("App unavailable");
        if (mounted.current) setHandle(value);
      })
      .catch(() => {
        if (mounted.current && !lifetime.signal.aborted) setError(true);
      });
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (!mounted.current) {
          lifetime.abort();
          void api
            .close(
              { instanceToken: marker.instanceToken } as ThreadAppHandle,
              new AbortController().signal,
            )
            .catch(() => {});
        }
      });
    };
  }, [api, lifetime, marker.instanceToken, scope]);
  const iconSources = useServerIconSources(marker.serverId);
  // Its fullscreen header, side-panel tab and context chip name the saved
  // server, never its raw id.
  const directory = usePluginIconDirectory();
  const byId = serverDisplayName(marker.serverId, directory);
  const serverName =
    byId !== "App"
      ? byId
      : serverDisplayName(renderProps.serverName, directory);
  const context = useAppContext(
    scope,
    handle ?? ({ instanceToken: marker.instanceToken } as ThreadAppHandle),
    "model/",
    // Chip presentation: the plugin (server) the App belongs to.
    {
      serverName,
      ...(iconSources.pluginIcons ? { icons: iconSources.pluginIcons } : {}),
      ...(iconSources.serverIcons
        ? { serverIcons: iconSources.serverIcons }
        : {}),
    },
  );
  // A turn carries this App only while it has context: an App with nothing
  // attached (or one that is gone) never makes a send depend on it.
  const hasContext =
    !!handle?.contextEnabled && !error && context.snapshot.state != null;
  useEffect(() => {
    ports?.publishContext(
      marker.instanceToken,
      hasContext ? context.attachments : null,
      marker,
    );
    return () => ports?.publishContext(marker.instanceToken, null, marker);
  }, [ports, marker.instanceToken, context.attachments, hasContext]);
  // Keep the lease while the App is on screen, as retained Apps do: an
  // expired model App refuses its calls, context and messages.
  useEffect(() => {
    if (!handle) return;
    const timer = setInterval(() => {
      if (lifetime.signal.aborted) return;
      void api.renew(handle, lifetime.signal).catch((reason: unknown) => {
        if (
          reason instanceof ThreadAppError &&
          (reason.code === "MODEL_APP_UNAVAILABLE" ||
            reason.code === "INSTANCE_UNAVAILABLE") &&
          mounted.current
        )
          setError(true);
      });
    }, MODEL_APP_RENEW_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [api, handle, lifetime]);
  useEffect(() => {
    if (!handle?.messageEnabled || !ports) return;
    return ports.registerMessageSource(
      marker.instanceToken,
      {
        serverId: marker.serverId,
        threadId: scope.threadId,
        isLive: () => mounted.current && !lifetime.signal.aborted,
      },
      marker,
    );
  }, [
    handle?.messageEnabled,
    ports,
    marker.instanceToken,
    marker.serverId,
    marker.projectId,
    marker.hostId,
    marker.workspaceId,
    scope.threadId,
    lifetime,
  ]);
  const ownedHost = useMemo(() => {
    if (!handle) return null;
    const withContext = withAppContext(
      createThreadAppHost(base, handle, marker.serverId, "model"),
      base,
      handle,
      context,
    );
    return ports
      ? withAppMessages(withContext, base, handle, {
          threadId: scope.threadId,
          isLive: () => mounted.current && !lifetime.signal.aborted,
          send: ports.sendMessage,
        })
      : withContext;
  }, [
    base,
    handle,
    marker.serverId,
    context.update,
    ports,
    scope.threadId,
    lifetime,
  ]);
  // Context notifications change environment data, never owned bridge services.
  const host = useMemo(
    () =>
      ownedHost
        ? {
            ...ownedHost,
            environment: {
              ...ownedHost.environment,
              draftHostContext: {
                ...ownedHost.environment.draftHostContext,
                "openai/modelContext": context.snapshot.state,
              },
            },
          }
        : null,
    [ownedHost, context.snapshot],
  );
  const queue = useRef(Promise.resolve());
  if (error)
    return (
      <div role="alert">
        This App is unavailable. Its server or permissions may have changed.
      </div>
    );
  if (!handle || !host) return <div role="status">Opening App…</div>;
  const { [PLUGIN_MODEL_APP_META]: _control, ...guestMetadata } =
    renderProps.toolResponseMetadata ?? {};
  return (
    <>
      <WidgetHostProvider value={host}>
        <MCPAppsRenderer
          {...renderProps}
          toolOutput={withoutModelAppControl(renderProps.toolOutput)}
          toolResponseMetadata={guestMetadata}
          serverId={marker.serverId}
          serverName={serverName}
          resourceUri={handle.resourceUri}
          toolMetadata={handle.toolMetadata}
          onCallTool={(name, args) =>
            api.invoke(
              handle,
              lifetime.signal,
              (value, signal) => {
                const answer = queue.current.then(
                  () =>
                    new Promise<boolean>((resolve) => {
                      if (signal.aborted) return resolve(false);
                      const finish = (approved: boolean) => {
                        signal.removeEventListener("abort", abort);
                        setApproval(null);
                        resolve(approved);
                      };
                      const abort = () => finish(false);
                      signal.addEventListener("abort", abort, { once: true });
                      setApproval({ value, finish });
                    }),
                );
                queue.current = answer.then(
                  () => undefined,
                  () => undefined,
                );
                return answer;
              },
              { name, arguments: args },
            )
          }
        />
      </WidgetHostProvider>
      <Dialog
        open={approval !== null}
        onOpenChange={(open) => {
          if (!open) approval?.finish(false);
        }}
      >
        <DialogContent>
          <DialogTitle>Allow {approval?.value.name}?</DialogTitle>
          <DialogDescription>
            This App wants to use a server tool.
          </DialogDescription>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs">
            {JSON.stringify(approval?.value.params, null, 2)}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => approval?.finish(false)}>
              Deny
            </Button>
            <Button onClick={() => approval?.finish(true)}>Allow</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
