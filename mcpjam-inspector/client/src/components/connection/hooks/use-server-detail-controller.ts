import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { toast } from "@/lib/toast";
import { reportCaught } from "@/lib/error-reporting";
import { toastServerConnectionFailure } from "@/lib/server-error-toast";
import { track } from "@/lib/analytics";
import type { ServerWithName, ServerUpdateResult } from "@/hooks/use-app-state";
import type { Project } from "@/state/app-types";
import type { ServerFormData } from "@/shared/types.js";
import type { ConnectionIntent } from "@/shared/oauth-connections";
import type { McpProtocolVersion } from "@/lib/client-config-v2";
import {
  listTools,
  type ListToolsResultWithMetadata,
} from "@/lib/apis/mcp-tools-api";
import { fetchServerSecrets } from "@/lib/apis/server-secrets-api";
import {
  isMCPApp,
  isOpenAIApp,
  isOpenAIAppAndMCPApp,
} from "@/lib/mcp-ui/mcp-apps-utils";
import { useSettingsLaunchObservation } from "@/lib/use-extension-launch-health";
import type { ExtensionLaunchProfile } from "@/lib/extension-launch-health";
import { useDbUserReady } from "@/contexts/db-user-ready-context";
import { useServerSettingsAvailability } from "../../host-workspace/use-server-settings";
import type { ThreadAppScope } from "../../host-workspace/thread-app-api";
import {
  UNKNOWN_CONNECTION_STATUS,
  getConnectionStatusMeta,
  isConnectionStatus,
} from "../server-card-utils";
import { resolveServerAuth, type ServerAuth } from "../server-auth";
import { useServerForm } from "./use-server-form";
import {
  useServerAuthReveal,
  type ServerAuthReveal,
} from "./use-server-auth-reveal";
import {
  useServerProtocolPin,
  type ServerProtocolPin,
} from "./use-server-protocol-pin";

export type ServerDetailTab =
  | "settings"
  | "overview"
  | "configuration"
  | "authorization"
  | "tools-metadata"
  | "compatibility"
  | "history";

export interface ServerDetailTabDef {
  id: ServerDetailTab;
  label: string;
  /** Accessible name when the short label alone is ambiguous. */
  ariaLabel?: string;
}

/** Every tab in display order; `tabs.visible` filters it per server. */
export const SERVER_DETAIL_TAB_DEFS: ReadonlyArray<ServerDetailTabDef> = [
  { id: "configuration", label: "Config", ariaLabel: "Configuration" },
  { id: "overview", label: "Overview" },
  { id: "tools-metadata", label: "Tools", ariaLabel: "Tools metadata" },
  { id: "settings", label: "Settings" },
  { id: "authorization", label: "Auth" },
  { id: "compatibility", label: "Clients", ariaLabel: "Client compatibility" },
  { id: "history", label: "History" },
];

export interface ServerReconnectOptions {
  forceOAuthFlow?: boolean;
  connectionIntent?: ConnectionIntent;
  allowInteractiveOAuthFlow?: boolean;
}

export interface ServerDetailControllerOptions {
  /** False while the surface is hidden: tools, settings and OAuth lookups wait. */
  isOpen: boolean;
  server: ServerWithName;
  /** The tab to open on, for an explicit deep link. Defaults to Config. */
  defaultTab?: ServerDetailTab;
  /**
   * The active tab when the caller owns it (a page that keeps it in the
   * URL). Selecting a tab then calls `onTabChange` instead of storing it.
   */
  activeTab?: ServerDetailTab;
  onTabChange?: (tab: ServerDetailTab) => void;
  /** Where analytics events say the details were shown. */
  analyticsLocation?: "server_detail_modal" | "server_canvas";
  onSubmit: (
    formData: ServerFormData,
    originalServerName: string
  ) => Promise<ServerUpdateResult>;
  onDisconnect: (serverName: string) => void;
  onReconnect: (
    serverName: string,
    options?: ServerReconnectOptions
  ) => Promise<void>;
  onClose: () => void;
  existingServerNames: string[];
  projectClientConfig?: Project["clientConfig"];
  /** The Convex project id; null in local mode. */
  projectId?: string | null;
  /** The server's Convex document id; null when it is not saved to a project. */
  hostedServerId?: string | null;
  organizationId?: string | null;
  isSignedIn?: boolean;
  /**
   * Host-default outbound MCP wire mode resolved from the surrounding
   * client's hostConfig.mcpProfile. Kept as an explicit prop (PROP-FIRST,
   * falling back to `useActiveMcpProfile()`) even though the Servers tab
   * also mounts `ActiveMcpProfileProvider`: the prop is the authoritative
   * chip-attribution source everywhere the details render. Undefined = no
   * host-level pin = "Legacy · default" attribution on the chip.
   */
  hostDefaultMcpProtocolVersion?: McpProtocolVersion | "auto";
  extensionSettingsScope?: ThreadAppScope | null;
  extensionLaunchProfile?: ExtensionLaunchProfile;
}

