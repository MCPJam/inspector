import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  ExternalLink,
  Link2,
  Loader2,
  RefreshCw,
  Save,
} from "lucide-react";
import { ReactFlowProvider } from "@xyflow/react";
import { useConvexAuth } from "convex/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { ImperativePanelHandle } from "react-resizable-panels";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { AddServerModal } from "@/components/connection/AddServerModal";
import { SandboxUsagePanel } from "@/components/sandboxes/SandboxUsagePanel";
import {
  useSandbox,
  useSandboxMutations,
  type SandboxSettings,
} from "@/hooks/useSandboxes";
import { useIsMobile } from "@/hooks/use-mobile";
import { useServerMutations, type RemoteServer } from "@/hooks/useWorkspaces";
import { copyToClipboard } from "@/lib/clipboard";
import { getSandboxHostStyleShortLabel } from "@/lib/sandbox-host-style";
import { ChatTabV2 } from "@/components/ChatTabV2";
import type { ServerWithName } from "@/hooks/use-app-state";
import { useHostedOAuthGate } from "@/hooks/hosted/use-hosted-oauth-gate";
import type { HostedOAuthRequiredDetails } from "@/lib/hosted-oauth-required";
import { isHostedOAuthBusy } from "@/lib/hosted-oauth-resume";
import { getStoredTokens } from "@/lib/oauth/mcp-oauth";
import {
  SANDBOX_OAUTH_PENDING_KEY,
  buildPlaygroundSandboxLink,
  buildSandboxLink,
  writeBuilderSession,
  writePlaygroundSession,
  type SandboxBootstrapPayload,
  type SandboxBootstrapServer,
} from "@/lib/sandbox-session";
import { SandboxHostStyleProvider } from "@/contexts/sandbox-host-style-context";
import type { ServerFormData } from "@/shared/types";
import { buildSandboxCanvas } from "./sandboxCanvasBuilder";
import { SandboxCanvas } from "./SandboxCanvas";
import { DEFAULT_SYSTEM_PROMPT, toDraftConfig } from "./drafts";
import {
  SetupChecklistPanel,
  isInsecureUrl,
  updateSelectedServerIds,
  type SetupSectionId,
} from "./setup-checklist-panel";
import type { SandboxBuilderContext, SandboxDraftConfig } from "./types";
import "./sandbox-builder.css";

interface SandboxBuilderViewProps {
  workspaceId: string;
  workspaceName?: string | null;
  workspaceServers: RemoteServer[];
  sandboxId?: string | null;
  draft: SandboxDraftConfig | null;
  initialViewMode?: "setup" | "preview" | "usage";
  onBack: () => void;
  onSavedDraft: (sandbox: SandboxSettings) => void;
}

const DESKTOP_SETTINGS_PANE_DEFAULT_PERCENT = 35;
const DESKTOP_SETTINGS_PANE_MAX_PERCENT = 70;

type ViewMode = "setup" | "preview" | "usage";

function normalizeInitialViewMode(
  mode: string | undefined,
): ViewMode | undefined {
  if (!mode) return undefined;
  if (mode === "setup" || mode === "preview" || mode === "usage") return mode;
  if (mode === "builder") return "setup";
  if (mode === "insights") return "usage";
  return undefined;
}

function getSetupSectionForNode(nodeId: string | null): SetupSectionId {
  if (nodeId?.startsWith("server:")) {
    return "servers";
  }
  return "basics";
}

