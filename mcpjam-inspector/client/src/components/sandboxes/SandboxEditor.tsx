import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Globe,
  Loader2,
  Lock,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import {
  isMCPJamProvidedModel,
  SUPPORTED_MODELS,
  type ServerFormData,
} from "@/shared/types";
import type { SandboxMode, SandboxSettings } from "@/hooks/useSandboxes";
import { useSandboxMutations } from "@/hooks/useSandboxes";
import { useServerMutations } from "@/hooks/useWorkspaces";
import { AddServerModal } from "@/components/connection/AddServerModal";
import { SandboxDeleteConfirmDialog } from "@/components/sandboxes/SandboxDeleteConfirmDialog";
import { SandboxShareSection } from "@/components/sandboxes/SandboxShareSection";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ChatTabV2 } from "@/components/ChatTabV2";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getLoadingIndicatorVariantForHostStyle } from "@/components/chat-v2/shared/loading-indicator-content";
import { SandboxHostStyleProvider } from "@/contexts/sandbox-host-style-context";
import { SandboxHostOnboardingOverlays } from "@/components/hosted/SandboxHostOnboardingOverlays";
import { useSandboxHostIntroGate } from "@/components/hosted/useSandboxHostIntroGate";
import type { ServerWithName } from "@/hooks/use-app-state";
import { useHostedOAuthGate } from "@/hooks/hosted/use-hosted-oauth-gate";
import { useIsMobile } from "@/hooks/use-mobile";
import type { HostedOAuthRequiredDetails } from "@/lib/hosted-oauth-required";
import { isHostedOAuthBusy } from "@/lib/hosted-oauth-resume";
import { getStoredTokens } from "@/lib/oauth/mcp-oauth";
import {
  getSandboxHostLabel,
  getSandboxHostLogo,
  type SandboxHostStyle,
} from "@/lib/sandbox-host-style";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import {
  SANDBOX_OAUTH_PENDING_KEY,
  buildPlaygroundSandboxLink,
  sandboxPreviewEnabledOptionalStorageKey,
  type SandboxBootstrapPayload,
  type SandboxBootstrapServer,
  writePlaygroundSession,
} from "@/lib/sandbox-session";
import type { RemoteServer } from "@/hooks/useWorkspaces";
import { ServerSelectionEditor } from "./builder/setup-checklist-panel";
import {
  bootstrapServerToHostedOAuthDescriptor,
  countRequiredServers,
} from "./builder/sandbox-server-optional";

interface WorkspaceServerOption {
  _id: string;
  name: string;
  transportType: "stdio" | "http";
  url?: string;
  useOAuth?: boolean;
  oauthScopes?: string[];
  clientId?: string;
}

function isInsecureUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === "http:";
  } catch {
    return false;
  }
}

interface SandboxEditorProps {
  sandbox?: SandboxSettings | null;
  workspaceId: string;
  workspaceServers: WorkspaceServerOption[];
  onBack: () => void;
  onSaved?: (sandbox: SandboxSettings) => void;
  onDeleted?: () => void;
}

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";
const HOST_STYLE_OPTIONS: SandboxHostStyle[] = ["claude", "chatgpt"];