export type ToolsLoadStatus = "idle" | "loading" | "failed" | "ready";

/** The detail shown when a failure carries no message of its own. */
const NO_REASON_GIVEN = "The server gave no reason. Check it and reconnect.";

const SAVED_HEADERS_UNREADABLE =
  "Couldn't load this server's saved headers to apply this change. Reveal saved headers in Advanced settings and try again.";

export interface ServerDetailController {
  server: ServerWithName;
  isOpen: boolean;
  projectId: string | null;
  hostedServerId: string | null;
  /** Signed in with a database user; gates project-scoped reads. */
  isUserReady: boolean;
  /** The server version from its initialize result. */
  version: string | undefined;
  tabs: {
    active: ServerDetailTab;
    select: (tab: ServerDetailTab) => void;
    /** The tabs this server shows, in display order. */
    visible: ReadonlyArray<ServerDetailTabDef>;
    showSettings: boolean;
    showAuthorization: boolean;
    showHistory: boolean;
  };
  connection: {
    isConnected: boolean;
    /** A user or wire-version reconnect is still running. */
    isReconnecting: boolean;
    statusLabel: string;
    indicatorClassName: string;
    /** The connect switch can't be used mid-connect. */
    toggleDisabled: boolean;
    connect: (options?: ServerReconnectOptions) => Promise<void>;
    disconnect: () => void;
    /** The connect switch: off disconnects, on reconnects. */
    toggle: (connected: boolean) => void;
  };
  form: {
    state: ReturnType<typeof useServerForm>;
    isDuplicateServerName: boolean;
    isSaving: boolean;
    /** Save, its button and Enter in any field are all blocked. */
    saveBlocked: boolean;
    /** A connected server with no edits offers Reconnect instead of Save. */
    offersReconnect: boolean;
    save: () => Promise<void>;
    saveButtonRef: RefObject<HTMLButtonElement | null>;
    saveHintRef: RefObject<HTMLParagraphElement | null>;
    saveHint: string | null;
    /** The configuration form's submit handler. */
    submit: (event: FormEvent<HTMLFormElement>) => void;
  };
  protocol: ServerProtocolPin;
  tools: {
    data: ListToolsResultWithMetadata | null;
    isLoading: boolean;
    error: string | null;
    status: ToolsLoadStatus;
    isMCPApp: boolean;
    isOpenAIApp: boolean;
    isOpenAIAppAndMCPApp: boolean;
  };
  auth: {
    summary: ServerAuth;
    reveal: ServerAuthReveal;
    /** Runs an interactive OAuth flow for a connection account. */
    authenticate: (connectionIntent: ConnectionIntent) => Promise<void>;
    /** Reconnects with the account just made current. */
    switchAccount: () => Promise<void>;
  };
  settings: {
    availability: ReturnType<typeof useServerSettingsAvailability>;
    launch: ReturnType<typeof useSettingsLaunchObservation>;
    scope: ThreadAppScope | null;
    launchProfile: ExtensionLaunchProfile | undefined;
    /** The Settings body mounts once visited and stays mounted. */
    showBody: boolean;
  };
  /** Closes the surface and records it. */
  close: () => void;
}

