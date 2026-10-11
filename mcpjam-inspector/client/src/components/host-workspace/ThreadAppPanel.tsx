import "./host-workspace.css";
import { createFileViewerServices } from "./file-viewer-services";
import { withFileViewerHost } from "./file-viewer-host";
import { withLocalFileHost, type ChooseFileViewer } from "./local-file-host";
import { withThreadAppNavigation } from "./thread-app-navigation";
import { parsePluginDeepLink } from "@/shared/plugin-deep-link";
import {
  usePluginOnboarding,
  type RunPluginOnboarding,
} from "./use-plugin-onboarding";
import { useWorkspaceSettings } from "./use-workspace-settings";
import { useAppContext, withAppContext } from "./use-app-context";
import { withAppMessages, prepareNewAppMessage } from "./app-message";
import type { PluginMessageIntent } from "@/shared/plugin-message";
import type { ContextAttachment } from "../chat-v2/chat-input/attachments/context-attachment-chip";
type AppMessageSender = (
  intent: PluginMessageIntent,
  isLive: () => boolean,
) => Promise<boolean>;
type PublishContext = (
  token: string,
  attachments: ContextAttachment[] | null,
  /** The App's context is locally detached: keep it out of turns. */
  options?: { detached?: boolean },
) => void;
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ArrowLeft, ChevronDown, PanelsTopLeft, X } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@mcpjam/design-system/dialog";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
} from "@mcpjam/design-system/dropdown-menu";
import {
  WidgetWorkspaceProvider,
  WidgetWorkspaceSurfaceHost,
  useWidgetWorkspace,
  useWidgetSurfaceAdmissionError,
  closeWorkspaceSurface,
} from "@mcpjam/widget-react";
import type { WidgetHost, MCPAppsRendererProps } from "@mcpjam/widget-react";
import { useWidgetHost } from "@/components/chat-v2/thread/mcp-apps/use-widget-host";
import {
  createThreadAppApi,
  ThreadAppError,
  type ThreadAppApi,
  type ThreadAppToolResult,
  type ThreadAppScope,
  type ThreadAppHandle,
  type ThreadAppDeclaration,
  type AppApproval,
  type ApproveAppTool,
} from "./thread-app-api";
import { ResultsPanel } from "@/components/tools/ResultsPanel";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { createThreadAppHost } from "./thread-app-host";
import {
  capabilityRefusal,
  guardRetainedAppRequests,
  negotiateRetainedAppHost,
  withCurrentHostContext,
} from "./retained-app-host";
import {
  useExtensionDiscovery,
  type ExtensionDiscovery,
} from "./use-extension-discovery";
import {
  ALL_EXTENSION_CAPABILITIES,
  type ExtensionCapabilities,
} from "./extension-owners";
import {
  filterOpenAiHostCapabilities,
  maskPluginAppHandle,
} from "@/lib/client-config-v2-plugin-extensions";
import { describeExtensionError, logExtensionEvent } from "./extension-log";
import { withPluginDeadline } from "@/shared/plugin-operation";
import type { PluginIcons } from "@/lib/plugins/plugin-api-types";
import { useServerIconSources } from "./plugin-icon-directory";
import {
  ExtensionLaunchHealth,
  type ExtensionLaunchObservation,
  type ExtensionLaunchProfile,
} from "@/lib/extension-launch-health";

export interface WorkspaceServer {
  serverId: string;
  name: string;
  /** Opaque connection epoch; a new value after the first means a reconnect. */
  connection?: string;
  /** `serverInfo.icons` from `initialize` (or `server/discover`), untrusted. */
  icons?: readonly unknown[];
  /** The imported plugin's manifest icons, when the server belongs to one. */
  pluginIcons?: PluginIcons;
}
export interface AppRow {
  /** Launch-health observation for this activation (H9). */
  launch?: ExtensionLaunchObservation;
  /** The first execution completed. */
  executed?: boolean;
  /** The App's first render outcome. */
  rendered?: "ready" | "error";
  navigationSequence?: number;
  admission?: Promise<void>;
  key: string;
  server: WorkspaceServer;
  declaration: ThreadAppDeclaration;
  handle?: ThreadAppHandle;
  result?: ThreadAppToolResult;
  status: "loading" | "live" | "error";
  error?: string;
  retryable?: boolean;
  closing?: boolean;
  abort: AbortController;
  /** The handle's lease deadline. A handle is never reused after it. */
  expiresAt?: number;
  leaseTimer?: ReturnType<typeof setTimeout>;
  /** Its lease ended while it wasn't shown: selecting it reopens it. */
  reopen?: boolean;
  /** Its lease ended, but it stays shown as it is: a result-only quick
   * action's result, or a writable file viewer's unsaved edits. */
  leaseEnded?: boolean;
}
/** Instance controls expire 30 minutes after their last renewal. */
export const APP_LEASE_MS = 30 * 60_000;
export const APP_LEASE_RENEW_INTERVAL_MS = 10 * 60_000;
/**
 * How long opening an App (its activation, before anything is drawn) may
 * take. Past it the row says why, with Retry, instead of "Opening App…"
 * forever; the request is cancelled.
 */
export const APP_OPEN_TIMEOUT_MS = 30_000;
export const APP_OPEN_TIMEOUT_CODE = "INSTANCE_OPEN_TIMEOUT";
const appOpenTimedOut = () =>
  new ThreadAppError(APP_OPEN_TIMEOUT_CODE, {
    description:
      "MCPJam waited 30 seconds for it to open and stopped. Retry; if it keeps happening, check that the server is connected and answers its entrypoint promptly.",
  });
/** Server answers meaning what an open App is bound to changed under it. */
const APP_BINDING_CHANGED: ReadonlySet<string> = new Set([
  "INSTANCE_HOST_CHANGED",
  "INSTANCE_SERVER_CHANGED",
  "INSTANCE_CONNECTION_CHANGED",
]);

/**
 * Whether an App whose lease ended can be reopened without asking: opening
 * it again only shows the same thing. A quick action would run its action
 * again, so it shows its error with a one-click reopen instead. A writable
 * file viewer is never reopened (see `appKeepsUnsavedState`).
 */
export function appReopensTransparently(
  row: Pick<AppRow, "declaration" | "handle">,
): boolean {
  const kind = row.declaration.kind;
  return (
    kind === "thread" ||
    kind === "global" ||
    (kind === "file" && row.handle?.fileCapabilities?.write !== true)
  );
}

/**
 * A writable file viewer holds unsaved edits in the App itself. Its lease and
 * file grant renew for as long as it is open; if they still end (the server
 * lost the session), it stays mounted with its edits and is never replaced
 * by a fresh activation until the user closes it.
 */
export function appKeepsUnsavedState(
  row: Pick<AppRow, "declaration" | "handle">,
): boolean {
  return (
    row.declaration.kind === "file" &&
    row.handle?.fileCapabilities?.write === true
  );
}

/** One retained row per server, kind, tool and (for files) resource. */
export function threadAppRowKey(
  serverId: string,
  declaration: Pick<ThreadAppDeclaration, "kind" | "toolName" | "resourceUri">,
): string {
  return JSON.stringify([
    serverId,
    declaration.kind,
    declaration.toolName,
    ...(declaration.resourceUri ? [declaration.resourceUri] : []),
  ]);
}
interface ApprovalWait {
  value: AppApproval;
  finish: (approved: boolean) => void;
}
interface ViewerChoiceWait {
  entries: ThreadAppDeclaration[];
  finish: (entry: ThreadAppDeclaration | null) => void;
}