function SandboxBuilderChrome({
  title,
  subtitle,
  headerMode,
  isDirty,
  isSaving,
  hasSavedSandbox,
  viewMode,
  onBack,
  onSave,
  onCopyLink,
  onOpenFullPreview,
  onReloadPreview,
  onEditSetup,
  onModeChange,
}: {
  title: string;
  subtitle?: string;
  headerMode: "setup" | "preview" | "usage";
  isDirty: boolean;
  isSaving: boolean;
  hasSavedSandbox: boolean;
  viewMode: ViewMode;
  onBack: () => void;
  onSave: () => void;
  onCopyLink: () => void;
  onOpenFullPreview: () => void;
  onReloadPreview: () => void;
  onEditSetup: () => void;
  onModeChange: (mode: ViewMode) => void;
}) {
  const saveDisabled = isSaving || (!isDirty && hasSavedSandbox);
  const showCopyLink = hasSavedSandbox;

  return (
    <div className="shrink-0 border-b border-border/70">
      <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="rounded-xl"
            onClick={onBack}
          >
            <ArrowLeft className="mr-1.5 size-4" />
            Back
          </Button>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-semibold">{title}</h2>
              {isDirty && hasSavedSandbox ? (
                <Badge
                  variant="outline"
                  className="border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-300"
                >
                  Unsaved
                </Badge>
              ) : null}
            </div>
            {subtitle ? (
              <p className="mt-0.5 truncate text-sm text-muted-foreground">
                {subtitle}
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {showCopyLink ? (
            <Button
              variant="outline"
              className="rounded-xl"
              onClick={onCopyLink}
            >
              <Link2 className="mr-1.5 size-4" />
              Copy link
            </Button>
          ) : null}
          {headerMode === "preview" && (
            <>
              <Button
                variant="outline"
                className="rounded-xl"
                onClick={onOpenFullPreview}
                disabled={!hasSavedSandbox}
              >
                <ExternalLink className="mr-1.5 size-4" />
                Open full preview
              </Button>
              <Button
                variant="outline"
                className="rounded-xl"
                onClick={onReloadPreview}
                disabled={!hasSavedSandbox}
              >
                <RefreshCw className="mr-1.5 size-4" />
                Reload preview
              </Button>
              <Button variant="outline" className="rounded-xl" onClick={onEditSetup}>
                Edit setup
              </Button>
            </>
          )}
          <Button
            onClick={onSave}
            disabled={saveDisabled}
            variant={hasSavedSandbox && !isDirty ? "ghost" : "default"}
            className="rounded-xl"
          >
            {isSaving ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : (
              <Save className="mr-1.5 size-4" />
            )}
            Save
          </Button>
        </div>
      </div>

      <div className="border-t border-border/60 px-6">
        <nav
          className="flex w-full gap-0 overflow-x-auto"
          aria-label="Sandbox modes"
        >
          {(
            [
              ["setup", "Setup"],
              ["preview", "Preview"],
              ["usage", "Usage"],
            ] as const
          ).map(([mode, label]) => {
            const active = viewMode === mode;
            const disabled =
              mode === "preview" && !hasSavedSandbox
                ? true
                : mode === "usage" && !hasSavedSandbox;
            return (
              <button
                key={mode}
                type="button"
                disabled={disabled}
                onClick={() => onModeChange(mode)}
                className={`relative shrink-0 px-4 py-3 text-sm font-medium transition-colors ${
                  active
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
              >
                {label}
                {active ? (
                  <span className="absolute inset-x-4 bottom-0 h-0.5 rounded-full bg-primary" />
                ) : null}
              </button>
            );
          })}
        </nav>
      </div>
    </div>
  );
}

function getSandboxOAuthRowCopy(status: string): {
  description: string;
  buttonLabel: string | null;
} {
  switch (status) {
    case "launching":
      return { description: "Opening consent screen\u2026", buttonLabel: null };
    case "resuming":
      return {
        description: "Finishing authorization\u2026",
        buttonLabel: null,
      };
    case "verifying":
      return { description: "Verifying access\u2026", buttonLabel: null };
    case "error":
      return {
        description: "Authorization could not be completed. Try again.",
        buttonLabel: "Authorize again",
      };
    case "needs_auth":
    default:
      return {
        description: "You\u2019ll return here automatically after consent.",
        buttonLabel: "Authorize",
      };
  }
}

export function SandboxBuilderView({
  workspaceId,
  workspaceName,
  workspaceServers,
  sandboxId,
  draft,
  initialViewMode,
  onBack,
  onSavedDraft,
}: SandboxBuilderViewProps) {
  const { isAuthenticated } = useConvexAuth();
  const isMobile = useIsMobile();
  const { sandbox } = useSandbox({
    isAuthenticated,
    sandboxId: sandboxId ?? null,
  });
  const { createSandbox, updateSandbox, setSandboxMode } =
    useSandboxMutations();
  const { createServer } = useServerMutations();

  const [draftSandboxConfig, setDraftSandboxConfig] =
    useState<SandboxDraftConfig>(
      draft ??
        toDraftConfig(
          sandbox ??
            ({
              sandboxId: "",
              workspaceId,
              name: "New Sandbox",
              hostStyle: "claude",
              systemPrompt: DEFAULT_SYSTEM_PROMPT,
              modelId: "openai/gpt-5-mini",
              temperature: 0.7,
              requireToolApproval: false,
              allowGuestAccess: false,
              mode: "any_signed_in_with_link",
              servers: [],
              link: null,
              members: [],
              welcomeDialog: { enabled: true, body: "" },
              feedbackDialog: { enabled: true, everyNToolCalls: 1, promptHint: "" },
            } as SandboxSettings),
        ),
    );
  const [viewMode, setViewMode] = useState<ViewMode>(
    () => normalizeInitialViewMode(initialViewMode) ?? "setup",
  );
  const [chatKey, setChatKey] = useState(0);
  const [playgroundId, setPlaygroundId] = useState(() => crypto.randomUUID());
  const [isSetupSheetOpen, setIsSetupSheetOpen] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("host");
  const [focusedSetupSection, setFocusedSetupSection] =
    useState<SetupSectionId | null>(null);
  const [desktopSettingsPaneSize, setDesktopSettingsPaneSize] = useState(
    DESKTOP_SETTINGS_PANE_DEFAULT_PERCENT,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isAddServerOpen, setIsAddServerOpen] = useState(false);
  const panelGroupContainerRef = useRef<HTMLDivElement | null>(null);
  const rightPanelRef = useRef<ImperativePanelHandle | null>(null);
  const isInitialMountRef = useRef(true);
  const pendingRestartRef = useRef(false);
  const prevViewModeRef = useRef(viewMode);

  // Sync builder session to sessionStorage so it survives OAuth redirects
  useEffect(() => {
    writeBuilderSession({
      workspaceId,
      sandboxId: sandboxId ?? null,
      draft: draftSandboxConfig as unknown as Record<string, unknown>,
      viewMode,
    });
  }, [workspaceId, sandboxId, draftSandboxConfig, viewMode]);

  const behaviorFingerprint = useMemo(
    () =>
      JSON.stringify({
        name: draftSandboxConfig.name,
        hostStyle: draftSandboxConfig.hostStyle,
        systemPrompt: draftSandboxConfig.systemPrompt,
        modelId: draftSandboxConfig.modelId,
        temperature: draftSandboxConfig.temperature,
        requireToolApproval: draftSandboxConfig.requireToolApproval,
        mode: draftSandboxConfig.mode,
        allowGuestAccess: draftSandboxConfig.allowGuestAccess,
        welcomeDialog: draftSandboxConfig.welcomeDialog,
        feedbackDialog: draftSandboxConfig.feedbackDialog,
        selectedServerIds: [...draftSandboxConfig.selectedServerIds].sort(),
      }),
    [draftSandboxConfig],
  );

  // Debounced auto-restart on behavior-affecting changes
  useEffect(() => {
    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      return;
    }

    if (viewMode !== "preview" || !sandbox?.link?.token) {
      pendingRestartRef.current = true;
      return;
    }

    const timer = setTimeout(() => {
      const nextId = crypto.randomUUID();
      setPlaygroundId(nextId);
      setChatKey((k) => k + 1);
    }, 400);

    return () => clearTimeout(timer);
  }, [behaviorFingerprint]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pending restart when switching back to preview
  useEffect(() => {
    const prev = prevViewModeRef.current;
    prevViewModeRef.current = viewMode;

    if (
      prev !== viewMode &&
      viewMode === "preview" &&
      pendingRestartRef.current
    ) {
      pendingRestartRef.current = false;
      const nextId = crypto.randomUUID();
      setPlaygroundId(nextId);
      setChatKey((k) => k + 1);
    }
  }, [viewMode]);

  // Playground snapshot writer — keeps localStorage in sync with draft config
  useEffect(() => {
    if (!sandbox?.link?.token) return;

    const servers: SandboxBootstrapServer[] =
      draftSandboxConfig.selectedServerIds
        .map((id) => {
          const server = workspaceServers.find((s) => s._id === id);
          if (!server) return null;
          return {
            serverId: server._id,
            serverName: server.name,
            useOAuth: Boolean(server.useOAuth),
            serverUrl: server.url ?? null,
            clientId: server.clientId ?? null,
            oauthScopes: server.oauthScopes ?? null,
          } satisfies SandboxBootstrapServer;
        })
        .filter((s): s is SandboxBootstrapServer => s !== null);

    const payload: SandboxBootstrapPayload = {
      workspaceId: sandbox.workspaceId,
      sandboxId: sandbox.sandboxId,
      name: draftSandboxConfig.name,
      description: draftSandboxConfig.description || undefined,
      hostStyle: draftSandboxConfig.hostStyle,
      mode: draftSandboxConfig.mode,
      allowGuestAccess: draftSandboxConfig.allowGuestAccess,
      viewerIsWorkspaceMember: true,
      systemPrompt: draftSandboxConfig.systemPrompt,
      modelId: draftSandboxConfig.modelId,
      temperature: draftSandboxConfig.temperature,
      requireToolApproval: draftSandboxConfig.requireToolApproval,
      servers,
    };

    writePlaygroundSession({
      token: sandbox.link.token,
      payload,
      surface: "preview",
      playgroundId,
      updatedAt: Date.now(),
    });
  }, [draftSandboxConfig, sandbox, workspaceServers, playgroundId]);

  useEffect(() => {
    if (!draft && sandbox) {
      setDraftSandboxConfig(toDraftConfig(sandbox));
    }
  }, [draft, sandbox]);

  useEffect(() => {
    if (viewMode === "setup" && isMobile) {
      setIsSetupSheetOpen(true);
    }
  }, [viewMode, isMobile]);

  const context = useMemo<SandboxBuilderContext>(
    () => ({
      sandbox: sandbox ?? null,
      draft: draftSandboxConfig,
      workspaceServers,
    }),
    [draftSandboxConfig, sandbox, workspaceServers],
  );
  const viewModel = useMemo(() => buildSandboxCanvas(context), [context]);
  const desktopRightPanelDefaultSize = desktopSettingsPaneSize;
  const desktopLeftPanelDefaultSize = 100 - desktopRightPanelDefaultSize;

  const isDirty = useMemo(() => {
    if (!sandbox) return true;
    const currentIds = sandbox.servers.map((server) => server.serverId).sort();
    const draftIds = [...draftSandboxConfig.selectedServerIds].sort();
    return (
      draftSandboxConfig.name !== sandbox.name ||
      draftSandboxConfig.description !== (sandbox.description ?? "") ||
      draftSandboxConfig.hostStyle !== sandbox.hostStyle ||
      draftSandboxConfig.systemPrompt !== sandbox.systemPrompt ||
      draftSandboxConfig.modelId !== sandbox.modelId ||
      draftSandboxConfig.temperature !== sandbox.temperature ||
      draftSandboxConfig.requireToolApproval !== sandbox.requireToolApproval ||
      draftSandboxConfig.mode !== sandbox.mode ||
      draftSandboxConfig.allowGuestAccess !== sandbox.allowGuestAccess ||
      JSON.stringify(draftSandboxConfig.welcomeDialog) !==
        JSON.stringify({
          enabled: sandbox.welcomeDialog?.enabled ?? true,
          body: sandbox.welcomeDialog?.body ?? "",
        }) ||
      JSON.stringify(draftSandboxConfig.feedbackDialog) !==
        JSON.stringify({
          enabled: sandbox.feedbackDialog?.enabled ?? true,
          everyNToolCalls: Math.max(
            1,
            sandbox.feedbackDialog?.everyNToolCalls ?? 1,
          ),
          promptHint: sandbox.feedbackDialog?.promptHint ?? "",
        }) ||
      JSON.stringify(currentIds) !== JSON.stringify(draftIds)
    );
  }, [draftSandboxConfig, sandbox]);

  const hasSavedSandbox = Boolean(sandbox?.sandboxId);

  const shareLink = sandbox?.link?.token
    ? buildSandboxLink(sandbox.link.token, sandbox.name)
    : null;

  const sandboxServerConfigs = useMemo(() => {
    const entries = draftSandboxConfig.selectedServerIds.flatMap((id) => {
      const server = workspaceServers.find((s) => s._id === id);
      if (!server) return [];
      return [
        [
          server.name,
          {
            name: server.name,
            connectionStatus: "connected" as const,
            config: { url: "https://sandbox-chat.invalid" } as any,
            lastConnectionTime: new Date(),
            retryCount: 0,
            enabled: true,
          } satisfies ServerWithName,
        ],
      ];
    });
    return Object.fromEntries(entries);
  }, [draftSandboxConfig.selectedServerIds, workspaceServers]);

  const selectedPreviewServers = useMemo(() => {
    return draftSandboxConfig.selectedServerIds
      .map((id) => {
        const server = workspaceServers.find((s) => s._id === id);
        if (!server) return null;
        return {
          serverId: server._id,
          serverName: server.name,
          useOAuth: Boolean(server.useOAuth),
          serverUrl: server.url ?? null,
          clientId: server.clientId ?? null,
          oauthScopes: server.oauthScopes ?? null,
        } satisfies SandboxBootstrapServer;
      })
      .filter((s): s is SandboxBootstrapServer => s !== null);
  }, [draftSandboxConfig.selectedServerIds, workspaceServers]);

  const {
    oauthStateByServerId,
    pendingOAuthServers,
    authorizeServer,
    markOAuthRequired,
  } = useHostedOAuthGate({
    surface: "sandbox",
    pendingKey: SANDBOX_OAUTH_PENDING_KEY,
    servers: selectedPreviewServers,
  });

  const previewOAuthTokens = useMemo(() => {
    const entries = selectedPreviewServers
      .map((server) => {
        const token = getStoredTokens(server.serverName)?.access_token;
        return token ? ([server.serverId, token] as const) : null;
      })
      .filter((entry): entry is readonly [string, string] =>
        Array.isArray(entry),
      );
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }, [oauthStateByServerId, selectedPreviewServers]);

  const isFinishingPreviewOAuth =
    pendingOAuthServers.length > 0 &&
    pendingOAuthServers.every(({ state }) => isHostedOAuthBusy(state.status));

  const handlePreviewOAuthRequired = useCallback(
    (details?: HostedOAuthRequiredDetails) => {
      markOAuthRequired(details);
    },
    [markOAuthRequired],
  );

  const saveSandbox = useCallback(async (): Promise<boolean> => {
    const trimmedName = draftSandboxConfig.name.trim();
    if (!trimmedName) {
      toast.error("Sandbox name is required");
      return false;
    }
    if (draftSandboxConfig.selectedServerIds.length === 0) {
      toast.error("Select at least one HTTPS server");
      return false;
    }
    const selectedServers = workspaceServers.filter((server) =>
      draftSandboxConfig.selectedServerIds.includes(server._id),
    );
    if (selectedServers.some((server) => isInsecureUrl(server.url))) {
      toast.error("Only HTTPS servers can be used in sandboxes");
      return false;
    }

    setIsSaving(true);
    try {
      const payload = {
        name: trimmedName,
        description: draftSandboxConfig.description.trim() || undefined,
        hostStyle: draftSandboxConfig.hostStyle,
        systemPrompt:
          draftSandboxConfig.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT,
        modelId: draftSandboxConfig.modelId,
        temperature: draftSandboxConfig.temperature,
        requireToolApproval: draftSandboxConfig.requireToolApproval,
        serverIds: draftSandboxConfig.selectedServerIds,
        allowGuestAccess: draftSandboxConfig.allowGuestAccess,
        welcomeDialog: draftSandboxConfig.welcomeDialog,
        feedbackDialog: draftSandboxConfig.feedbackDialog,
      };

      if (!sandbox) {
        let created = (await createSandbox({
          workspaceId,
          ...payload,
        })) as SandboxSettings;
        if (draftSandboxConfig.mode !== "invited_only") {
          created = (await setSandboxMode({
            sandboxId: created.sandboxId,
            mode: draftSandboxConfig.mode,
          })) as SandboxSettings;
        }
        toast.success("Sandbox created");
        setViewMode("preview");
        onSavedDraft(created);
        return true;
      }

      await updateSandbox({
        sandboxId: sandbox.sandboxId,
        ...payload,
      });
      toast.success("Sandbox updated");
      return true;
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save sandbox",
      );
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [
    createSandbox,
    draftSandboxConfig,
    onSavedDraft,
    sandbox,
    setSandboxMode,
    updateSandbox,
    workspaceId,
    workspaceServers,
  ]);

  const saveAndOpenPreview = useCallback(async () => {
    const ok = await saveSandbox();
    if (ok) {
      setViewMode("preview");
    }
  }, [saveSandbox]);

  const handleCopyLink = useCallback(async () => {
    if (!shareLink) {
      toast.error("Sandbox link unavailable");
      return;
    }
    const didCopy = await copyToClipboard(shareLink);
    if (didCopy) {
      toast.success("Sandbox link copied");
    } else {
      toast.error("Failed to copy link");
    }
  }, [shareLink]);

  const handleOpenFullPreview = useCallback(() => {
    if (!sandbox?.link?.token) {
      toast.error("Sandbox link unavailable");
      return;
    }
    const link = buildPlaygroundSandboxLink(
      sandbox.link.token,
      draftSandboxConfig.name || sandbox.name,
      playgroundId,
    );
    window.open(link, "_blank", "noopener,noreferrer");
  }, [sandbox, draftSandboxConfig.name, playgroundId]);

  const handleAddServer = useCallback(
    async (formData: ServerFormData) => {
      if (formData.type !== "http") {
        toast.error("Only HTTP servers can be used in sandboxes");
        return;
      }
      if (isInsecureUrl(formData.url)) {
        toast.error("Only HTTPS servers can be used in sandboxes");
        return;
      }
      try {
        const serverId = (await createServer({
          workspaceId,
          name: formData.name,
          enabled: true,
          transportType: "http",
          url: formData.url,
          headers: formData.headers,
          timeout: formData.requestTimeout,
          useOAuth: formData.useOAuth,
          oauthScopes: formData.oauthScopes,
          clientId: formData.clientId,
        })) as string;
        setDraftSandboxConfig((current) => ({
          ...current,
          selectedServerIds: updateSelectedServerIds(
            current.selectedServerIds,
            serverId,
            true,
          ),
        }));
        setSelectedNodeId(`server:${serverId}`);
        setFocusedSetupSection("servers");
        setIsSetupSheetOpen(true);
        toast.success(`Server "${formData.name}" added`);
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "Failed to add server",
        );
      }
    },
    [createServer, workspaceId],
  );

  const handleToggleServer = useCallback(
    (serverId: string, checked: boolean) => {
      setDraftSandboxConfig((current) => {
        const selectedServerIds = updateSelectedServerIds(
          current.selectedServerIds,
          serverId,
          checked,
        );

        if (selectedServerIds === current.selectedServerIds) {
          return current;
        }

        return {
          ...current,
          selectedServerIds,
        };
      });

      if (checked) {
        setSelectedNodeId(`server:${serverId}`);
        setFocusedSetupSection("servers");
        setIsSetupSheetOpen(true);
        return;
      }

      setSelectedNodeId((current) =>
        current === `server:${serverId}` ? "host" : current,
      );
    },
    [],
  );

  const previewRailConfig = useMemo(() => {
    if (sandbox && isDirty) {
      return {
        hostStyle: sandbox.hostStyle,
        serverCount: sandbox.servers.length,
        welcomeOn: sandbox.welcomeDialog?.enabled ?? true,
        feedbackOn: sandbox.feedbackDialog?.enabled ?? true,
        feedbackEvery: Math.max(1, sandbox.feedbackDialog?.everyNToolCalls ?? 1),
      };
    }
    return {
      hostStyle: draftSandboxConfig.hostStyle,
      serverCount: draftSandboxConfig.selectedServerIds.length,
      welcomeOn: draftSandboxConfig.welcomeDialog.enabled,
      feedbackOn: draftSandboxConfig.feedbackDialog.enabled,
      feedbackEvery: draftSandboxConfig.feedbackDialog.everyNToolCalls,
    };
  }, [sandbox, isDirty, draftSandboxConfig]);

  const reloadPreview = useCallback(() => {
    const nextId = crypto.randomUUID();
    setPlaygroundId(nextId);
    setChatKey((k) => k + 1);
  }, []);

  const setupPanel = (
    <div className="sandbox-builder-pane flex h-full min-h-0 flex-col border-l border-border/70">
      <SetupChecklistPanel
        sandboxDraft={draftSandboxConfig}
        savedSandbox={sandbox ?? null}
        workspaceServers={workspaceServers}
        workspaceName={workspaceName}
        focusedSection={focusedSetupSection}
        isUnsavedNewDraft={!sandboxId}
        onDraftChange={(updater) =>
          setDraftSandboxConfig((current) => updater(current))
        }
        onOpenAddServer={() => {
          setFocusedSetupSection("servers");
          setIsSetupSheetOpen(true);
          setIsAddServerOpen(true);
        }}
        onToggleServer={handleToggleServer}
        onCloseMobile={() => setIsSetupSheetOpen(false)}
      />
    </div>
  );

  const showDesktopSetupPanel =
    viewMode === "setup" && !isMobile;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SandboxBuilderChrome
        title={
          viewMode === "usage"
            ? "Usage"
            : viewModel.title
        }
        subtitle={
          viewMode === "usage"
            ? sandbox?.description ?? undefined
            : viewModel.description || undefined
        }
        headerMode={
          viewMode === "usage"
            ? "usage"
            : viewMode === "preview"
              ? "preview"
              : "setup"
        }
        isDirty={isDirty}
        isSaving={isSaving}
        hasSavedSandbox={hasSavedSandbox}
        viewMode={viewMode}
        onBack={onBack}
        onSave={() => void saveSandbox()}
        onCopyLink={() => void handleCopyLink()}
        onOpenFullPreview={handleOpenFullPreview}
        onReloadPreview={reloadPreview}
        onEditSetup={() => setViewMode("setup")}
        onModeChange={(mode) => {
          if (mode === "preview" && !sandbox?.link?.token) {
            toast.error("Save the sandbox first to preview");
            return;
          }
          if (mode === "usage" && !sandbox) {
            return;
          }
          setViewMode(mode);
        }}
      />

      {viewMode === "usage" && sandbox ? (
        <div className="min-h-0 flex-1">
          <SandboxUsagePanel sandbox={sandbox} />
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 p-4">
          {isMobile &&
          viewMode === "setup" &&
          !isSetupSheetOpen ? (
            <Button
              type="button"
              className="absolute right-6 bottom-6 z-10 rounded-full shadow-lg"
              onClick={() => setIsSetupSheetOpen(true)}
            >
              Setup
            </Button>
          ) : null}
          <div ref={panelGroupContainerRef} className="h-full">
            <ResizablePanelGroup direction="horizontal" className="h-full">
              <ResizablePanel
                defaultSize={desktopLeftPanelDefaultSize}
                minSize={30}
              >
                <div className="h-full min-h-0 pr-2">
                  {viewMode === "preview" ? (
                    <div className="flex h-full min-h-0 flex-col gap-3 md:flex-row">
                      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[28px] border border-border/70 bg-card/60">
                        {isDirty && sandbox ? (
                          <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-950 dark:text-amber-100">
                            <span className="font-medium">
                              Preview is showing the last saved sandbox configuration.
                            </span>{" "}
                            <Button
                              variant="link"
                              className="h-auto p-0 text-amber-950 underline dark:text-amber-100"
                              onClick={() => void saveSandbox()}
                            >
                              Save changes
                            </Button>
                            {" · "}
                            <Button
                              variant="link"
                              className="h-auto p-0 text-amber-950 underline dark:text-amber-100"
                              onClick={reloadPreview}
                            >
                              Reload preview
                            </Button>
                          </div>
                        ) : null}
                        <div className="flex min-h-0 flex-1 flex-col">
                          {sandbox?.link?.token ? (
                            pendingOAuthServers.length > 0 ? (
                              <div className="flex flex-1 items-center justify-center p-6">
                                <div className="w-full max-w-xl rounded-2xl border bg-background p-6">
                                  <h3 className="text-center text-base font-semibold">
                                    {isFinishingPreviewOAuth
                                      ? "Finishing authorization"
                                      : "Authorization Required"}
                                  </h3>
                                  <p className="mt-2 text-center text-sm text-muted-foreground">
                                    {isFinishingPreviewOAuth
                                      ? "Finishing authorization for the required sandbox servers."
                                      : "Authorize the required sandbox servers to continue."}
                                  </p>
                                  <div className="mt-5 space-y-3">
                                    {pendingOAuthServers.map(
                                      ({ server, state }) => {
                                        const rowCopy = getSandboxOAuthRowCopy(
                                          state.status,
                                        );
                                        return (
                                          <div
                                            key={server.serverId}
                                            className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2"
                                          >
                                            <div className="min-w-0">
                                              <p className="truncate text-sm font-medium">
                                                {server.serverName}
                                              </p>
                                              <p className="text-xs text-muted-foreground">
                                                {state.status === "error" &&
                                                state.errorMessage
                                                  ? state.errorMessage
                                                  : rowCopy.description}
                                              </p>
                                            </div>
                                            {rowCopy.buttonLabel ? (
                                              <Button
                                                size="sm"
                                                onClick={() =>
                                                  void authorizeServer(server)
                                                }
                                              >
                                                {rowCopy.buttonLabel}
                                              </Button>
                                            ) : (
                                              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                                            )}
                                          </div>
                                        );
                                      },
                                    )}
                                  </div>
                                </div>
                              </div>
                            ) : (
                              <SandboxHostStyleProvider
                                value={draftSandboxConfig.hostStyle}
                              >
                                <ChatTabV2
                                  key={chatKey}
                                  connectedOrConnectingServerConfigs={
                                    sandboxServerConfigs
                                  }
                                  selectedServerNames={Object.keys(
                                    sandboxServerConfigs,
                                  )}
                                  minimalMode
                                  reasoningDisplayMode="hidden"
                                  hostedWorkspaceIdOverride={
                                    sandbox!.workspaceId
                                  }
                                  hostedSelectedServerIdsOverride={
                                    draftSandboxConfig.selectedServerIds
                                  }
                                  hostedOAuthTokensOverride={previewOAuthTokens}
                                  hostedSandboxToken={sandbox.link.token}
                                  hostedSandboxSurface="preview"
                                  initialModelId={draftSandboxConfig.modelId}
                                  initialSystemPrompt={
                                    draftSandboxConfig.systemPrompt
                                  }
                                  initialTemperature={
                                    draftSandboxConfig.temperature
                                  }
                                  initialRequireToolApproval={
                                    draftSandboxConfig.requireToolApproval
                                  }
                                  onOAuthRequired={handlePreviewOAuthRequired}
                                />
                              </SandboxHostStyleProvider>
                            )
                          ) : (
                            <div className="flex flex-1 items-center justify-center p-6">
                              <Card className="max-w-sm rounded-3xl border-dashed p-6 text-center">
                                <h3 className="text-base font-semibold">
                                  Preview unavailable
                                </h3>
                                <p className="mt-2 text-sm text-muted-foreground">
                                  Save the sandbox to generate a preview link.
                                </p>
                              </Card>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="hidden w-full shrink-0 flex-col gap-4 rounded-[28px] border border-border/70 bg-card/50 p-4 md:flex md:w-[300px] lg:w-[320px]">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Sandbox config
                          </p>
                          <dl className="mt-3 space-y-2 text-sm">
                            <div className="flex justify-between gap-2">
                              <dt className="text-muted-foreground">
                                Host style
                              </dt>
                              <dd>
                                {getSandboxHostStyleShortLabel(
                                  previewRailConfig.hostStyle,
                                )}
                              </dd>
                            </div>
                            <div className="flex justify-between gap-2">
                              <dt className="text-muted-foreground">Servers</dt>
                              <dd>
                                {previewRailConfig.serverCount} connected
                              </dd>
                            </div>
                            <div className="flex justify-between gap-2">
                              <dt className="text-muted-foreground">
                                Welcome dialog
                              </dt>
                              <dd>{previewRailConfig.welcomeOn ? "On" : "Off"}</dd>
                            </div>
                            <div className="flex justify-between gap-2">
                              <dt className="text-muted-foreground">Feedback</dt>
                              <dd>
                                {previewRailConfig.feedbackOn
                                  ? `Every ${previewRailConfig.feedbackEvery} tool call(s)`
                                  : "Off"}
                              </dd>
                            </div>
                          </dl>
                        </div>
                        <div className="border-t border-border/60 pt-4">
                          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            Current test status
                          </p>
                          <dl className="mt-3 space-y-2 text-sm">
                            <div className="flex justify-between gap-2">
                              <dt className="text-muted-foreground">State</dt>
                              <dd>
                                {pendingOAuthServers.length > 0
                                  ? "Auth required"
                                  : sandbox?.link?.token
                                    ? "Ready to test"
                                    : "Unavailable"}
                              </dd>
                            </div>
                            <div className="flex justify-between gap-2">
                              <dt className="text-muted-foreground">
                                Tool calls (this run)
                              </dt>
                              <dd className="font-mono">—</dd>
                            </div>
                          </dl>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <ReactFlowProvider>
                      <SandboxCanvas
                        viewModel={viewModel}
                        selectedNodeId={selectedNodeId}
                        onAddServer={() => {
                          setFocusedSetupSection("servers");
                          setIsSetupSheetOpen(true);
                          setIsAddServerOpen(true);
                        }}
                        onSelectNode={(nodeId) => {
                          setSelectedNodeId(nodeId);
                          setFocusedSetupSection(getSetupSectionForNode(nodeId));
                          setIsSetupSheetOpen(true);
                        }}
                        onClearSelection={() => {
                          setSelectedNodeId(null);
                        }}
                      />
                    </ReactFlowProvider>
                  )}
                </div>
              </ResizablePanel>

              {showDesktopSetupPanel ? (
                <>
                  <ResizableHandle withHandle />
                  <ResizablePanel
                    ref={rightPanelRef}
                    defaultSize={desktopRightPanelDefaultSize}
                    minSize={DESKTOP_SETTINGS_PANE_DEFAULT_PERCENT}
                    maxSize={DESKTOP_SETTINGS_PANE_MAX_PERCENT}
                    onResize={(size) => setDesktopSettingsPaneSize(size)}
                  >
                    {setupPanel}
                  </ResizablePanel>
                </>
              ) : null}
            </ResizablePanelGroup>
          </div>
          {viewMode === "setup" ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center border-t border-border/60 bg-background/80 p-4 backdrop-blur-md">
              <Button
                className="pointer-events-auto rounded-xl"
                onClick={() => void saveAndOpenPreview()}
                disabled={isSaving}
              >
                Save and open preview
              </Button>
            </div>
          ) : null}
        </div>
      )}

      <Sheet
        open={isMobile && viewMode === "setup" && isSetupSheetOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsSetupSheetOpen(false);
          }
        }}
      >
        <SheetContent
          side="bottom"
          className="h-[78vh] rounded-t-[28px] border-border/70 p-0"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Sandbox setup</SheetTitle>
            <SheetDescription>
              Configure host style, servers, access, and feedback.
            </SheetDescription>
          </SheetHeader>
          {setupPanel}
        </SheetContent>
      </Sheet>

      <AddServerModal
        isOpen={isAddServerOpen}
        onClose={() => setIsAddServerOpen(false)}
        onSubmit={(formData) => void handleAddServer(formData)}
        initialData={{ type: "http" }}
        requireHttps
      />
    </div>
  );
}