function createPlaygroundId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }

  return `playground-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function SandboxEditor({
  sandbox,
  workspaceId,
  workspaceServers,
  onBack,
  onSaved,
  onDeleted,
}: SandboxEditorProps) {
  const { createSandbox, updateSandbox, deleteSandbox, setSandboxMode } =
    useSandboxMutations();
  const { createServer } = useServerMutations();
  const isCreateMode = !sandbox;
  const isMobile = useIsMobile();

  const hostedModels = useMemo(
    () =>
      SUPPORTED_MODELS.filter((model) =>
        isMCPJamProvidedModel(String(model.id)),
      ),
    [],
  );

  const [name, setName] = useState(sandbox?.name ?? "");
  const [description, setDescription] = useState(sandbox?.description ?? "");
  const [hostStyle, setHostStyle] = useState<SandboxHostStyle>(
    sandbox?.hostStyle ?? "claude",
  );
  const [systemPrompt, setSystemPrompt] = useState(
    sandbox?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
  );
  const [modelId, setModelId] = useState(
    sandbox?.modelId ?? hostedModels[0]?.id?.toString() ?? "openai/gpt-5-mini",
  );
  const [temperature, setTemperature] = useState(sandbox?.temperature ?? 0.7);
  const [requireToolApproval, setRequireToolApproval] = useState(
    sandbox?.requireToolApproval ?? false,
  );
  const [allowGuestAccess, setAllowGuestAccess] = useState(
    sandbox?.allowGuestAccess ?? true,
  );
  const [mode, setMode] = useState<SandboxMode>(
    sandbox?.mode ?? "any_signed_in_with_link",
  );
  const [selectedServerIds, setSelectedServerIds] = useState<string[]>(
    sandbox?.servers.map((s) => s.serverId) ?? [],
  );
  const [optionalServerIds, setOptionalServerIds] = useState<string[]>(
    () =>
      sandbox?.servers.filter((s) => s.optional).map((s) => s.serverId) ?? [],
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(isCreateMode);
  const [isAddServerOpen, setIsAddServerOpen] = useState(false);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [isDeletingSandbox, setIsDeletingSandbox] = useState(false);
  const [previewChatKey, setPreviewChatKey] = useState(0);
  const [previewPlaygroundId, setPreviewPlaygroundId] = useState(() =>
    createPlaygroundId(),
  );
  const previewHasOpenedRef = useRef(false);
  const previewPendingRestartRef = useRef(false);
  const previewIsInitialFingerprintRef = useRef(true);

  const [previewEnabledOptionalIds, setPreviewEnabledOptionalIds] = useState<
    string[]
  >([]);

  // Reset form when the selected sandbox changes or the editor switches modes.
  useEffect(() => {
    if (!sandbox) {
      setName("");
      setDescription("");
      setHostStyle("claude");
      setSystemPrompt(DEFAULT_SYSTEM_PROMPT);
      setModelId(hostedModels[0]?.id?.toString() ?? "openai/gpt-5-mini");
      setTemperature(0.7);
      setRequireToolApproval(false);
      setAllowGuestAccess(true);
      setMode("any_signed_in_with_link");
      setSelectedServerIds([]);
      setOptionalServerIds([]);
      setPreviewEnabledOptionalIds([]);
      setIsEditingTitle(true);
      setIsPreviewOpen(false);
      setPreviewChatKey(0);
      setPreviewPlaygroundId(createPlaygroundId());
      previewHasOpenedRef.current = false;
      previewPendingRestartRef.current = false;
      previewIsInitialFingerprintRef.current = true;
      return;
    }

    setName(sandbox.name);
    setDescription(sandbox.description ?? "");
    setHostStyle(sandbox.hostStyle);
    setSystemPrompt(sandbox.systemPrompt);
    setModelId(sandbox.modelId);
    setTemperature(sandbox.temperature);
    setRequireToolApproval(sandbox.requireToolApproval);
    setAllowGuestAccess(sandbox.allowGuestAccess);
    setMode(sandbox.mode);
    setSelectedServerIds(sandbox.servers.map((s) => s.serverId));
    setOptionalServerIds(
      sandbox.servers.filter((s) => s.optional).map((s) => s.serverId),
    );
    setIsEditingTitle(false);
    setIsPreviewOpen(false);
    setPreviewChatKey(0);
    setPreviewPlaygroundId(createPlaygroundId());
    previewHasOpenedRef.current = false;
    previewPendingRestartRef.current = false;
    previewIsInitialFingerprintRef.current = true;
    setPreviewEnabledOptionalIds([]);
  }, [hostedModels, sandbox]);

  useEffect(() => {
    setDeleteDialogOpen(false);
  }, [sandbox?.sandboxId]);

  const optionalServerIdsKey = [...optionalServerIds].sort().join(",");

  useEffect(() => {
    if (!sandbox?.sandboxId) return;
    try {
      const raw = sessionStorage.getItem(
        sandboxPreviewEnabledOptionalStorageKey(sandbox.sandboxId),
      );
      if (!raw) {
        setPreviewEnabledOptionalIds((prev) => (prev.length === 0 ? prev : []));
        return;
      }
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      const optionalSet = new Set(optionalServerIds);
      const next = parsed.filter(
        (id): id is string => typeof id === "string" && optionalSet.has(id),
      );
      setPreviewEnabledOptionalIds((prev) => {
        if (
          prev.length === next.length &&
          prev.every((id, i) => id === next[i])
        ) {
          return prev;
        }
        return next;
      });
    } catch {
      setPreviewEnabledOptionalIds((prev) => (prev.length === 0 ? prev : []));
    }
  }, [sandbox?.sandboxId, optionalServerIdsKey]);

  useEffect(() => {
    if (!sandbox?.sandboxId) return;
    try {
      const storageKey = sandboxPreviewEnabledOptionalStorageKey(
        sandbox.sandboxId,
      );
      const serialized = JSON.stringify(previewEnabledOptionalIds);
      if (sessionStorage.getItem(storageKey) === serialized) return;
      sessionStorage.setItem(storageKey, serialized);
    } catch {
      // ignore
    }
  }, [sandbox?.sandboxId, previewEnabledOptionalIds]);

  const availableServers = useMemo(
    () => workspaceServers.filter((s) => s.transportType === "http"),
    [workspaceServers],
  );

  const previewToken = sandbox?.link?.token?.trim() || null;
  const canPreview = Boolean(previewToken);
  const previewName = name.trim() || sandbox?.name || "Sandbox Preview";
  const normalizedSystemPrompt = systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT;
  const behaviorFingerprint = useMemo(
    () =>
      JSON.stringify({
        selectedServerIds: [...selectedServerIds].sort(),
        systemPrompt: normalizedSystemPrompt,
        modelId,
        temperature,
        requireToolApproval,
      }),
    [
      modelId,
      normalizedSystemPrompt,
      requireToolApproval,
      selectedServerIds,
      temperature,
    ],
  );
  const selectedPreviewServers = useMemo(() => {
    const savedServersById = new Map(
      (sandbox?.servers ?? []).map((server) => [server.serverId, server]),
    );

    return selectedServerIds
      .map((serverId) => {
        const workspaceServer = availableServers.find(
          (server) => server._id === serverId,
        );
        if (workspaceServer) {
          return {
            serverId: workspaceServer._id,
            serverName: workspaceServer.name,
            useOAuth: Boolean(workspaceServer.useOAuth),
            serverUrl: workspaceServer.url ?? null,
            clientId: workspaceServer.clientId ?? null,
            oauthScopes: workspaceServer.oauthScopes ?? null,
            optional: optionalServerIds.includes(workspaceServer._id),
          } satisfies SandboxBootstrapServer;
        }

        const savedServer = savedServersById.get(serverId);
        if (!savedServer) {
          return {
            serverId,
            serverName: serverId,
            useOAuth: false,
            serverUrl: null,
            clientId: null,
            oauthScopes: null,
            optional: optionalServerIds.includes(serverId),
          } satisfies SandboxBootstrapServer;
        }

        return {
          serverId: savedServer.serverId,
          serverName: savedServer.serverName,
          useOAuth: savedServer.useOAuth,
          serverUrl: savedServer.serverUrl,
          clientId: savedServer.clientId,
          oauthScopes: savedServer.oauthScopes,
          optional: optionalServerIds.includes(savedServer.serverId),
        } satisfies SandboxBootstrapServer;
      })
      .filter((server) => !!server.serverId && !!server.serverName);
  }, [
    availableServers,
    optionalServerIds,
    sandbox?.servers,
    selectedServerIds,
  ]);

  const requiredPreviewServers = useMemo(
    () => selectedPreviewServers.filter((s) => !s.optional),
    [selectedPreviewServers],
  );

  const activePreviewServers = useMemo(() => {
    const enabled = new Set(previewEnabledOptionalIds);
    const optionalOn = selectedPreviewServers.filter(
      (s) => s.optional && enabled.has(s.serverId),
    );
    return [...requiredPreviewServers, ...optionalOn];
  }, [
    requiredPreviewServers,
    selectedPreviewServers,
    previewEnabledOptionalIds,
  ]);

  const previewServerConfigs = useMemo(() => {
    return Object.fromEntries(
      activePreviewServers.map((server) => [
        server.serverName,
        {
          name: server.serverName,
          config: {
            url: server.serverUrl ?? "https://sandbox-preview.invalid",
          } as any,
          lastConnectionTime: new Date(),
          connectionStatus: "connected",
          retryCount: 0,
          enabled: true,
        } satisfies ServerWithName,
      ]),
    );
  }, [activePreviewServers]);

  const previewOAuthGateServers = useMemo(
    () => activePreviewServers.map(bootstrapServerToHostedOAuthDescriptor),
    [activePreviewServers],
  );

  const {
    oauthStateByServerId,
    pendingOAuthServers,
    authorizeServer,
    markOAuthRequired,
    hasBusyOAuth,
  } = useHostedOAuthGate({
    surface: "sandbox",
    pendingKey: SANDBOX_OAUTH_PENDING_KEY,
    servers: previewOAuthGateServers,
  });
  const previewOAuthTokens = useMemo(() => {
    const entries = activePreviewServers
      .map((server) => {
        const token = getStoredTokens(server.serverName)?.access_token;
        return token ? ([server.serverId, token] as const) : null;
      })
      .filter((entry): entry is readonly [string, string] =>
        Array.isArray(entry),
      );

    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }, [oauthStateByServerId, activePreviewServers]);
  const isFinishingPreviewOAuth =
    pendingOAuthServers.length > 0 &&
    pendingOAuthServers.every(({ state }) => isHostedOAuthBusy(state.status));

  const oauthPending = pendingOAuthServers.length > 0;
  const introGate = useSandboxHostIntroGate({
    sandboxId: sandbox?.sandboxId ?? "",
    servers: requiredPreviewServers,
    oauthPending,
    hasBusyOAuth,
    pendingOAuthServers,
  });

  const hasUnsavedChanges = useMemo(() => {
    if (isCreateMode) return true;
    const currentServerIds = sandbox!.servers.map((s) => s.serverId).sort();
    const formServerIds = [...selectedServerIds].sort();
    const optionalFromSandbox = sandbox!.servers
      .filter((s) => s.optional)
      .map((s) => s.serverId)
      .sort();
    const formOptional = [...optionalServerIds].sort();
    return (
      name !== sandbox!.name ||
      description !== (sandbox!.description ?? "") ||
      hostStyle !== sandbox!.hostStyle ||
      systemPrompt !== sandbox!.systemPrompt ||
      modelId !== sandbox!.modelId ||
      temperature !== sandbox!.temperature ||
      requireToolApproval !== sandbox!.requireToolApproval ||
      allowGuestAccess !== sandbox!.allowGuestAccess ||
      JSON.stringify(formServerIds) !== JSON.stringify(currentServerIds) ||
      JSON.stringify(formOptional) !== JSON.stringify(optionalFromSandbox)
    );
  }, [
    isCreateMode,
    name,
    description,
    hostStyle,
    systemPrompt,
    modelId,
    temperature,
    requireToolApproval,
    allowGuestAccess,
    selectedServerIds,
    optionalServerIds,
    sandbox,
  ]);

  const handleServerOptionalChange = (serverId: string, optional: boolean) => {
    const requiredIds = selectedServerIds.filter(
      (id) => !optionalServerIds.includes(id),
    );
    if (optional && requiredIds.length === 1 && requiredIds[0] === serverId) {
      toast.error(
        "Add another required server or mark another as required first.",
      );
      return;
    }
    setOptionalServerIds((current) =>
      optional
        ? [...new Set([...current, serverId])]
        : current.filter((id) => id !== serverId),
    );
  };

  const handleToggleServer = (serverId: string, checked: boolean) => {
    setSelectedServerIds((current) => {
      if (checked) {
        return current.includes(serverId) ? current : [...current, serverId];
      }
      return current.filter((id) => id !== serverId);
    });
    if (!checked) {
      setOptionalServerIds((current) =>
        current.filter((id) => id !== serverId),
      );
    }
  };

  const saveServerToWorkspace = async (formData: ServerFormData) => {
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
    return serverId;
  };

  const handleAddServer = async (formData: ServerFormData) => {
    if (formData.type !== "http") {
      toast.error("Only HTTP servers can be used in sandboxes");
      return;
    }
    if (isInsecureUrl(formData.url)) {
      toast.error("Only HTTPS servers can be used in sandboxes");
      return;
    }
    try {
      const serverId = await saveServerToWorkspace(formData);
      setSelectedServerIds((current) => [...current, serverId]);
      toast.success(`Server "${formData.name}" added`);
      setIsAddServerOpen(false);
    } catch (error) {
      toast.error(getBillingErrorMessage(error, "Failed to add server"));
    }
  };

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error("Sandbox name is required");
      return;
    }
    if (selectedServerIds.length === 0) {
      toast.error("Select at least one HTTPS server");
      return;
    }
    if (countRequiredServers(selectedServerIds, optionalServerIds) < 1) {
      toast.error("At least one server must be required (on by default)");
      return;
    }
    const hasInsecure = selectedServerIds.some((id) => {
      const server = availableServers.find((s) => s._id === id);
      return server && isInsecureUrl(server.url);
    });
    if (hasInsecure) {
      toast.error("Only HTTPS servers can be used in sandboxes");
      return;
    }

    setIsSaving(true);
    try {
      const payload = {
        name: trimmedName,
        description: description.trim() || undefined,
        hostStyle,
        systemPrompt: systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT,
        modelId,
        temperature,
        requireToolApproval,
        allowGuestAccess,
        serverIds: selectedServerIds,
        optionalServerIds,
      };

      let result;
      if (isCreateMode) {
        result = await createSandbox({ workspaceId, ...payload });
        // Backend defaults to 'invited_only', so set mode if different
        if (mode !== "invited_only") {
          result = await setSandboxMode({
            sandboxId: (result as SandboxSettings).sandboxId,
            mode,
          });
        }
      } else {
        result = await updateSandbox({
          sandboxId: sandbox!.sandboxId,
          ...payload,
        });
      }

      toast.success(isCreateMode ? "Sandbox created" : "Sandbox updated");
      onSaved?.(result as SandboxSettings);
    } catch (error) {
      toast.error(getBillingErrorMessage(error, "Failed to save sandbox"));
    } finally {
      setIsSaving(false);
    }
  };

  const performSandboxDelete = useCallback(async () => {
    if (!sandbox) return;
    setIsDeletingSandbox(true);
    try {
      await deleteSandbox({ sandboxId: sandbox.sandboxId });
      toast.success("Sandbox deleted");
      onDeleted?.();
    } catch (error) {
      toast.error(getBillingErrorMessage(error, "Failed to delete sandbox"));
      throw error;
    } finally {
      setIsDeletingSandbox(false);
    }
  }, [sandbox, deleteSandbox, onDeleted]);

  const handleTitleBlur = () => {
    setIsEditingTitle(false);
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      setIsEditingTitle(false);
    }
    if (e.key === "Escape") {
      if (sandbox) setName(sandbox.name);
      setIsEditingTitle(false);
    }
  };

  const restartPreview = useCallback(() => {
    setPreviewPlaygroundId(createPlaygroundId());
    setPreviewChatKey((current) => current + 1);
  }, []);

  useEffect(() => {
    if (!sandbox || !previewToken) {
      return;
    }

    const payload: SandboxBootstrapPayload = {
      workspaceId: sandbox.workspaceId,
      sandboxId: sandbox.sandboxId,
      name: previewName,
      description: description.trim() || undefined,
      hostStyle,
      mode,
      allowGuestAccess,
      viewerIsWorkspaceMember: true,
      systemPrompt: normalizedSystemPrompt,
      modelId,
      temperature,
      requireToolApproval,
      servers: selectedPreviewServers,
      welcomeDialog: sandbox.welcomeDialog ?? {
        enabled: true,
        body: "",
      },
    };

    writePlaygroundSession({
      token: previewToken,
      payload,
      surface: "preview",
      playgroundId: previewPlaygroundId,
      updatedAt: Date.now(),
    });
  }, [
    allowGuestAccess,
    description,
    hostStyle,
    mode,
    modelId,
    normalizedSystemPrompt,
    previewName,
    previewPlaygroundId,
    previewToken,
    requireToolApproval,
    sandbox,
    selectedPreviewServers,
    temperature,
  ]);

  useEffect(() => {
    if (previewIsInitialFingerprintRef.current) {
      previewIsInitialFingerprintRef.current = false;
      return;
    }

    if (!canPreview) {
      return;
    }

    if (!isPreviewOpen) {
      if (previewHasOpenedRef.current) {
        previewPendingRestartRef.current = true;
      }
      return;
    }

    const timer = window.setTimeout(() => {
      restartPreview();
    }, 400);

    return () => {
      window.clearTimeout(timer);
    };
  }, [behaviorFingerprint, canPreview, restartPreview]);

  useEffect(() => {
    if (!isPreviewOpen || !canPreview || !previewPendingRestartRef.current) {
      return;
    }

    previewPendingRestartRef.current = false;
    restartPreview();
  }, [canPreview, isPreviewOpen, restartPreview]);

  const handleOpenPreview = useCallback(() => {
    if (!previewToken) {
      return;
    }

    previewHasOpenedRef.current = true;
    setIsPreviewOpen(true);
  }, [previewToken]);

  const handleOpenFullPreview = useCallback(() => {
    if (!previewToken) {
      toast.error("Save the sandbox first to preview");
      return;
    }

    window.open(
      buildPlaygroundSandboxLink(
        previewToken,
        previewName,
        previewPlaygroundId,
      ),
      "_blank",
      "noopener,noreferrer",
    );
  }, [previewName, previewPlaygroundId, previewToken]);

  const handlePreviewOAuthRequired = useCallback(
    (details?: HostedOAuthRequiredDetails) => {
      markOAuthRequired(details);
    },
    [markOAuthRequired],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Sticky header */}
      <div className="flex items-start justify-between gap-4 border-b px-5 py-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Button
            variant="ghost"
            size="sm"
            className="mt-0.5 h-7 w-7 shrink-0 p-0"
            onClick={onBack}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            {isEditingTitle ? (
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={handleTitleBlur}
                onKeyDown={handleTitleKeyDown}
                autoFocus
                placeholder="Sandbox name"
                className="w-full border-none bg-transparent px-0 py-0 text-lg font-semibold placeholder:text-muted-foreground/50 focus:outline-none focus:ring-0"
              />
            ) : (
              <h2
                className="cursor-pointer truncate text-lg font-semibold transition-opacity hover:opacity-60"
                onClick={() => setIsEditingTitle(true)}
              >
                {name || "Untitled sandbox"}
              </h2>
            )}
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add a description…"
              className="mt-1 w-full border-none bg-transparent px-0 py-0 text-sm text-muted-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-0"
            />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleOpenPreview}
            disabled={!canPreview}
            className="h-9 px-4 text-xs font-medium"
          >
            Preview
          </Button>
          {hasUnsavedChanges && (
            <Button
              size="sm"
              onClick={() => void handleSave()}
              disabled={isSaving}
              className="h-9 px-4 text-xs font-medium"
            >
              {isSaving ? (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="mr-1.5 h-3.5 w-3.5" />
              )}
              {isCreateMode ? "Create" : "Save"}
            </Button>
          )}
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        <div className="px-1 pt-2">
          <Label className="text-xs font-medium text-muted-foreground">
            Host style
          </Label>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
            {HOST_STYLE_OPTIONS.map((option) => {
              const isSelected = hostStyle === option;
              return (
                <Button
                  key={option}
                  type="button"
                  variant={isSelected ? "secondary" : "ghost"}
                  className="h-auto justify-start gap-3 rounded-xl border border-border/50 px-3 py-3"
                  onClick={() => setHostStyle(option)}
                >
                  <img
                    src={getSandboxHostLogo(option)}
                    alt={getSandboxHostLabel(option)}
                    className="h-5 w-5 object-contain"
                  />
                  <div className="flex min-w-0 flex-col items-start">
                    <span className="text-sm font-medium">
                      {getSandboxHostLabel(option)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {option === "chatgpt"
                        ? "OpenAI-style sandbox chrome"
                        : "Claude-style sandbox chrome"}
                    </span>
                  </div>
                </Button>
              );
            })}
          </div>
        </div>

        {/* Model + Servers side by side */}
        <div className="grid gap-4 px-1 pt-2 md:grid-cols-2">
          <div>
            <Label className="text-xs font-medium text-muted-foreground">
              Model
            </Label>
            <Select value={modelId} onValueChange={setModelId}>
              <SelectTrigger className="mt-1.5 border-0 bg-muted/50 transition-colors hover:bg-muted">
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {hostedModels.map((model) => (
                  <SelectItem key={String(model.id)} value={String(model.id)}>
                    {model.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <ServerSelectionEditor
              workspaceServers={workspaceServers as RemoteServer[]}
              selectedServerIds={selectedServerIds}
              optionalServerIds={optionalServerIds}
              onToggleSelection={handleToggleServer}
              onOptionalChange={handleServerOptionalChange}
              onOpenAdd={() => setIsAddServerOpen(true)}
            />
          </div>
        </div>

        {/* Advanced config (collapsible) */}
        <div className="px-1 pt-3">
          <Collapsible open={isAdvancedOpen} onOpenChange={setIsAdvancedOpen}>
            <CollapsibleTrigger className="flex w-full items-center gap-1.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors">
              {isAdvancedOpen ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
              Advanced config
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-1 pt-2">
              {/* System prompt */}
              <div>
                <Label className="text-xs font-medium text-muted-foreground">
                  System prompt
                </Label>
                <p className="mb-1.5 text-[10px] text-muted-foreground">
                  Instructions given to the model at the start of each
                  conversation.
                </p>
                <Textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  rows={6}
                  className="resize-none border-0 bg-muted/30 px-3 py-2 text-sm transition-colors focus-visible:bg-muted/50"
                />
              </div>

              {/* Temperature */}
              <div className="pt-3">
                <div className="flex items-center justify-between">
                  <Label className="text-xs font-medium text-muted-foreground">
                    Temperature
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    {temperature.toFixed(2)}
                  </span>
                </div>
                <Slider
                  min={0}
                  max={2}
                  step={0.05}
                  value={[temperature]}
                  onValueChange={(values) => setTemperature(values[0] ?? 0.7)}
                  className="mt-3"
                />
              </div>

              {/* Settings */}
              <div className="pt-3">
                <Label className="text-xs font-medium text-muted-foreground">
                  Settings
                </Label>
                <div className="mt-1.5 space-y-1 rounded-md bg-muted/30 p-3">
                  <div className="flex items-center justify-between gap-3 rounded-md px-1 py-1.5">
                    <div>
                      <p className="text-sm">Require tool approval</p>
                      <p className="text-[10px] text-muted-foreground">
                        Visitors must approve tool calls before execution.
                      </p>
                    </div>
                    <Switch
                      checked={requireToolApproval}
                      onCheckedChange={setRequireToolApproval}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3 rounded-md px-1 py-1.5">
                    <div>
                      <p className="text-sm">Allow guest access</p>
                      <p className="text-[10px] text-muted-foreground">
                        Unauthenticated visitors can use the sandbox link.
                      </p>
                    </div>
                    <Switch
                      checked={allowGuestAccess}
                      onCheckedChange={setAllowGuestAccess}
                    />
                  </div>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </div>

        {/* Inline share section - only in edit mode */}
        {!isCreateMode && sandbox && (
          <div className="px-1 pt-3 pb-4">
            <Separator className="mb-4" />
            <Label className="text-xs font-medium text-muted-foreground">
              Sharing
            </Label>
            <SandboxShareSection sandbox={sandbox} onUpdated={onSaved} />
          </div>
        )}

        {/* Access mode picker - create mode only */}
        {isCreateMode && (
          <div className="px-1 pt-3 pb-4">
            <Separator className="mb-4" />
            <p className="text-sm font-medium">General access</p>
            <div className="mt-2 flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted">
                {mode === "any_signed_in_with_link" ? (
                  <Globe className="size-4 text-muted-foreground" />
                ) : (
                  <Lock className="size-4 text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded-md px-1 py-0.5 text-sm font-medium hover:bg-muted/50 transition-colors"
                    >
                      {mode === "any_signed_in_with_link"
                        ? "Anyone with the link"
                        : "Invited users only"}
                      <ChevronDown className="size-3.5 text-muted-foreground" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-56 p-1" align="start">
                    <button
                      type="button"
                      className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
                      onClick={() => setMode("any_signed_in_with_link")}
                    >
                      <span>Anyone with the link</span>
                      {mode === "any_signed_in_with_link" && (
                        <Check className="size-3.5 text-muted-foreground" />
                      )}
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-muted/50"
                      onClick={() => setMode("invited_only")}
                    >
                      <span>Invited users only</span>
                      {mode === "invited_only" && (
                        <Check className="size-3.5 text-muted-foreground" />
                      )}
                    </button>
                  </PopoverContent>
                </Popover>
                <p className="mt-0.5 px-1 text-xs text-muted-foreground">
                  {mode === "any_signed_in_with_link"
                    ? "Any signed-in user with the link can open this sandbox."
                    : "Only people you've invited can access this sandbox."}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Delete - only in edit mode, pinned to bottom */}
        {!isCreateMode && (
          <div className="px-1 pb-4 pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs text-destructive hover:text-destructive"
              onClick={() => setDeleteDialogOpen(true)}
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </Button>
          </div>
        )}
      </div>

      {sandbox ? (
        <SandboxDeleteConfirmDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          sandboxName={sandbox.name}
          isDeleting={isDeletingSandbox}
          onConfirm={performSandboxDelete}
        />
      ) : null}

      <AddServerModal
        isOpen={isAddServerOpen}
        onClose={() => setIsAddServerOpen(false)}
        onSubmit={(formData) => void handleAddServer(formData)}
        initialData={{ type: "http" }}
        requireHttps
      />

      <Sheet open={isPreviewOpen} onOpenChange={setIsPreviewOpen}>
        <SheetContent
          side={isMobile ? "bottom" : "right"}
          className={
            isMobile
              ? "h-full w-full max-w-none border-0 p-0 sm:max-w-none"
              : "w-full border-l p-0 sm:max-w-none lg:w-[min(820px,100vw)]"
          }
        >
          <SheetHeader className="border-b px-5 py-4 pr-14">
            <div className="flex items-start justify-between gap-3">
              <div>
                <SheetTitle>Preview</SheetTitle>
                <SheetDescription>
                  Preview the saved sandbox with your draft config.
                </SheetDescription>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={restartPreview}
                  disabled={!canPreview}
                >
                  Reload
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleOpenFullPreview}
                  disabled={!canPreview}
                >
                  <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                  Open full preview
                </Button>
              </div>
            </div>
          </SheetHeader>

          <div className="flex min-h-0 flex-1 flex-col bg-muted/20">
            {!sandbox || !previewToken ? (
              <div className="flex flex-1 items-center justify-center p-6">
                <div className="max-w-sm rounded-2xl border border-dashed bg-background p-6 text-center">
                  <h3 className="text-base font-semibold">
                    Preview unavailable
                  </h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Save the sandbox to generate a preview link.
                  </p>
                </div>
              </div>
            ) : (
              <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                <SandboxHostStyleProvider value={hostStyle}>
                  <div
                    className="flex min-h-0 flex-1 overflow-hidden"
                    data-host-style={hostStyle}
                  >
                    <ChatTabV2
                      key={previewChatKey}
                      connectedOrConnectingServerConfigs={previewServerConfigs}
                      selectedServerNames={activePreviewServers.map(
                        (server) => server.serverName,
                      )}
                      minimalMode
                      reasoningDisplayMode="hidden"
                      hostedWorkspaceIdOverride={sandbox.workspaceId}
                      hostedSelectedServerIdsOverride={activePreviewServers.map(
                        (server) => server.serverId,
                      )}
                      hostedOAuthTokensOverride={previewOAuthTokens}
                      hostedSandboxToken={previewToken}
                      hostedSandboxSurface="preview"
                      initialModelId={modelId}
                      initialSystemPrompt={normalizedSystemPrompt}
                      initialTemperature={temperature}
                      initialRequireToolApproval={requireToolApproval}
                      loadingIndicatorVariant={getLoadingIndicatorVariantForHostStyle(
                        hostStyle,
                      )}
                      onOAuthRequired={handlePreviewOAuthRequired}
                      sandboxComposerBlocked={introGate.composerBlocked}
                      sandboxComposerBlockedReason="Get started or authorize to send messages…"
                      sandboxOptionalInventory={selectedPreviewServers
                        .filter(
                          (s) =>
                            s.optional &&
                            !previewEnabledOptionalIds.includes(s.serverId),
                        )
                        .map((s) => ({
                          serverId: s.serverId,
                          serverName: s.serverName,
                          useOAuth: s.useOAuth,
                        }))}
                      onEnableSandboxOptionalServer={(id) => {
                        setPreviewEnabledOptionalIds((prev) =>
                          prev.includes(id) ? prev : [...prev, id],
                        );
                      }}
                    />
                  </div>
                </SandboxHostStyleProvider>
                <SandboxHostOnboardingOverlays
                  showWelcome={introGate.showWelcome}
                  onGetStarted={introGate.dismissIntro}
                  welcomeBody={
                    (sandbox.welcomeDialog?.enabled ?? true)
                      ? sandbox.welcomeDialog?.body
                      : undefined
                  }
                  showAuthPanel={introGate.showAuthPanel}
                  pendingOAuthServers={pendingOAuthServers}
                  authorizeServer={authorizeServer}
                  isFinishingOAuth={isFinishingPreviewOAuth}
                />
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