export interface ThreadAppWorkspaceOptions {
  runOnboarding?: RunPluginOnboarding;
  sendMessage?: AppMessageSender;
  /** Shared discovery; when absent the workspace reads its own. */
  discovery?: ExtensionDiscovery;
  /**
   * The chat an App message targets, read when the request arrives. A global
   * App has no chat of its own, so it follows whichever chat is current.
   */
  currentThreadId?: () => string;
  capabilities?: ExtensionCapabilities;
  /** Settings discovery is owned once per scope; chat owners skip it. */
  settings?: boolean;
  /** Called when an App is launched or reselected, for presentation. */
  onLaunch?: (key: string, declaration: ThreadAppDeclaration) => void;
  /**
   * Launchers listed by this workspace may belong to another owner (a thread
   * entrypoint listed beside a global one). Return a promise to take it over.
   */
  routeLaunch?: (
    server: WorkspaceServer,
    declaration: ThreadAppDeclaration,
  ) => Promise<void> | undefined;
  /**
   * A deep link opens its plugin's GLOBAL App. Chat-owned Apps (thread, file
   * viewer, quick action) hand it to the global owner.
   */
  routeNavigate?: (server: WorkspaceServer, url: string) => Promise<void>;
  /** The client profile launches are counted under (H9). */
  launchProfile?: ExtensionLaunchProfile;
  /**
   * The client's saved settings (their content address). A new value asks
   * the server whether each open App is still bound to them: a save that
   * only changed per-request settings (extension toggles, approval) keeps
   * every App as it is; one that changed what an App is bound to reopens it.
   */
  hostRevision?: string;
}