/** Loads tools metadata while the surface is open and the server connected. */
function useToolsMetadata(isOpen: boolean, server: ServerWithName) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ListToolsResultWithMetadata | null>(null);

  useEffect(() => {
    let isCancelled = false;

    const loadTools = async () => {
      if (!isOpen || server.connectionStatus !== "connected") {
        setIsLoading(false);
        setError(null);
        setData(null);
        return;
      }

      setIsLoading(true);
      setError(null);
      try {
        const result = await listTools({ serverId: server.name });
        if (!isCancelled) {
          setData(result);
          setError(null);
        }
      } catch (loadError) {
        if (!isCancelled) {
          console.error("Failed to load tools metadata:", loadError);
          // The Tools tab spins until `error` or `data` is set, so an empty
          // or non-Error rejection still needs a non-empty message.
          const message =
            loadError instanceof Error ? loadError.message.trim() : "";
          setError(message || NO_REASON_GIVEN);
          setData(null);
        }
      } finally {
        if (!isCancelled) {
          setIsLoading(false);
        }
      }
    };

    void loadTools();

    return () => {
      isCancelled = true;
    };
  }, [isOpen, server.connectionStatus, server.name]);

  const status: ToolsLoadStatus = isLoading
    ? "loading"
    : error
      ? "failed"
      : data
        ? "ready"
        : "idle";
  return { data, isLoading, error, status };
}

/**
 * State and actions behind a project server's detail tabs, so the modal and a
 * full page render the same Config, Overview, Tools, Settings, Auth, Clients
 * and History bodies with the same behavior.
 */
