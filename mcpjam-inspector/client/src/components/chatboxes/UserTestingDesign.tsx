import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronDown, ExternalLink, Loader2 } from "lucide-react";
import { useConvexAuth } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@mcpjam/design-system/dropdown-menu";
import { SegmentedControl } from "@/components/ui/json-editor/segmented-control";
import { ChatboxPreviewPane } from "@/components/chatboxes/ChatboxPreviewPane";
import { ChatboxHostCanvasPanel } from "@/components/chatboxes/ChatboxHostCanvasPanel";
import { ChatboxShareSection } from "@/components/chatboxes/ChatboxShareSection";
import {
  useChatboxByHostId,
  useChatboxMutations,
  type ChatboxSettings,
} from "@/hooks/useChatboxes";
import { useHost, useHostMutations } from "@/hooks/useClients";
import { useProjectServers } from "@/hooks/useViews";
import { useClaudeCodeHostEnabled } from "@/hooks/useClaudeCodeHostEnabled";
import { useCodexHostEnabled } from "@/hooks/useCodexHostEnabled";
import { cloneHostTemplateInput } from "@/lib/client-config-v2";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import { filterHostsByFeatureFlags } from "@/lib/host-compat/feature-visibility";
import {
  getCatalogHost,
  getCatalogHosts,
  getCatalogTemplate,
} from "@mcpjam/sdk/host-compat";
import {
  DEFAULT_CATALOG_HOST_ID,
  getHostLogoSrc,
} from "@/lib/host-ui-metadata";
import {
  chatboxAccessPresetFromSettings,
  settingsFromChatboxAccessPreset,
  type ChatboxAccessPreset,
} from "@/lib/chatbox-access-presets";
import { buildChatboxLink } from "@/lib/chatbox-session";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  USER_TESTING_DEMO_SERVERS,
  buildUserTestingDemoChatbox,
} from "@/components/chatboxes/user-testing-demo";

type PanelView = "preview" | "graph";

const PANEL_OPTIONS: Array<{ value: PanelView; label: string }> = [
  { value: "preview", label: "Preview" },
  { value: "graph", label: "Client graph" },
];

const FALLBACK_CLIENTS = [
  { id: "cursor", label: "Cursor" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "claude", label: "Claude" },
  { id: "vscode", label: "VS Code" },
] as const;

interface UserTestingDesignProps {
  projectId: string | null;
  isAuthenticated: boolean;
  onBack: () => void;
  onSaved: (hostId: string) => void;
}