/** The caller owns identity and transport. The renderer owns only presentation. */
export function useThreadAppWorkspace(
  scope: ThreadAppScope | null,
  servers: WorkspaceServer[],
  options: ThreadAppWorkspaceOptions = {},
) {
  const capabilities = options.capabilities ?? ALL_EXTENSION_CAPABILITIES;
  const settings = useWorkspaceSettings(
    options.settings === false || !capabilities.settings ? null : scope,
    servers,
  );
  const onboardingOn = !!options.runOnboarding && capabilities.onboarding;
  const onboarding = usePluginOnboarding(
    onboardingOn ? scope : null,
    onboardingOn ? servers.map((server) => server.serverId) : [],
    options.runOnboarding ??
      (async () => {
        throw new Error("Onboarding is unavailable");
      }),
  );
  const serverKey = JSON.stringify(
    servers.map(({ serverId, name }) => [serverId, name]),
  );
  const api = useMemo(
    () => (scope ? createThreadAppApi(scope) : null),
    [scope],
  );
  const lifetime = useMemo(
    () => ({
      rows: new Map<string, AppRow>(),
      waits: new Map<string, Promise<void>>(),
      controller: new AbortController(),
      timer: null as ReturnType<typeof setTimeout> | null,
      // H9: one outcome per logical launch for this owner's lifetime.
      health: new ExtensionLaunchHealth(),
      /** Rows whose failed renewal was already logged. */
      warned: new WeakSet<AppRow>(),
    }),
    [api],
  );
  const { rows, waits, controller } = lifetime;
  const capabilitiesRef = useRef(capabilities);
  capabilitiesRef.current = capabilities;
  const profileRef = useRef<ExtensionLaunchProfile>(
    options.launchProfile ?? "chatgpt",
  );
  profileRef.current = options.launchProfile ?? "chatgpt";
  /** The App's first render finished; with its execution, the launch counts. */
  const renderOutcome = (rowKey: string, outcome: "ready" | "error") => {
    const row = rows.get(rowKey);
    if (!row || row.rendered) return;
    row.rendered = outcome;
    if (outcome === "error") row.launch?.fail("rendering");
    else if (row.executed) row.launch?.ready();
  };
  const ownDiscovery = useExtensionDiscovery(
    options.discovery ? null : api,
    servers,
  );
  const discovery = options.discovery ?? ownDiscovery;
  const entries = discovery.entries;
  const discoveryErrors = discovery.errors;
  const [contextRows, setContextRows] = useState<
    Record<string, ContextAttachment[]>
  >({});
  const [detachedContext, setDetachedContext] = useState<
    Record<string, true>
  >({});
  const publishContext = useCallback<PublishContext>((token, attachments, options) => {
    const detached = attachments !== null && !!options?.detached;
    setDetachedContext((old) => {
      if (!!old[token] === detached) return old;
      const next = { ...old };
      if (detached) next[token] = true;
      else delete next[token];
      return next;
    });
    setContextRows((old) => {
      if (attachments === null) {
        if (!(token in old)) return old;
        const next = { ...old };
        delete next[token];
        return next;
      }
      return old[token] === attachments
        ? old
        : { ...old, [token]: attachments };
    });
  }, []);
  const [apps, setApps] = useState<AppRow[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [approval, setApproval] = useState<ApprovalWait | null>(null);
  const [viewerChoice, setViewerChoice] = useState<ViewerChoiceWait | null>(
    null,
  );
  // `openai/files/open` matching several viewers asks, like a file link does.
  const chooseViewer: ChooseFileViewer = (entries, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve(null);
      const finish = (entry: ThreadAppDeclaration | null) => {
        signal.removeEventListener("abort", abort);
        setViewerChoice((old) => (old?.finish === finish ? null : old));
        resolve(entry);
      };
      const abort = () => finish(null);
      signal.addEventListener("abort", abort, { once: true });
      setViewerChoice({ entries, finish });
    });
  const approvalQueue = useRef(Promise.resolve());
  const currentLifetime = useRef(lifetime);
  currentLifetime.current = lifetime;
  const refresh = () => {
    if (currentLifetime.current === lifetime)
      setApps(Array.from(rows.values()));
  };
  const approve: ApproveAppTool = (value, signal) => {
    const answer = approvalQueue.current.then(
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
    approvalQueue.current = answer.then(
      () => undefined,
      () => undefined,
    );
    return answer;
  };
  const current = useRef({ api, approve });
  current.current = { api, approve };
  const retryDiscovery = (serverId: string) => discovery.retry(serverId);
  const activeRef = useRef(active);
  activeRef.current = active;
  // The latest launch, for lease timers armed by an earlier render.
  const launchRef = useRef<typeof launch>(null!);
  /** Track a handle's lease and act the moment it ends, shown or not. */
  const armLease = (row: AppRow, expiresAt: number) => {
    row.expiresAt = expiresAt;
    if (row.leaseTimer) clearTimeout(row.leaseTimer);
    row.leaseTimer = setTimeout(
      () => {
        row.leaseTimer = undefined;
        if (rows.get(row.key) !== row || !leaseEnded(row)) return;
        expire(row);
        if (row.reopen && activeRef.current === row.key) reopen(row);
      },
      Math.max(0, expiresAt - Date.now()),
    );
  };
  const leaseEnded = (row: AppRow) =>
    !!row.handle &&
    (row.leaseEnded === true ||
      (row.expiresAt !== undefined && Date.now() >= row.expiresAt));
  /** Drop a row's handle so nothing reuses it; the next launch opens a
   * fresh activation (and, for a file viewer, a fresh file grant). */
  function retire(row: AppRow) {
    const handle = row.handle;
    if (row.leaseTimer) clearTimeout(row.leaseTimer);
    row.abort.abort();
    row.abort = new AbortController();
    for (const field of [
      "handle",
      "result",
      "expiresAt",
      "leaseTimer",
      "leaseEnded",
      "reopen",
      "launch",
      "executed",
      "rendered",
      "navigationSequence",
      "error",
    ] as const)
      delete row[field];
    // Usually already gone; closing a session that ended is harmless.
    if (handle && api)
      void api.close(handle, AbortSignal.timeout(15_000)).catch(() => {});
  }
  /** H10: an App whose lease ended never keeps its expired handle. */
  function expire(row: AppRow) {
    const handle = row.handle;
    if (!handle || row.closing || controller.signal.aborted) return;
    // Nothing live to reopen: a result-only quick action keeps showing its
    // result, and a denied approval stays final until the App is closed.
    if (handle.presentation === "result" || row.retryable === false) {
      if (row.leaseTimer) clearTimeout(row.leaseTimer);
      row.leaseTimer = undefined;
      row.leaseEnded = true;
      return;
    }
    // A writable file viewer stays mounted: its unsaved edits live in the
    // App. Its session is gone, so reads and saves are refused (each says
    // why); the Logs say it once here. Nothing reopens it over the edits.
    if (appKeepsUnsavedState(row)) {
      if (row.leaseEnded) return;
      if (row.leaseTimer) clearTimeout(row.leaseTimer);
      row.leaseTimer = undefined;
      row.leaseEnded = true;
      logExtensionEvent({
        serverId: row.server.serverId,
        serverName: row.server.name,
        label: "lease",
        level: "warning",
        message: `${row.declaration.title}: this file viewer's session ended, so it can't read or save the file any more. Its unsaved changes are still in the viewer: copy them, close the viewer, then open the file again.`,
      });
      refresh();
      return;
    }
    const transparent = appReopensTransparently(row);
    retire(row);
    if (transparent) {
      row.status = "loading";
      row.reopen = true;
    } else {
      row.status = "error";
      row.retryable = true;
      row.error =
        "This App's session ended. Retry to open it again (a quick action runs again).";
      logExtensionEvent({
        serverId: row.server.serverId,
        serverName: row.server.name,
        label: "lease",
        level: "warning",
        message: `${row.declaration.title}: ${row.error}`,
      });
    }
    refresh();
  }
  /** Reopen an expired App the user can see, as a fresh activation. */
  function reopen(row: AppRow) {
    void launchRef.current(row.server, row.declaration).catch(() => {});
  }
  /** Selecting an App first makes sure its lease is still live. */
  function selectApp(key: string | null) {
    settings.hide();
    setActive(key);
    const row = key === null ? undefined : rows.get(key);
    if (!row || row.closing) return;
    if (leaseEnded(row)) expire(row);
    if (row.reopen) reopen(row);
  }
  // H10: keep every retained, authorized App's lease alive (visible or not:
  // hidden tabs, Apps kept while another chat is shown, quick-action and
  // file-viewer Apps) so a long session keeps the same activation. Stops when
  // the App closes or its owner goes. A writable file viewer's file grant
  // renews with its lease, so its unsaved edits survive a long session.
  useEffect(() => {
    if (!api) return;
    const timer = setInterval(() => {
      if (controller.signal.aborted) return;
      for (const row of rows.values()) renew(row);
    }, APP_LEASE_RENEW_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [api, lifetime]);
  /**
   * Renew one App's lease. The server re-checks its binding on every renewal,
   * so this is also how a retained App learns its client or server settings
   * changed under it.
   */
  function renew(row: AppRow) {
    const handle = row.handle;
    if (!api || !handle || row.closing || row.leaseEnded) return;
    const signal = AbortSignal.any([controller.signal, row.abort.signal]);
    if (signal.aborted) return;
    const current = () =>
      !signal.aborted && rows.get(row.key) === row && row.handle === handle;
    api.renew(handle, signal).then(
      ({ expiresAt }) => {
        lifetime.warned.delete(row);
        if (current()) armLease(row, expiresAt);
      },
      (error) => {
        if (!current()) return;
        // The session already ended: drop its handle now.
        if (
          error instanceof ThreadAppError &&
          error.code === "INSTANCE_UNAVAILABLE"
        ) {
          expire(row);
          if (row.reopen && activeRef.current === row.key) reopen(row);
          return;
        }
        if (
          error instanceof ThreadAppError &&
          APP_BINDING_CHANGED.has(error.code)
        ) {
          bindingChanged(row, error);
          return;
        }
        if (lifetime.warned.has(row)) return;
        lifetime.warned.add(row);
        logExtensionEvent({
          serverId: row.server.serverId,
          serverName: row.server.name,
          label: "renew",
          level: "warning",
          message: `${row.declaration.title}: couldn't extend this App's lease. If it stays unrenewed it closes 30 minutes after it was last renewed.`,
        });
      },
    );
  }
  /**
   * What an App is bound to (its client's host identity, or its server's
   * saved setup) changed after it opened. It never keeps running on the old
   * binding: it reopens under the new one, or shows why with Retry. A
   * writable file viewer keeps its unsaved edits on screen instead.
   */
  function bindingChanged(row: AppRow, error: ThreadAppError) {
    const handle = row.handle;
    if (!handle || row.closing || controller.signal.aborted) return;
    // Still opening: its own call fails the same way and shows Retry.
    if (waits.has(row.key)) return;
    const title = row.declaration.title;
    const reason = error.description ?? describeExtensionError(error);
    const log = (level: "info" | "warning", message: string) =>
      logExtensionEvent({
        serverId: row.server.serverId,
        serverName: row.server.name,
        label: "settings",
        level,
        message: `${title}: ${reason} ${message}`,
      });
    // Nothing live to reopen: a result-only quick action keeps its result,
    // and a denied approval stays final until the App is closed.
    if (handle.presentation === "result" || row.retryable === false) {
      if (row.leaseTimer) clearTimeout(row.leaseTimer);
      row.leaseTimer = undefined;
      row.leaseEnded = true;
      return;
    }
    if (appKeepsUnsavedState(row)) {
      if (row.leaseEnded) return;
      if (row.leaseTimer) clearTimeout(row.leaseTimer);
      row.leaseTimer = undefined;
      row.leaseEnded = true;
      log(
        "warning",
        "This file viewer can't read or save the file any more. Its unsaved changes are still in the viewer: copy them, close the viewer, then open the file again.",
      );
      refresh();
      return;
    }
    const transparent = appReopensTransparently(row);
    retire(row);
    if (transparent) {
      row.status = "loading";
      row.reopen = true;
      log("info", "It reopens with the current settings.");
    } else {
      row.status = "error";
      row.retryable = true;
      row.error = `${reason} Retry to open it again (a quick action runs again).`;
      log("warning", "Retry to open it again (a quick action runs again).");
    }
    refresh();
    if (row.reopen && activeRef.current === row.key) reopen(row);
  }
  // A client save: ask the server whether each open App is still bound to
  // the client's settings. Toggles alone keep every App untouched.
  const hostRevision = options.hostRevision;
  const seenHostRevision = useRef(hostRevision);
  useEffect(() => {
    const previous = seenHostRevision.current;
    seenHostRevision.current = hostRevision;
    if (previous === undefined || previous === hostRevision) return;
    if (controller.signal.aborted) return;
    for (const row of rows.values()) renew(row);
  }, [hostRevision, lifetime]);
  // Fresh discovery (list_changed, reconnect, retry) refreshes the retained
  // conversation Apps of that server so their tool metadata stays current.
  // File and quick-action activations are per request and are never reopened.
  const seenRevisions = useRef<Record<string, number>>({});
  useEffect(() => {
    const previous = seenRevisions.current;
    seenRevisions.current = discovery.revisions;
    for (const [serverId, revision] of Object.entries(discovery.revisions))
      if ((previous[serverId] ?? 0) < revision) void refreshServerApps(serverId);
  }, [discovery.revisions]);
  async function refreshServerApps(serverId: string) {
    if (!api || controller.signal.aborted) return;
    for (const row of rows.values()) {
      if (
        row.server.serverId !== serverId ||
        row.status !== "live" ||
        !row.handle ||
        (row.declaration.kind !== "thread" && row.declaration.kind !== "global")
      )
        continue;
      const handle = row.handle;
      const signal = AbortSignal.any([controller.signal, row.abort.signal]);
      try {
        const fresh = await api.open(
          row.server.serverId,
          row.declaration.toolName,
          signal,
          row.declaration.kind,
        );
        signal.throwIfAborted();
        if (rows.get(row.key) !== row || row.handle !== handle) continue;
        if (
          fresh.instanceId !== handle.instanceId ||
          fresh.generation !== handle.generation
        )
          throw new ThreadAppError("INSTANCE_BINDING_CHANGED");
        row.handle = {
          ...handle,
          toolMetadata: fresh.toolMetadata,
          toolsMetadata: fresh.toolsMetadata,
        };
        refresh();
      } catch (error) {
        if (signal.aborted || rows.get(row.key) !== row) continue;
        logExtensionEvent({
          serverId: row.server.serverId,
          serverName: row.server.name,
          label: "refresh",
          level: "warning",
          message: `${row.declaration.title}: ${describeExtensionError(error)}`,
        });
      }
    }
  }
  useEffect(() => {
    if (lifetime.timer) clearTimeout(lifetime.timer);
    setApps([]);
    setActive(null);
    return () => {
      // StrictMode's immediate effect reattachment is not an owner close.
      lifetime.timer = setTimeout(() => {
        // Closing the owner is deliberate: pending launches are not counted.
        lifetime.health.dispose("cancelled");
        controller.abort();
        for (const row of rows.values())
          if (row.leaseTimer) clearTimeout(row.leaseTimer);
        for (const row of rows.values())
          if (row.handle)
            void api
              ?.close(row.handle, AbortSignal.timeout(15_000))
              .catch(() => {});
        rows.clear();
      }, 0);
    };
  }, [api, lifetime]);
  async function launch(
    server: WorkspaceServer,
    declaration: ThreadAppDeclaration,
    deepLink?: string,
    waitForAdmission = false,
  ) {
    settings.hide();
    if (
      !api ||
      controller.signal.aborted ||
      currentLifetime.current !== lifetime
    ) {
      if (waitForAdmission) throw new Error("App owner closed");
      // Never a silent no-op: say why the click did nothing.
      logExtensionEvent({
        serverId: server.serverId,
        serverName: server.name,
        label: "launch",
        level: "warning",
        message: `${declaration.title}: this App's owner was closing (the chat, client, project or sign-in changed), so it wasn't opened. Open it again.`,
      });
      return;
    }
    const key = threadAppRowKey(server.serverId, declaration);
    if (
      declaration.kind === "file" &&
      !capabilitiesRef.current.fileViewers &&
      !rows.has(key)
    ) {
      logExtensionEvent({
        serverId: server.serverId,
        serverName: server.name,
        label: "file-viewer",
        level: "warning",
        message:
          "File viewers are turned off for this client, so the file wasn't opened.",
      });
      if (waitForAdmission) throw new Error("File viewers are turned off");
      return;
    }
    setActive(key);
    options.onLaunch?.(key, declaration);
    const retained = rows.get(key);
    // H10: a handle whose lease ended is never reused. Launching it again
    // opens a fresh activation (and, for a file viewer, a fresh file grant),
    // except over a writable file viewer's unsaved edits: that one is shown
    // as it is until the user closes it.
    if (
      retained &&
      !retained.closing &&
      retained.retryable !== false &&
      !waits.has(key) &&
      leaseEnded(retained)
    ) {
      if (appKeepsUnsavedState(retained)) {
        expire(retained);
        if (waitForAdmission)
          throw new Error(
            "This file viewer's session ended. Close it to open the file again.",
          );
        return;
      }
      retire(retained);
      retained.status = "loading";
    }
    if (deepLink && retained?.status === "live" && retained.handle) {
      const signal = AbortSignal.any([
        controller.signal,
        retained.abort.signal,
      ]);
      const navigationSequence = (retained.navigationSequence ?? 0) + 1;
      retained.navigationSequence = navigationSequence;
      const refreshed = await api.open(
        server.serverId,
        declaration.toolName,
        signal,
        "global",
        deepLink,
      );
      signal.throwIfAborted();
      if (
        retained.navigationSequence !== navigationSequence ||
        rows.get(key) !== retained ||
        refreshed.instanceId !== retained.handle.instanceId ||
        refreshed.generation !== retained.handle.generation
      )
        throw new ThreadAppError("INSTANCE_BINDING_CHANGED");
      retained.handle = { ...retained.handle, deepLink: refreshed.deepLink };
      refresh();
      return;
    }
    if (
      rows.get(key)?.status === "live" ||
      waits.has(key) ||
      rows.get(key)?.closing ||
      rows.get(key)?.retryable === false
    ) {
      if (waitForAdmission) {
        const existing = rows.get(key);
        if (existing?.closing || existing?.retryable === false)
          throw new Error("File viewer unavailable");
        await existing?.admission;
      }
      return;
    }
    const row: AppRow = rows.get(key) ?? {
      key,
      server,
      declaration,
      status: "loading",
      abort: new AbortController(),
    };
    const signal = AbortSignal.any([controller.signal, row.abort.signal]);
    row.status = "loading";
    row.error = undefined;
    row.reopen = undefined;
    rows.set(key, row);
    refresh();
    let accept!: () => void;
    let refuse!: (error: unknown) => void;
    const admission = new Promise<void>((resolve, reject) => {
      accept = resolve;
      refuse = reject;
    });
    // Ordinary launches observe errors through their row; admission-only callers
    // also receive the refusal. No rejected admission promise is left unobserved.
    void admission.catch(() => {});
    row.admission = admission;
    const task = (async () => {
      try {
        row.handle ??= await withPluginDeadline(
          signal,
          APP_OPEN_TIMEOUT_MS,
          appOpenTimedOut,
          (bounded) =>
            api.open(
              server.serverId,
              declaration.toolName,
              bounded,
              declaration.kind,
              deepLink,
              declaration.resourceUri,
            ),
        );
        if (row.closing || signal.aborted || rows.get(key) !== row) {
          refuse(new Error("App owner closed"));
          await api.close(row.handle, AbortSignal.timeout(15_000));
          return;
        }
        if (row.expiresAt === undefined)
          armLease(row, row.handle.expiresAt ?? Date.now() + APP_LEASE_MS);
        // Retries and reopen reuse the activation, so they share its outcome.
        row.launch ??= lifetime.health.begin(
          row.handle.operationId,
          declaration.kind,
          profileRef.current,
        );
        // Navigation acknowledges an admitted destination, not slow App loading.
        // The tracked task still owns approval, execution, errors and cancellation.
        accept();
        // Draw the App now; its result is delivered when the call completes.
        refresh();
        const result = await api.invoke(row.handle, signal, (value, signal) =>
          approve({ ...value, serverName: server.name }, signal),
        );
        signal.throwIfAborted();
        if (rows.get(key) !== row) return;
        row.result = result;
        row.status = "live";
        row.executed = true;
        // A result-only quick action has nothing to render; an App counts
        // once its first render is ready (or times out).
        if (row.handle.presentation === "result" || row.rendered === "ready")
          row.launch.ready();
        else if (row.rendered === "error") row.launch.fail("rendering");
        else row.launch.awaitingReadiness();
      } catch (error) {
        refuse(error);
        if (signal.aborted) row.launch?.exclude();
        else if (
          error instanceof ThreadAppError &&
          error.code === "APPROVAL_DENIED"
        )
          (row.launch ?? lifetime.health.begin(
            `open:${key}`,
            declaration.kind,
            profileRef.current,
          )).exclude();
        else
          (row.launch ?? lifetime.health.begin(
            `open:${key}`,
            declaration.kind,
            profileRef.current,
          )).fail(
            (error instanceof DOMException && error.name === "TimeoutError") ||
              (error instanceof ThreadAppError &&
                error.code === APP_OPEN_TIMEOUT_CODE)
              ? "timeout"
              : "execution",
          );
        if (!signal.aborted && rows.get(key) === row) {
          row.status = "error";
          row.retryable = !(
            error instanceof ThreadAppError && error.code === "APPROVAL_DENIED"
          );
          // The host's plain description, when it gave one.
          const description =
            error instanceof ThreadAppError ? error.description : undefined;
          row.error = row.retryable
            ? description
              ? `Couldn’t open this App. ${description}`
              : "Couldn’t open this App. Try again."
            : "Tool approval was denied. Close this App to finish.";
          if (row.retryable)
            logExtensionEvent({
              serverId: server.serverId,
              serverName: server.name,
              label: "launch",
              level: "error",
              message: `${declaration.title}: ${describeExtensionError(error)}`,
            });
        }
      } finally {
        waits.delete(key);
        if (!controller.signal.aborted) refresh();
      }
    })();
    waits.set(key, task);
    await (waitForAdmission ? admission : task);
  }
  launchRef.current = launch;
  async function navigateDeepLink(server: WorkspaceServer, url: string) {
    if (!capabilitiesRef.current.deepLinks)
      throw new ThreadAppError("INSTANCE_DEEP_LINK_UNAVAILABLE");
    const link = parsePluginDeepLink(url);
    const declaration = entries[server.serverId]?.find(
      (entry) => entry.kind === "global" && entry.toolName === link.toolName,
    );
    if (!declaration)
      throw new ThreadAppError("INSTANCE_DEEP_LINK_UNAVAILABLE");
    await launch(server, declaration, url);
    const row = rows.get(threadAppRowKey(server.serverId, declaration));
    if (row?.status !== "live" || row.handle?.deepLink?.url !== link.url)
      throw new ThreadAppError("INSTANCE_DEEP_LINK_UNAVAILABLE");
  }
  async function close(row: AppRow) {
    row.closing = true;
    row.abort.abort();
    if (row.leaseTimer) clearTimeout(row.leaseTimer);
    row.leaseTimer = undefined;
    if (!api || !row.handle) {
      rows.delete(row.key);
      refresh();
      if (currentLifetime.current === lifetime) setActive(null);
      return;
    }
    try {
      // Drop current presentation synchronously; failed durable close remains retryable.
      if (currentLifetime.current === lifetime) setActive(null);
      await api.close(row.handle, AbortSignal.timeout(15_000));
      rows.delete(row.key);
      refresh();
    } catch (error) {
      // The session had already ended (expired or closed): nothing to close.
      if (
        error instanceof ThreadAppError &&
        error.code === "INSTANCE_UNAVAILABLE"
      ) {
        rows.delete(row.key);
        refresh();
        return;
      }
      row.status = "error";
      row.error = "Couldn’t close this App. Try again.";
      refresh();
      if (currentLifetime.current === lifetime) setActive(row.key);
    }
  }
  // Removing a server ends its owner; hiding an App does not.
  useEffect(() => {
    const enabled = new Set(servers.map((server) => server.serverId));
    for (const row of rows.values())
      if (!enabled.has(row.server.serverId)) void close(row);
  }, [serverKey]);
  const currentApps = apps.filter((row) => rows.get(row.key) === row);
  const menus: Record<string, (onAction: () => void) => ReactNode> = {};
  for (const server of servers) {
    const declared = entries[server.serverId];
    const hasOnboarding = onboarding.menu(server.serverId) !== null;
    const hasSettings = settings.availableServerIds.includes(server.serverId);
    const settingsFailed = settings.failedServerIds.includes(server.serverId);
    if (
      !declared?.length &&
      !discoveryErrors[server.serverId] &&
      !hasSettings &&
      !hasOnboarding &&
      !settingsFailed
    )
      continue;
    menus[server.name] = (onAction) => (
      <DropdownMenu key={server.serverId}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="min-w-0 max-w-full shrink justify-start px-1"
            aria-label={`${server.name} extensions`}
          >
            <span className="truncate">{server.name}</span>
            <ChevronDown className="size-3 shrink-0" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel>{server.name}</DropdownMenuLabel>
          {declared?.map((entry) => (
            <DropdownMenuItem
              key={`${entry.kind}:${entry.toolName}`}
              onSelect={() => {
                onAction();
                void (options.routeLaunch?.(server, entry) ??
                  launch(server, entry));
              }}
            >
              <span>{entry.title}</span>
              <span className="ms-auto text-xs text-muted-foreground">
                {entry.kind === "quick-action"
                  ? "Action"
                  : entry.kind === "global"
                    ? "Full view"
                    : "Side panel"}
              </span>
            </DropdownMenuItem>
          ))}
          {onboarding.menu(server.serverId, onAction)}
          {hasSettings && (
            <DropdownMenuItem
              onSelect={() => {
                onAction();
                setActive(null);
                settings.open(server.serverId);
              }}
            >
              Settings
            </DropdownMenuItem>
          )}
          {settingsFailed && (
            <DropdownMenuItem onSelect={settings.retryDiscovery}>
              Retry settings discovery
            </DropdownMenuItem>
          )}
          {discoveryErrors[server.serverId] && (
            <DropdownMenuItem
              onSelect={() => {
                void retryDiscovery(server.serverId);
              }}
            >
              Retry extension discovery
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  const contextTokens = capabilities.modelContext
    ? currentApps.flatMap((row) =>
        row.status === "live" &&
        row.handle?.contextEnabled &&
        !detachedContext[row.handle.instanceToken]
          ? [row.handle.instanceToken]
          : [],
      )
    : [];
  const approvalDialog = (
    <>
    <Dialog
      open={viewerChoice !== null}
      onOpenChange={(open) => {
        if (!open) viewerChoice?.finish(null);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Open with…</DialogTitle>
          <DialogDescription>
            More than one App can open this file.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          {viewerChoice?.entries.map((entry) => (
            <Button
              key={entry.toolName}
              variant="ghost"
              className="justify-start"
              onClick={() => viewerChoice.finish(entry)}
            >
              {entry.title}
            </Button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => viewerChoice?.finish(null)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog
      open={approval !== null}
      onOpenChange={(open) => {
        if (!open) approval?.finish(false);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Allow {approval?.value.name}?</DialogTitle>
          <DialogDescription>
            {approval?.value.serverName ?? "Connected server"}
          </DialogDescription>
        </DialogHeader>
        <pre className="max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-words">
          {JSON.stringify(approval?.value.params ?? {}, null, 2)}
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
  const appPorts: RetainedAppPorts | null =
    api && scope
      ? {
          scope,
          api,
          publishContext,
          sendMessage: capabilities.messages ? options.sendMessage : undefined,
          currentThreadId: options.currentThreadId,
          capabilities,
          navigate: options.routeNavigate ?? navigateDeepLink,
          openFile: (server, entry) => launch(server, entry, undefined, true),
          chooseViewer,
          renderOutcome,
          approve: (...args) => current.current.approve(...args),
          signal: controller.signal,
          revalidate: (rowKey) => {
            const row = rows.get(rowKey);
            if (row) renew(row);
          },
        }
      : null;
  return {
    scope,
    api,
    servers,
    entries,
    discoveryErrors,
    apps: currentApps,
    active,
    select: selectApp,
    settings,
    onboarding,
    appPorts,
    approvalDialog,
    approvalPending: approval !== null,
    fileActions:
      api && scope
        ? {
            api,
            serverIds: servers.map((server) => server.serverId),
            enabled: capabilities.fileViewers,
            open: async (serverId: string, entry: ThreadAppDeclaration) => {
              const server = servers.find(
                (value) => value.serverId === serverId,
              );
              if (!server || entry.kind !== "file")
                throw new Error("File viewer unavailable");
              await launch(server, entry);
            },
          }
        : null,
    onboardingError: onboarding.error,
    onboardingPending: onboarding.pending,
    approveMention: (
      challenge: { name: string; params: Record<string, unknown> },
      signal: AbortSignal,
    ) =>
      current.current.approve({ ...challenge, id: "mention-search" }, signal),
    contextReferences: contextTokens,
    contextAttachments: contextTokens.flatMap(
      (token) => contextRows[token] ?? [],
    ),
    prepareMessage: async (
      intent: PluginMessageIntent,
      isCurrent: () => boolean,
    ) => {
      const row = currentApps.find(
        (row) =>
          row.handle?.instanceToken === intent.instanceToken &&
          row.status === "live",
      );
      if (!scope || !row || row.abort.signal.aborted || !isCurrent())
        return null;
      return prepareNewAppMessage(
        scope,
        row.server.serverId,
        intent,
        () => isCurrent() && !row.abort.signal.aborted,
      );
    },
    launch,
    navigateDeepLink,
    close,
    retryDiscovery,
    menus,
    navigation:
      (currentApps.length > 0 || settings.sessions.length > 0) &&
      active === null &&
      !settings.activeServerId ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() =>
            currentApps.length
              ? selectApp(currentApps[0].key)
              : settings.open(settings.sessions[0].serverId)
          }
        >
          <PanelsTopLeft className="size-4" />
          Apps ({currentApps.length + settings.sessions.length})
        </Button>
      ) : null,
    open: active !== null || settings.activeServerId !== null,
    panel:
      appPorts && scope ? (
        <>
          <WidgetWorkspaceProvider
            key={scope.pluginWorkspace.workspaceId}
            workspaceId={scope.pluginWorkspace.workspaceId}
          >
            <RetainedAppPanel
              ports={appPorts}
              apps={currentApps}
              active={active}
              settings={settings}
              select={selectApp}
              hide={() => {
                settings.hide();
                setActive(null);
              }}
              close={close}
              retry={launch}
            />
          </WidgetWorkspaceProvider>
          {approvalDialog}
        </>
      ) : undefined,
  };
}
export type ThreadAppWorkspace = ReturnType<typeof useThreadAppWorkspace>;

/** Everything a retained App's registration needs from its owner. */
export interface RetainedAppPorts {
  scope: ThreadAppScope;
  api: ThreadAppApi;
  publishContext: PublishContext;
  sendMessage?: AppMessageSender;
  currentThreadId?: () => string;
  capabilities: ExtensionCapabilities;
  navigate: (server: WorkspaceServer, url: string) => Promise<void>;
  openFile: (
    server: WorkspaceServer,
    entry: ThreadAppDeclaration,
  ) => Promise<void>;
  chooseViewer?: ChooseFileViewer;
  renderOutcome?: (rowKey: string, outcome: "ready" | "error") => void;
  approve: ApproveAppTool;
  signal: AbortSignal;
  /** An App request said its binding changed: re-check that App now. */
  revalidate?: (rowKey: string) => void;
}

export function AppRegistration({
  scope,
  publishContext,
  sendMessage,
  row,
  host,
  api,
  approve,
  signal,
  displayMode,
  onDisplayModeChange,
  onAppSupportedDisplayModesChange,
  navigate,
  openFile,
  currentThreadId,
  capabilities = ALL_EXTENSION_CAPABILITIES,
  chooseViewer,
  containerDimensions,
  renderOutcome,
  revalidate,
}: {
  /** An App request said its binding changed: re-check that App now. */
  revalidate?: (rowKey: string) => void;
  renderOutcome?: (rowKey: string, outcome: "ready" | "error") => void;
  chooseViewer?: ChooseFileViewer;
  /** Fixed size of the host container (SEP-1865 `containerDimensions`). */
  containerDimensions?: { width: number; height: number };
  openFile: (
    server: WorkspaceServer,
    entry: ThreadAppDeclaration,
  ) => Promise<void>;
  scope: ThreadAppScope;
  publishContext: PublishContext;
  sendMessage?: AppMessageSender;
  /** Read per request; defaults to the owner's own chat. */
  currentThreadId?: () => string;
  capabilities?: ExtensionCapabilities;
  row: AppRow;
  navigate: (server: WorkspaceServer, url: string) => Promise<void>;
  host: WidgetHost;
  api: ThreadAppApi;
  approve: ApproveAppTool;
  signal: AbortSignal;
  displayMode: "inline" | "fullscreen";
  onDisplayModeChange: (mode: "inline" | "fullscreen" | "pip") => void;
  onAppSupportedDisplayModesChange: (
    modes: ("inline" | "fullscreen" | "pip")[] | undefined,
  ) => void;
}) {
  const workspace = useWidgetWorkspace();
  const rowHandle = row.handle!;
  // The extensions on when the App opened are the ones it negotiated: its
  // handle grants (context, messages, local files, deep links) and the
  // capabilities it was told about keep them for its lifetime. A toggle
  // switched later is refused per request, here and on the server; it never
  // rebuilds the bridge under the running guest.
  const [negotiatedCapabilities] = useState(capabilities);
  const capabilitiesRef = useRef(capabilities);
  capabilitiesRef.current = capabilities;
  // Turning model context off removes the App's chips, tells the App its
  // context is cleared, and refuses further updates. The App keeps running.
  const contextAllowed = capabilities.modelContext;
  const handle = useMemo(
    () =>
      maskPluginAppHandle(rowHandle, { capabilities: negotiatedCapabilities }),
    [rowHandle, negotiatedCapabilities],
  );
  const refuse = useMemo(
    () =>
      capabilityRefusal({
        title: row.declaration.title,
        serverId: row.server.serverId,
        serverName: row.server.name,
        capabilities: () => capabilitiesRef.current,
      }),
    [row.declaration.title, row.server.serverId, row.server.name],
  );
  const localFileApi = useMemo<ThreadAppApi>(
    () => ({
      ...api,
      resolveLocalFile: (...args) => {
        refuse("localFiles");
        return api.resolveLocalFile(...args);
      },
    }),
    [api, refuse],
  );
  // Chip presentation: the plugin (server) the App belongs to.
  const iconSources = useServerIconSources(row.server.serverId);
  const pluginIcons = iconSources.pluginIcons ?? row.server.pluginIcons;
  const serverIcons = iconSources.serverIcons ?? row.server.icons;
  const context = useAppContext(scope, rowHandle, "", {
    serverName: row.server.name,
    ...(pluginIcons ? { icons: pluginIcons } : {}),
    ...(serverIcons ? { serverIcons } : {}),
    toolName: row.declaration.toolName,
  });
  const messagesAllowed = !!handle.messageEnabled && !!sendMessage;
  useEffect(() => {
    publishContext(
      handle.instanceToken,
      contextAllowed ? context.attachments : null,
      { detached: context.detached },
    );
  }, [
    publishContext,
    handle.instanceToken,
    context.attachments,
    context.detached,
    contextAllowed,
  ]);
  useEffect(
    () => () => publishContext(handle.instanceToken, null),
    [publishContext, handle.instanceToken],
  );
  const liveSignal = useMemo(
    () => AbortSignal.any([signal, row.abort.signal]),
    [signal, row.abort],
  );
  const fileServices = useMemo(
    () =>
      createFileViewerServices(api, handle, liveSignal, {
        serverId: row.server.serverId,
        serverName: row.server.name,
      }),
    [api, handle, liveSignal, row.server.serverId, row.server.name],
  );
  // The panel subscribes to the retained store. Fresh inline presentation
  // callbacks must not turn a store update into another registration update.
  const presentationCallbacks = useRef({
    navigate,
    openFile,
    sendMessage,
    approve,
    onDisplayModeChange,
    onAppSupportedDisplayModesChange,
    currentThreadId,
    chooseViewer,
    renderOutcome,
    revalidate,
  });
  presentationCallbacks.current = {
    navigate,
    openFile,
    sendMessage,
    approve,
    onDisplayModeChange,
    onAppSupportedDisplayModesChange,
    currentThreadId,
    chooseViewer,
    renderOutcome,
    revalidate,
  };
  const setDisplayMode = useCallback(
    (mode: "inline" | "fullscreen" | "pip") =>
      presentationCallbacks.current.onDisplayModeChange(mode),
    [],
  );
  const setSupportedModes = useCallback(
    (modes: ("inline" | "fullscreen" | "pip")[] | undefined) =>
      presentationCallbacks.current.onAppSupportedDisplayModesChange(modes),
    [],
  );
  const params = useMemo<MCPAppsRendererProps>(
    () => ({
      chatSessionId: workspace.workspaceId,
      serverId: row.server.serverId,
      serverName: row.server.name,
      toolCallId: handle.operationId,
      toolName: row.declaration.toolName,
      resourceUri: handle.resourceUri,
      toolMetadata: handle.toolMetadata,
      toolsMetadata: handle.toolsMetadata,
      // The App renders as soon as it is opened (SEP-1865 initializes the UI
      // in parallel with the call) and shows its own loading state until the
      // entrypoint's result arrives.
      toolState: row.result ? "output-available" : "input-available",
      toolInput: handle.file ? { file: handle.file } : {},
      toolOutput: row.result,
      toolResponseMetadata: row.result?._meta,
      hostManagedPresentation: true,
      displayMode,
      fullscreenWidgetId:
        displayMode === "fullscreen" ? handle.instanceId : null,
      onDisplayModeChange: setDisplayMode,
      onAppSupportedDisplayModesChange: setSupportedModes,
      onInitialRenderOutcome: (outcome: "ready" | "error") =>
        presentationCallbacks.current.renderOutcome?.(row.key, outcome),
      onCallTool: (name, args) =>
        api
          .invoke(
            handle,
            liveSignal,
            (value, signal) =>
              presentationCallbacks.current.approve(
                { ...value, serverName: row.server.name },
                signal,
              ),
            { name, arguments: args },
          )
          .catch((error: unknown) => {
            if (
              error instanceof ThreadAppError &&
              APP_BINDING_CHANGED.has(error.code)
            )
              presentationCallbacks.current.revalidate?.(row.key);
            throw error;
          }),
    }),
    [
      workspace.workspaceId,
      row,
      row.result,
      handle,
      api,
      liveSignal,
      displayMode,
      setDisplayMode,
      setSupportedModes,
    ],
  );
  const ownedHost = useMemo(() => {
    let appHost = withLocalFileHost(
      withFileViewerHost(
        createThreadAppHost(
          host,
          handle,
          row.server.serverId,
          row.declaration.kind === "global" ? "global" : "thread",
        ),
        host,
        handle,
        fileServices,
      ),
      localFileApi,
      handle,
      liveSignal,
      (entry) => presentationCallbacks.current.openFile(row.server, entry),
      (entries, signal) =>
        presentationCallbacks.current.chooseViewer
          ? presentationCallbacks.current.chooseViewer(entries, signal)
          : Promise.resolve(null),
    );
    appHost = withThreadAppNavigation(appHost, host, handle, (url) =>
      presentationCallbacks.current.navigate(row.server, url),
    );
    if (messagesAllowed)
      appHost = withAppMessages(appHost, host, handle, {
        threadId: () =>
          presentationCallbacks.current.currentThreadId?.() ?? scope.threadId,
        isLive: () => !liveSignal.aborted,
        send: (...args) => {
          const send = presentationCallbacks.current.sendMessage;
          if (!send) throw new Error("This App can't send messages here.");
          return send(...args);
        },
      });
    const composed = withAppContext(appHost, host, handle, context);
    // Extensions that were off when the App opened never appear in
    // `experimental["openai/*"]`.
    return guardRetainedAppRequests(
      {
        ...composed,
        resolvers: {
          ...composed.resolvers,
          resolveEffectiveHostCapabilities: (
            args: Parameters<
              WidgetHost["resolvers"]["resolveEffectiveHostCapabilities"]
            >[0],
          ) =>
            filterOpenAiHostCapabilities(
              composed.resolvers.resolveEffectiveHostCapabilities(args),
              { capabilities: negotiatedCapabilities },
            ),
        },
      },
      refuse,
    );
  }, [
    host,
    handle,
    row.server,
    fileServices,
    localFileApi,
    liveSignal,
    context.update,
    scope.threadId,
    messagesAllowed,
    negotiatedCapabilities,
    refuse,
  ]);
  // What the bridge is built from is negotiated with the first composition
  // and kept for the App's lifetime (a new client snapshot, theme or toggle
  // recomposes `ownedHost`, never the bridge). Later compositions only
  // supply the current host context.
  const [negotiatedHost] = useState(() => negotiateRetainedAppHost(ownedHost));
  const dimensionsKey = containerDimensions
    ? `${containerDimensions.width}x${containerDimensions.height}`
    : "";
  const appHost = useMemo(
    () => {
      const current = withCurrentHostContext(negotiatedHost, ownedHost);
      return {
        ...current,
        environment: {
          ...current.environment,
          draftHostContext: {
            ...current.environment.draftHostContext,
            "openai/modelContext": contextAllowed
              ? context.snapshot.state
              : null,
            ...(containerDimensions ? { containerDimensions } : {}),
          },
        },
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [negotiatedHost, ownedHost, context.snapshot, contextAllowed, dimensionsKey],
  );
  useEffect(() => {
    workspace.surfaces
      .getState()
      .upsertRegistration(
        handle.instanceId,
        handle.operationId,
        params,
        appHost,
        "panel",
      );
  }, [workspace, handle, params, appHost]);
  return null;
}
/** Rows whose App is drawn: opened (even while its first call runs), not failed. */
export function isRenderedAppRow(row: AppRow): boolean {
  return (
    !!row.handle &&
    row.status !== "error" &&
    !row.closing &&
    row.handle.presentation !== "result"
  );
}

/**
 * Registrations, status and the retained surface host for one owner. Every
 * App's DOM parent is permanent; selection only toggles visibility.
 */
function RetainedAppsBody({
  ports,
  apps,
  active,
  close,
  retry,
}: {
  ports: RetainedAppPorts;
  apps: AppRow[];
  active: string | null;
  close: (row: AppRow) => Promise<void>;
  retry: (
    server: WorkspaceServer,
    declaration: ThreadAppDeclaration,
    deepLink?: string,
    waitForAdmission?: boolean,
  ) => Promise<void>;
}) {
  const host = useWidgetHost();
  const workspace = useWidgetWorkspace();
  const rendered = apps.filter(isRenderedAppRow);
  const renderedKey = rendered.map((row) => row.handle!.instanceId).join("\n");
  useEffect(() => {
    const live = new Set(renderedKey ? renderedKey.split("\n") : []);
    for (const id of workspace.surfaces.getState().surfaces.keys())
      if (!live.has(id)) closeWorkspaceSurface(workspace, id);
  }, [renderedKey, workspace]);
  const current = apps.find((row) => row.key === active);
  // The workspace refuses an App past its live limit instead of crashing.
  const refused = useWidgetSurfaceAdmissionError(
    current && isRenderedAppRow(current) ? current.handle!.instanceId : null,
  );
  // Entrypoints are always fullscreen: the host owns where they are drawn.
  const ignoreMode = useCallback(() => {}, []);
  // Fixed container dimensions, so an App can fill the rail tab or takeover.
  const [surfaceElement, setSurfaceElement] = useState<HTMLDivElement | null>(
    null,
  );
  const containerDimensions = useContainerDimensions(surfaceElement);
  return (
    <>
      {current?.status === "loading" && !current.handle && (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          Opening App…
        </p>
      )}
      {refused && (
        <p role="alert" className="p-4 text-sm">
          {refused.message}
        </p>
      )}
      {current?.status === "error" && (
        <div role="alert" className="p-4 text-sm">
          <p>{current.error}</p>
          {(current.retryable !== false || current.closing) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                current.closing
                  ? void close(current)
                  : void retry(current.server, current.declaration)
              }
            >
              {current.closing ? "Retry close" : "Retry"}
            </Button>
          )}
        </div>
      )}
      {rendered.map((row) => (
        <AppRegistration
          scope={ports.scope}
          publishContext={ports.publishContext}
          sendMessage={ports.sendMessage}
          currentThreadId={ports.currentThreadId}
          capabilities={ports.capabilities}
          chooseViewer={ports.chooseViewer}
          renderOutcome={ports.renderOutcome}
          revalidate={ports.revalidate}
          // A reopened App is a new activation: mount it fresh.
          key={`${row.key}:${row.handle!.instanceId}`}
          row={row}
          navigate={ports.navigate}
          openFile={ports.openFile}
          displayMode="fullscreen"
          containerDimensions={containerDimensions}
          onDisplayModeChange={ignoreMode}
          onAppSupportedDisplayModesChange={ignoreMode}
          host={host}
          api={ports.api}
          approve={ports.approve}
          signal={ports.signal}
        />
      ))}
      {current?.status === "live" &&
        current.handle?.presentation === "result" && (
          <div className="min-h-0 flex-1 overflow-auto p-4">
            <ResultsPanel
              error=""
              result={current.result as CallToolResult}
              structuredContentValid={undefined}
              serverName={current.server.name}
            />
          </div>
        )}
      <div
        ref={setSurfaceElement}
        hidden={!current || !isRenderedAppRow(current)}
        className="min-h-0 flex-1 overflow-auto"
        data-retained-app-surfaces
      >
        <WidgetWorkspaceSurfaceHost
          activeSurfaceId={
            current && isRenderedAppRow(current)
              ? current.handle!.instanceId
              : null
          }
        />
      </div>
    </>
  );
}

/** Settings sessions for an owner; hidden unless one is selected. */
export function SettingsSessionsView({
  settings,
}: {
  settings: ThreadAppWorkspace["settings"];
}) {
  return (
    <>
      {settings.sessions.map((session) => (
        <div
          key={`settings:${session.serverId}`}
          hidden={settings.activeServerId !== session.serverId}
          className="h-full min-h-0 overflow-auto"
        >
          {session.panel}
        </div>
      ))}
    </>
  );
}

/**
 * One owner's retained Apps without chrome, for a host-chosen container (a
 * right-rail tab body or the global takeover). Mount it once per owner.
 */
export function RetainedAppsView({
  workspace,
}: {
  workspace: ThreadAppWorkspace;
}) {
  if (!workspace.appPorts || !workspace.scope) return null;
  return (
    <>
      <WidgetWorkspaceProvider
        key={workspace.scope.pluginWorkspace.workspaceId}
        workspaceId={workspace.scope.pluginWorkspace.workspaceId}
      >
        <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
          <RetainedAppsBody
            ports={workspace.appPorts}
            apps={workspace.apps}
            active={workspace.active}
            close={workspace.close}
            retry={workspace.launch}
          />
        </div>
      </WidgetWorkspaceProvider>
      {workspace.approvalDialog}
    </>
  );
}

/** Inline presentation (compare lanes, embedded chats): its own header. */
function RetainedAppPanel({
  ports,
  apps,
  active,
  settings,
  select,
  hide,
  close,
  retry,
}: {
  ports: RetainedAppPorts;
  apps: AppRow[];
  active: string | null;
  settings: ReturnType<typeof useWorkspaceSettings>;
  select: (key: string | null) => void;
  hide: () => void;
  close: (row: AppRow) => Promise<void>;
  retry: (
    server: WorkspaceServer,
    declaration: ThreadAppDeclaration,
    deepLink?: string,
    waitForAdmission?: boolean,
  ) => Promise<void>;
}) {
  const current = apps.find((row) => row.key === active);
  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex items-center gap-1 border-b border-border p-2">
        <Button size="sm" variant="ghost" onClick={hide}>
          <ArrowLeft className="size-4" />
          Back to chat
        </Button>
        <div
          role="tablist"
          aria-label="Apps"
          className="flex min-w-0 flex-1 overflow-x-auto"
        >
          {apps.map((row) => (
            <Button
              key={row.key}
              role="tab"
              aria-selected={row.key === active}
              variant={row.key === active ? "secondary" : "ghost"}
              size="sm"
              onClick={() => select(row.key)}
              className="truncate"
            >
              {row.declaration.title}
            </Button>
          ))}
          {settings.sessions.map((session) => (
            <Button
              key={`settings:${session.serverId}`}
              role="tab"
              aria-selected={settings.activeServerId === session.serverId}
              variant={
                settings.activeServerId === session.serverId
                  ? "secondary"
                  : "ghost"
              }
              size="sm"
              onClick={() => {
                select(null);
                settings.open(session.serverId);
              }}
              className="truncate"
            >
              {session.name} settings
            </Button>
          ))}
        </div>
        {settings.activeServerId && (
          <Button
            type="button"
            size="icon"
            variant="ghost"
            aria-label="Close settings"
            onClick={() => settings.close()}
          >
            <X className="size-4" />
          </Button>
        )}
        {current && (
          <Button
            size="icon"
            variant="ghost"
            aria-label="Close App"
            onClick={() => void close(current)}
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
      <SettingsSessionsView settings={settings} />
      <div
        hidden={settings.activeServerId !== null}
        className="flex min-h-0 flex-1 flex-col"
      >
        <RetainedAppsBody
          ports={ports}
          apps={apps}
          active={active}
          close={close}
          retry={retry}
        />
      </div>
    </div>
  );
}

/** The element's size, rounded and settled; unset while it is hidden. */
function useContainerDimensions(element: HTMLElement | null) {
  const [size, setSize] = useState<{ width: number; height: number }>();
  useEffect(() => {
    if (!element || typeof ResizeObserver === "undefined") return;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const width = Math.round(element.clientWidth);
        const height = Math.round(element.clientHeight);
        if (!width || !height) return;
        setSize((old) =>
          old?.width === width && old.height === height
            ? old
            : { width, height },
        );
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [element]);
  return size;
}