export function useServerDetailController({
  isOpen,
  server,
  defaultTab = "configuration",
  activeTab: controlledTab,
  onTabChange,
  analyticsLocation = "server_detail_modal",
  onSubmit,
  onDisconnect,
  onReconnect,
  onClose,
  existingServerNames,
  projectClientConfig,
  projectId = null,
  hostedServerId = null,
  organizationId = null,
  isSignedIn = false,
  hostDefaultMcpProtocolVersion,
  extensionSettingsScope = null,
  extensionLaunchProfile,
}: ServerDetailControllerOptions): ServerDetailController {
  const settings = useServerSettingsAvailability(
    isOpen ? extensionSettingsScope : null,
    hostedServerId
  );
  const [settingsVisited, setSettingsVisited] = useState(
    (controlledTab ?? defaultTab) === "settings"
  );
  const [ownTab, setOwnTab] = useState<ServerDetailTab>(defaultTab);
  const activeTab = controlledTab ?? ownTab;
  const selectTab = useCallback(
    (tab: ServerDetailTab) => {
      if (onTabChange) onTabChange(tab);
      else setOwnTab(tab);
      if (tab === "settings") setSettingsVisited(true);
    },
    [onTabChange]
  );
  useEffect(() => {
    if (controlledTab === "settings") setSettingsVisited(true);
  }, [controlledTab]);
  const settingsLaunch = useSettingsLaunchObservation(
    JSON.stringify([extensionSettingsScope, hostedServerId]),
    extensionLaunchProfile ?? "chatgpt",
    isOpen && settingsVisited && !!extensionSettingsScope,
    settings.failed
  );
  // Any HTTP server, matching the token section's own guard rather than
  // `useOAuth`: a server that has since had OAuth turned off can still hold
  // stored tokens, or unparseable ones, and "Saved auth data is invalid" has
  // to stay reachable. The sections inside hide themselves when there is
  // nothing to show.
  const showAuthorization = "url" in server.config;
  const serverAuth = useMemo(() => resolveServerAuth(server), [server]);
  const serverAuthReveal = useServerAuthReveal({
    projectId,
    serverId: hostedServerId,
    auth: serverAuth,
    isOpen,
    wantsNames: activeTab === "authorization",
  });
  // Reconnects overlap: two quick wire-mode changes start a second one while
  // the first is still running. A boolean would be cleared by whichever
  // finished first and let a configuration save through mid-reconnect, so the
  // guard counts them and lifts only when the last one settles.
  const [reconnectsInFlight, setReconnectsInFlight] = useState(0);
  const isReconnecting = reconnectsInFlight > 0;
  const [isSaving, setIsSaving] = useState(false);

  const isUserReady = useDbUserReady();
  // The project config is keyed by the server's Convex document `_id`, which
  // `ServerWithName` (local state keyed by name) doesn't carry; the caller
  // resolves it and passes it as `hostedServerId`.
  const serverId = hostedServerId ?? undefined;
  // The History tab + drift chip surface persisted snapshot revisions, which
  // only exist for project-scoped (hosted) servers — hidden in local mode.
  // Both surfaces key off `showHistory`, so this is the single gate.
  const showHistory = isUserReady && Boolean(projectId && serverId);

  /** The wire-version pin's reconnect, in flight like a user-initiated one. */
  const reconnectForProtocolPin = useCallback(async () => {
    setReconnectsInFlight((count) => count + 1);
    try {
      await onReconnect(server.name, { allowInteractiveOAuthFlow: false });
    } finally {
      setReconnectsInFlight((count) => count - 1);
    }
  }, [onReconnect, server.name]);
  const protocol = useServerProtocolPin({
    projectId,
    serverId,
    isUserReady,
    hostDefaultMcpProtocolVersion,
    reconnect: reconnectForProtocolPin,
  });

  const formState = useServerForm(server, {
    projectClientConfig,
    confidentialCimdProbeEnabled: isOpen,
    organizationId,
    isSignedIn,
  });
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const saveHintRef = useRef<HTMLParagraphElement>(null);
  const focusSaveOnConfig = useRef(false);
  const [saveHint, setSaveHint] = useState<string | null>(null);
  const isConnected = server.connectionStatus === "connected";
  const focusSaveAction = useCallback(() => {
    const button = saveButtonRef.current;
    const target = button?.disabled ? saveHintRef.current : button;
    if (!target) return;
    focusSaveOnConfig.current = false;
    target.focus();
  }, []);
  useEffect(() => {
    if (!isOpen || isConnected || !formState.hasChanges) {
      focusSaveOnConfig.current = false;
      setSaveHint(null);
    } else if (
      activeTab === "configuration" &&
      saveHint &&
      focusSaveOnConfig.current
    ) {
      focusSaveAction();
    }
  }, [
    isOpen,
    isConnected,
    activeTab,
    formState.hasChanges,
    saveHint,
    focusSaveAction,
  ]);
  const trimmedName = formState.name.trim();
  const isDuplicateServerName =
    trimmedName !== "" &&
    trimmedName !== server.name &&
    existingServerNames.includes(trimmedName);
  const tools = useToolsMetadata(isOpen, server);

  /** See ServerConnectionCard: unreadable is not the same claim as offline. */
  const { label: connectionStatusLabel, indicatorClassName } =
    isConnectionStatus(server.connectionStatus)
      ? getConnectionStatusMeta(server.connectionStatus)
      : UNKNOWN_CONNECTION_STATUS;

  const handleSave = async () => {
    setSaveHint(null);
    if (isDuplicateServerName) {
      toast.error(
        `A server named "${trimmedName}" already exists. Choose a different name.`
      );
      return;
    }

    const formError = formState.validateForm();
    if (formError) {
      toast.error(formError);
      return;
    }

    // Validate Client ID if using custom configuration
    if (
      formState.authType === "oauth" &&
      formState.registrationMode === "preregistered"
    ) {
      const clientIdError = formState.validateClientId(formState.clientId);
      if (clientIdError) {
        toast.error(clientIdError);
        return;
      }

      if (formState.clientSecret) {
        const clientSecretError = formState.validateClientSecret(
          formState.clientSecret
        );
        if (clientSecretError) {
          toast.error(clientSecretError);
          return;
        }
      }
    }

    track("update_server_button_clicked", {
      location: analyticsLocation,
    });

    setIsSaving(true);
    try {
      // Saving an auth or header change replaces the whole stored header
      // set. When that set is hidden, fetch it first so e.g. rotating a
      // bearer token doesn't wipe the other saved headers.
      let revealedHeaders: Record<string, string> | undefined;
      if (formState.needsStoredHeaderReveal) {
        if (!projectId || !hostedServerId) {
          toast.error(
            "Reveal saved headers before changing authentication so existing hidden headers aren't lost."
          );
          return;
        }
        try {
          const secrets = await fetchServerSecrets({
            projectId,
            serverId: hostedServerId,
          });
          revealedHeaders = secrets.headers ?? undefined;
        } catch (error) {
          reportCaught(error, {
            source: "server_detail_save_reveal_headers",
            level: "warning",
          });
          toast.error(SAVED_HEADERS_UNREADABLE);
          return;
        }
        // No headers means the stored set couldn't be read; merging against
        // it would wipe the saved headers, so fail closed.
        if (!revealedHeaders) {
          toast.error(SAVED_HEADERS_UNREADABLE);
          return;
        }
      }

      const finalFormData = formState.buildFormData({
        ...(revealedHeaders ? { revealedHeaders } : {}),
      });
      const result = await onSubmit(finalFormData, server.name);
      if (result.ok) formState.reloadSavedValues();
      // The surface stays open after a save, and the save may have replaced
      // the token or headers the Auth tab revealed; make it look them up again.
      serverAuthReveal.reset();
    } finally {
      setIsSaving(false);
    }
  };

  const handleConnect = async (options?: ServerReconnectOptions) => {
    setReconnectsInFlight((count) => count + 1);
    track("server_detail_modal_connect_clicked", {
      location: analyticsLocation,
      server_id: server.name,
    });
    try {
      await onReconnect(server.name, options);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : NO_REASON_GIVEN;
      toastServerConnectionFailure(server.name, errorMessage);
    } finally {
      setReconnectsInFlight((count) => count - 1);
    }
  };

  const handleDisconnect = () => {
    track("server_detail_modal_disconnect_clicked", {
      location: analyticsLocation,
      server_id: server.name,
    });
    onDisconnect(server.name);
  };

  const toggleConnection = (connected: boolean) => {
    if (!connected) {
      handleDisconnect();
      return;
    }
    if (formState.hasChanges) {
      focusSaveOnConfig.current = true;
      setSaveHint("Save your changes to connect.");
      if (activeTab === "configuration") focusSaveAction();
      else selectTab("configuration");
      return;
    }
    // A server that needs OAuth and has no tokens can only connect through
    // the interactive flow.
    void handleConnect({
      allowInteractiveOAuthFlow:
        server.useOAuth === true && !server.oauthTokens,
    });
  };

  const handleClose = () => {
    track("server_detail_modal_closed", {
      location: analyticsLocation,
      server_id: server.name,
    });
    onClose();
  };

  /**
   * The single condition that decides whether this configuration may be saved.
   *
   * One list read by both the Save button's `disabled` and the form's submit
   * handler, because Enter in any configuration input submits the form. It
   * covers the duplicate-name check, the auth-configuration block, and the
   * in-flight reconnect guard.
   */
  const saveBlocked =
    isDuplicateServerName ||
    isSaving ||
    isReconnecting ||
    (!formState.hasChanges && !isConnected) ||
    formState.authConfigurationBlocksSubmit;

  const handleConfigurationSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (activeTab !== "configuration" || saveBlocked) return;
    void handleSave();
  };

  const showSettings = settings.available || settings.failed;
  const visibleTabs = SERVER_DETAIL_TAB_DEFS.filter((tab) => {
    if (tab.id === "settings") return showSettings;
    if (tab.id === "authorization") return showAuthorization;
    if (tab.id === "history") return showHistory;
    return true;
  });

  return {
    server,
    isOpen,
    projectId,
    hostedServerId,
    isUserReady,
    version: server.initializationInfo?.serverVersion?.version,
    tabs: {
      active: activeTab,
      select: selectTab,
      visible: visibleTabs,
      showSettings,
      showAuthorization,
      showHistory,
    },
    connection: {
      isConnected,
      isReconnecting,
      statusLabel: connectionStatusLabel,
      indicatorClassName,
      toggleDisabled:
        isSaving ||
        isReconnecting ||
        server.connectionStatus === "connecting" ||
        server.connectionStatus === "oauth-flow",
      connect: handleConnect,
      disconnect: handleDisconnect,
      toggle: toggleConnection,
    },
    form: {
      state: formState,
      isDuplicateServerName,
      isSaving,
      saveBlocked,
      offersReconnect: isConnected && !formState.hasChanges,
      save: handleSave,
      saveButtonRef,
      saveHintRef,
      saveHint: formState.hasChanges ? saveHint : null,
      submit: handleConfigurationSubmit,
    },
    protocol,
    tools: {
      ...tools,
      isMCPApp: isMCPApp(tools.data),
      isOpenAIApp: isOpenAIApp(tools.data),
      isOpenAIAppAndMCPApp: isOpenAIAppAndMCPApp(tools.data),
    },
    auth: {
      summary: serverAuth,
      reveal: serverAuthReveal,
      authenticate: (connectionIntent) =>
        onReconnect(server.name, { forceOAuthFlow: true, connectionIntent }),
      switchAccount: () =>
        onReconnect(server.name, { allowInteractiveOAuthFlow: false }),
    },
    settings: {
      availability: settings,
      launch: settingsLaunch,
      scope: extensionSettingsScope,
      launchProfile: extensionLaunchProfile,
      showBody: Boolean(
        isOpen &&
        extensionSettingsScope &&
        hostedServerId &&
        settingsVisited &&
        showSettings
      ),
    },
    close: handleClose,
  };
}