export function UserTestingDesign({
  projectId,
  isAuthenticated,
  onBack,
  onSaved,
}: UserTestingDesignProps) {
  const { isAuthenticated: convexAuth } = useConvexAuth();
  const effectiveAuth = isAuthenticated && convexAuth;
  const canPersist = Boolean(projectId && effectiveAuth);
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const { createHost, updateHost, updateHostServers } = useHostMutations();
  const { updateChatbox, setChatboxMode } = useChatboxMutations();
  const { servers: liveServers } = useProjectServers({
    isAuthenticated: effectiveAuth,
    projectId,
  });
  const servers = canPersist
    ? liveServers
    : USER_TESTING_DEMO_SERVERS.map((s) => ({
        _id: s._id,
        name: s.name,
      }));
  const catalogState = useHostCatalog();
  const claudeCodeEnabled = useClaudeCodeHostEnabled();
  const codexEnabled = useCodexHostEnabled();

  const visibleCatalogHosts = useMemo(() => {
    if (catalogState.status === "live") {
      return filterHostsByFeatureFlags(getCatalogHosts(catalogState.catalog), {
        claudeCode: claudeCodeEnabled,
        codex: codexEnabled,
      }).sort((a, b) => a.label.localeCompare(b.label));
    }
    return FALLBACK_CLIENTS.map((c) => ({ id: c.id, label: c.label }));
  }, [catalogState, claudeCodeEnabled, codexEnabled]);
  const defaultHostId =
    visibleCatalogHosts.find((h) => h.id === DEFAULT_CATALOG_HOST_ID)?.id ??
    visibleCatalogHosts[0]?.id ??
    DEFAULT_CATALOG_HOST_ID;

  const [name, setName] = useState("Public beta · payments API");
  const [selectedTemplateId, setSelectedTemplateId] = useState(defaultHostId);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(
    USER_TESTING_DEMO_SERVERS[0]!._id,
  );
  const [accessPreset, setAccessPreset] =
    useState<ChatboxAccessPreset>("invited_only");
  const [hostId, setHostId] = useState<string | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [panelView, setPanelView] = useState<PanelView>("preview");
  const [shareSettings, setShareSettings] = useState<ChatboxSettings | null>(
    () => buildUserTestingDemoChatbox("demo-host-1"),
  );
  const bootstrapStartedRef = useRef(false);

  const { host } = useHost({
    isAuthenticated: effectiveAuth && canPersist,
    hostId: canPersist ? hostId : null,
  });
  const { chatbox, isLoading: chatboxLoading } = useChatboxByHostId({
    isAuthenticated: effectiveAuth && canPersist,
    hostId: canPersist ? hostId : null,
  });

  useEffect(() => {
    if (visibleCatalogHosts.length === 0) return;
    if (!visibleCatalogHosts.some((h) => h.id === selectedTemplateId)) {
      setSelectedTemplateId(defaultHostId);
    }
  }, [visibleCatalogHosts, selectedTemplateId, defaultHostId]);

  useEffect(() => {
    if (selectedServerId) return;
    if (servers && servers.length > 0) {
      setSelectedServerId(servers[0]!._id);
    }
  }, [servers, selectedServerId]);

  // Mint a draft host once so the live preview URL works while designing.
  useEffect(() => {
    if (!canPersist || !projectId) return;
    if (bootstrapStartedRef.current) return;
    if (catalogState.status !== "live") return;
    const template = getCatalogTemplate(catalogState.catalog, selectedTemplateId);
    if (!template) return;
    bootstrapStartedRef.current = true;
    setIsBootstrapping(true);
    const label =
      getCatalogHost(catalogState.catalog, selectedTemplateId)?.label ??
      "New prototype";
    const seed = cloneHostTemplateInput(template, { themeMode });
    void createHost({
      projectId,
      name: `${label} prototype`,
      input: { ...seed, serverIds: [] },
    })
      .then(({ hostId: createdId }) => {
        setHostId(createdId);
        setName(`${label} prototype`);
      })
      .catch((err: unknown) => {
        bootstrapStartedRef.current = false;
        toast.error(
          err instanceof Error ? err.message : "Failed to start a new prototype",
        );
      })
      .finally(() => setIsBootstrapping(false));
  }, [
    canPersist,
    projectId,
    catalogState,
    selectedTemplateId,
    themeMode,
    createHost,
  ]);

  // Keep access preset in sync once chatbox exists.
  useEffect(() => {
    if (!chatbox) return;
    setShareSettings(chatbox);
    setAccessPreset(
      chatboxAccessPresetFromSettings(chatbox.mode, chatbox.allowGuestAccess),
    );
  }, [chatbox]);

  const publishLink = useMemo(() => {
    if (!chatbox?.link?.token) return null;
    return buildChatboxLink(chatbox.link.token, chatbox.name);
  }, [chatbox]);

  const applyServerSelection = useCallback(
    async (nextServerId: string | null) => {
      if (!canPersist || !hostId) return;
      const ids = nextServerId ? [nextServerId] : [];
      await updateHostServers({ hostId, serverIds: ids });
    },
    [canPersist, hostId, updateHostServers],
  );

  const applyClientTemplate = useCallback(
    async (templateId: string) => {
      if (!canPersist || !hostId || catalogState.status !== "live") return;
      const template = getCatalogTemplate(catalogState.catalog, templateId);
      if (!template) return;
      const seed = cloneHostTemplateInput(template, { themeMode });
      const serverIds = selectedServerId ? [selectedServerId] : [];
      await updateHost({
        hostId,
        input: { ...seed, serverIds },
      });
    },
    [
      canPersist,
      hostId,
      catalogState,
      themeMode,
      selectedServerId,
      updateHost,
    ],
  );

  const handleClientChange = async (templateId: string) => {
    setSelectedTemplateId(templateId);
    const label =
      catalogState.status === "live"
        ? getCatalogHost(catalogState.catalog, templateId)?.label
        : FALLBACK_CLIENTS.find((c) => c.id === templateId)?.label;
    if (label && (!name.trim() || name.endsWith(" prototype") || name.endsWith(" test"))) {
      setName(`${label} prototype`);
    }
    if (!canPersist) return;
    try {
      await applyClientTemplate(templateId);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to update client",
      );
    }
  };

  const handleServerChange = async (serverId: string) => {
    setSelectedServerId(serverId);
    if (!canPersist) return;
    try {
      await applyServerSelection(serverId);
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to update server",
      );
    }
  };

  const handleShareUpdated = (next: ChatboxSettings) => {
    setShareSettings(next);
    setAccessPreset(
      chatboxAccessPresetFromSettings(next.mode, next.allowGuestAccess),
    );
  };

  const handleSave = async () => {
    if (!canPersist) {
      toast.success("Design preview saved locally — open a synced project to publish");
      onSaved("demo-host-1");
      return;
    }
    if (!hostId || !chatbox) return;
    const trimmed = name.trim() || chatbox.name;
    setIsSaving(true);
    try {
      if (trimmed !== host?.name) {
        await updateHost({ hostId, name: trimmed });
      }
      if (trimmed !== chatbox.name) {
        await updateChatbox({
          chatboxId: chatbox.chatboxId,
          name: trimmed,
        });
      }
      if (selectedServerId) {
        await applyServerSelection(selectedServerId);
      }
      const target = settingsFromChatboxAccessPreset(accessPreset);
      if (target.mode !== chatbox.mode) {
        await setChatboxMode({
          chatboxId: chatbox.chatboxId,
          mode: target.mode,
        });
      }
      toast.success("Prototype saved");
      onSaved(hostId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save prototype");
    } finally {
      setIsSaving(false);
    }
  };

  const selectedServer = servers?.find((s) => s._id === selectedServerId);
  const selectedClientLabel =
    visibleCatalogHosts.find((h) => h.id === selectedTemplateId)?.label ??
    (selectedTemplateId
      ? FALLBACK_CLIENTS.find((c) => c.id === selectedTemplateId)?.label
      : undefined);
  const shareChatbox = chatbox ?? shareSettings;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border/40 px-6 py-4 sm:px-8">
        <button
          type="button"
          onClick={onBack}
          className={cn(
            "inline-flex items-center gap-1 text-sm font-medium text-primary",
            "hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm",
          )}
        >
          <ArrowLeft className="size-3.5" />
          User Testing
        </button>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <h1 className="truncate text-xl font-semibold tracking-tight">
            Prototype design
          </h1>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={!publishLink}
              onClick={() =>
                publishLink && window.open(publishLink, "_blank", "noopener")
              }
            >
              <ExternalLink className="mr-1.5 size-4" />
              Open preview
            </Button>
            <Button
              size="sm"
              disabled={
                canPersist
                  ? !hostId || !chatbox || isSaving || isBootstrapping
                  : isSaving
              }
              onClick={() => void handleSave()}
            >
              {isSaving ? (
                <Loader2 className="mr-1.5 size-4 animate-spin" />
              ) : null}
              Save prototype
            </Button>
          </div>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(280px,400px)_1fr]">
        <div className="min-h-0 overflow-y-auto border-b border-border/40 px-6 py-5 lg:border-b-0 lg:border-r">
          <div className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="prototype-name">Prototype name</Label>
              <Input
                id="prototype-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Public beta · payments API"
              />
            </div>

            <div className="space-y-2">
              <Label>Server for prototype</Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    <span className="flex-1 truncate text-left">
                      {selectedServer
                        ? selectedServer.name || selectedServer._id
                        : servers === undefined
                          ? "Loading servers…"
                          : "Select a server"}
                    </span>
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="w-[--radix-dropdown-menu-trigger-width]"
                >
                  <DropdownMenuRadioGroup
                    value={selectedServerId ?? ""}
                    onValueChange={(v) => void handleServerChange(v)}
                  >
                    {(servers ?? []).map((s) => (
                      <DropdownMenuRadioItem key={s._id} value={s._id}>
                        {s.name || s._id}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
              {servers && servers.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Connect a server in Connect before creating a prototype.
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label>Client the user will see</Label>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    {selectedTemplateId ? (
                      <img
                        src={getHostLogoSrc(selectedTemplateId, themeMode)}
                        alt=""
                        className="size-4 shrink-0 object-contain"
                      />
                    ) : null}
                    <span className="flex-1 truncate text-left">
                      {selectedClientLabel ?? "Select a client"}
                    </span>
                    <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  align="start"
                  className="w-[--radix-dropdown-menu-trigger-width]"
                >
                  <DropdownMenuRadioGroup
                    value={selectedTemplateId ?? ""}
                    onValueChange={(v) => void handleClientChange(v)}
                  >
                    {visibleCatalogHosts.map((catalogHost) => (
                      <DropdownMenuRadioItem
                        key={catalogHost.id}
                        value={catalogHost.id}
                        className="gap-2"
                      >
                        <img
                          src={getHostLogoSrc(catalogHost.id, themeMode)}
                          alt=""
                          className="size-4 object-contain"
                        />
                        {catalogHost.label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>

            {shareChatbox ? (
              <ChatboxShareSection
                chatbox={shareChatbox}
                previewMode={!canPersist || !chatbox}
                showMembersList={false}
                onUpdated={handleShareUpdated}
              />
            ) : null}
            {!canPersist ? (
              <p className="text-xs text-muted-foreground">
                Layout preview — select a synced project to publish a live
                prototype.
              </p>
            ) : null}
          </div>
        </div>

        <div className="flex min-h-0 flex-col">
          <div className="flex shrink-0 items-center justify-end border-b border-border/40 px-3 py-1.5">
            <SegmentedControl
              size="sm"
              value={panelView}
              onChange={setPanelView}
              options={PANEL_OPTIONS}
            />
          </div>
          <div className="relative min-h-0 flex-1">
            {canPersist && (isBootstrapping || (hostId && chatboxLoading)) ? (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                <Loader2 className="mr-2 size-4 animate-spin" />
                <span className="text-sm">Preparing preview…</span>
              </div>
            ) : (
              <>
                <div
                  className={cn(
                    "absolute inset-0",
                    panelView === "preview" ? "" : "hidden",
                  )}
                >
                  <ChatboxPreviewPane
                    publishLink={publishLink}
                    mcpProfile={host?.config.mcpProfile}
                    emptyTitle={
                      canPersist ? "No share link yet" : "Prototype preview"
                    }
                    emptyBody={
                      canPersist
                        ? "Save the prototype to generate a share link, then come back here to preview it."
                        : "Client chrome and suggested prompts will appear here once a live share link exists. Use the left panel to set server, client, and access."
                    }
                  />
                </div>
                {panelView === "graph" && canPersist && hostId && projectId ? (
                  <div className="absolute inset-0">
                    <ChatboxHostCanvasPanel
                      hostId={hostId}
                      projectId={projectId}
                      isAuthenticated={effectiveAuth}
                    />
                  </div>
                ) : panelView === "graph" && !canPersist ? (
                  <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
                    Client graph needs a live host — open a synced project to
                    preview it.
                  </div>
                ) : null}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
