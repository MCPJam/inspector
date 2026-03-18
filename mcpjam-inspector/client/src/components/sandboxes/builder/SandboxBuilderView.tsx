import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  ChevronsUpDown,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  MessageSquareText,
  Plus,
  Save,
  Settings,
  Share2,
  X,
} from "lucide-react";
import { ReactFlowProvider } from "@xyflow/react";
import { useConvexAuth } from "convex/react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AddServerModal } from "@/components/connection/AddServerModal";

import { SandboxShareSection } from "@/components/sandboxes/SandboxShareSection";
import { SandboxUsagePanel } from "@/components/sandboxes/SandboxUsagePanel";
import {
  useSandbox,
  useSandboxMutations,
  type SandboxSettings,
} from "@/hooks/useSandboxes";
import { useIsMobile } from "@/hooks/use-mobile";
import { useServerMutations, type RemoteServer } from "@/hooks/useWorkspaces";
import { copyToClipboard } from "@/lib/clipboard";
import {
  getSandboxHostLabel,
  getSandboxHostLogo,
  type SandboxHostStyle,
} from "@/lib/sandbox-host-style";
import { ChatTabV2 } from "@/components/ChatTabV2";
import type { ServerWithName } from "@/hooks/use-app-state";
import {
  buildPlaygroundSandboxLink,
  buildSandboxLink,
  writePlaygroundSession,
  type SandboxBootstrapPayload,
  type SandboxBootstrapServer,
} from "@/lib/sandbox-session";
import { SandboxHostStyleProvider } from "@/contexts/sandbox-host-style-context";
import {
  isMCPJamProvidedModel,
  SUPPORTED_MODELS,
  type ServerFormData,
} from "@/shared/types";
import { buildSandboxCanvas } from "./sandboxCanvasBuilder";
import { SandboxCanvas } from "./SandboxCanvas";
import { DEFAULT_SYSTEM_PROMPT, toDraftConfig } from "./drafts";
import type { SandboxBuilderContext, SandboxDraftConfig } from "./types";
import "./sandbox-builder.css";

interface SandboxBuilderViewProps {
  workspaceId: string;
  workspaceName?: string | null;
  workspaceServers: RemoteServer[];
  sandboxId?: string | null;
  draft: SandboxDraftConfig | null;
  onBack: () => void;
  onSavedDraft: (sandbox: SandboxSettings) => void;
}

type SettingsTab = "general" | "hostContext" | "servers" | "share";

const DESKTOP_SETTINGS_PANE_DEFAULT_PERCENT = 35;
const DESKTOP_SETTINGS_PANE_MAX_PERCENT = 70;
const DESKTOP_SETTINGS_PANE_MIN_WIDTH_PX = 420;
const DESKTOP_SETTINGS_TABS_GUTTER_PX = 40;

const SETTINGS_TAB_TRIGGER_CLASS =
  "h-auto flex-none rounded-xl border-0 px-3.5 py-2 text-sm font-medium text-muted-foreground shadow-none transition-all hover:bg-background/70 hover:text-foreground data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow-sm";

function clampPercent(value: number): number {
  return Math.min(
    DESKTOP_SETTINGS_PANE_MAX_PERCENT,
    Math.max(DESKTOP_SETTINGS_PANE_DEFAULT_PERCENT, value),
  );
}

function calculateRequiredSettingsPanePercent({
  panelGroupWidth,
  tabsWidth,
}: {
  panelGroupWidth: number;
  tabsWidth: number;
}): number {
  if (panelGroupWidth <= 0 || tabsWidth <= 0) {
    return DESKTOP_SETTINGS_PANE_DEFAULT_PERCENT;
  }

  const requiredWidth = Math.max(
    DESKTOP_SETTINGS_PANE_MIN_WIDTH_PX,
    tabsWidth + DESKTOP_SETTINGS_TABS_GUTTER_PX,
  );

  return clampPercent((requiredWidth / panelGroupWidth) * 100);
}

function getSettingsTabForNode(nodeId: string | null): SettingsTab {
  if (nodeId?.startsWith("server:")) {
    return "servers";
  }
  return "hostContext";
}

function isInsecureUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).protocol === "http:";
  } catch {
    return false;
  }
}

function updateSelectedServerIds(
  currentServerIds: string[],
  serverId: string,
  checked: boolean,
): string[] {
  const hasServer = currentServerIds.includes(serverId);

  if (checked) {
    return hasServer ? currentServerIds : [...currentServerIds, serverId];
  }

  return hasServer
    ? currentServerIds.filter((id) => id !== serverId)
    : currentServerIds;
}

type ViewMode = "builder" | "insights" | "preview";

function BuilderHeader({
  title,
  isDirty,
  isSaving,
  canPreview,
  isCanvasActive,
  isPreviewActive,
  isInsightsActive,
  canOpenInsights,
  isSettingsOpen,
  onBack,
  onSave,
  onShowCanvas,
  onShowPreview,
  onOpenFullPreview,
  onCopyLink,
  onOpenShareSettings,
  onToggleInsights,
  onToggleSettings,
}: {
  title: string;
  isDirty: boolean;
  isSaving: boolean;
  canPreview: boolean;
  isCanvasActive: boolean;
  isPreviewActive: boolean;
  isInsightsActive: boolean;
  canOpenInsights: boolean;
  isSettingsOpen: boolean;
  onBack: () => void;
  onSave: () => void;
  onShowCanvas: () => void;
  onShowPreview: () => void;
  onOpenFullPreview: () => void;
  onCopyLink: () => void;
  onOpenShareSettings: () => void;
  onToggleInsights: () => void;
  onToggleSettings: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border/70 px-6 py-4">
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
            {isDirty ? <Badge variant="outline">Unsaved</Badge> : null}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              className="rounded-xl"
              title="Share sandbox via link or open in new tab"
            >
              <Share2 className="mr-1.5 size-4" />
              Share
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[10rem]">
            <DropdownMenuItem onClick={onCopyLink} disabled={!canPreview}>
              <Copy className="size-4" />
              Copy link
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={onOpenFullPreview}
              disabled={!canPreview}
            >
              <ExternalLink className="size-4" />
              Open in new tab
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onOpenShareSettings}>
              <Link2 className="size-4" />
              Manage sharing
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="inline-flex items-center gap-1 rounded-xl border border-border/70 bg-background p-1">
          <Button
            variant={isCanvasActive ? "secondary" : "ghost"}
            size="sm"
            className="rounded-lg"
            onClick={onShowCanvas}
          >
            Canvas
          </Button>
          <Button
            variant={isPreviewActive ? "secondary" : "ghost"}
            size="sm"
            className="rounded-lg"
            disabled={!canPreview}
            onClick={onShowPreview}
          >
            Preview
          </Button>
        </div>
        <Button onClick={onSave} disabled={isSaving} className="rounded-xl">
          {isSaving ? (
            <Loader2 className="mr-1.5 size-4 animate-spin" />
          ) : (
            <Save className="mr-1.5 size-4" />
          )}
          Save
        </Button>
        <Button
          variant={isInsightsActive ? "secondary" : "outline"}
          className="rounded-xl"
          disabled={!canOpenInsights}
          onClick={onToggleInsights}
          title="Usage"
        >
          <MessageSquareText className="mr-1.5 size-4" />
          Usage
        </Button>
        <Button
          variant={isSettingsOpen ? "secondary" : "outline"}
          size="icon"
          className="rounded-xl"
          onClick={onToggleSettings}
          title="Settings"
          aria-label="Settings"
        >
          <Settings className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function EmptyInspector({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <Card className="max-w-sm rounded-3xl border-dashed p-6 text-center">
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="mt-2 text-sm text-muted-foreground">{body}</p>
      </Card>
    </div>
  );
}

function ServerSelectionEditor({
  workspaceServers,
  selectedServerIds,
  onToggleSelection,
  onOpenAdd,
}: {
  workspaceServers: RemoteServer[];
  selectedServerIds: string[];
  onToggleSelection: (serverId: string, checked: boolean) => void;
  onOpenAdd: () => void;
}) {
  const availableServers = workspaceServers.filter(
    (server) => server.transportType === "http",
  );
  const selectedServerSet = new Set(selectedServerIds);
  const selectedServers = availableServers.filter((server) =>
    selectedServerSet.has(server._id),
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">MCP servers</h3>
          <p className="text-xs text-muted-foreground">
            Attach HTTPS MCP servers to this sandbox.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onOpenAdd}>
          <Plus className="mr-1.5 size-4" />
          Add server
        </Button>
      </div>

      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Select servers"
            className="flex w-full items-center justify-between rounded-xl border border-border/60 bg-muted/35 px-3 py-2 text-sm transition-colors hover:bg-muted/50"
          >
            {selectedServers.length === 0 ? (
              <span className="text-muted-foreground">Select servers...</span>
            ) : (
              <span className="flex flex-wrap gap-1">
                {selectedServers.map((server) => (
                  <Badge
                    key={server._id}
                    variant="secondary"
                    className="text-xs"
                  >
                    {server.name}
                  </Badge>
                ))}
              </span>
            )}
            <ChevronsUpDown className="ml-2 size-4 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="w-[var(--radix-popover-trigger-width)] p-1"
          align="start"
        >
          {availableServers.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              No HTTP servers available.
            </p>
          ) : (
            <div className="max-h-56 overflow-y-auto">
              {availableServers.map((server) => {
                const insecure = isInsecureUrl(server.url);
                return (
                  <label
                    key={server._id}
                    className={`flex items-center gap-3 rounded-md px-2 py-1.5 ${insecure ? "cursor-not-allowed opacity-50" : "hover:bg-muted/50"}`}
                    title={
                      insecure
                        ? "Sandboxes require HTTPS server URLs"
                        : undefined
                    }
                  >
                    <Checkbox
                      checked={!insecure && selectedServerSet.has(server._id)}
                      onCheckedChange={(checked) =>
                        onToggleSelection(server._id, checked === true)
                      }
                      disabled={insecure}
                    />
                    <span className="flex-1 text-sm">{server.name}</span>
                    {insecure ? (
                      <span className="text-[10px] text-destructive">
                        Requires HTTPS
                      </span>
                    ) : null}
                  </label>
                );
              })}
            </div>
          )}
        </PopoverContent>
      </Popover>

      {selectedServers.length === 0 ? (
        <Card className="rounded-2xl border-dashed p-5 text-sm text-muted-foreground">
          No servers attached yet.
        </Card>
      ) : (
        <div className="space-y-3">
          {selectedServers.map((server) => (
            <Card key={server._id} className="rounded-2xl p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{server.name}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {server.url ?? "Workspace server"}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Badge variant="outline">
                      {server.useOAuth ? "OAuth" : "Direct"}
                    </Badge>
                    <Badge
                      variant={
                        isInsecureUrl(server.url) ? "secondary" : "outline"
                      }
                    >
                      {isInsecureUrl(server.url) ? "Requires HTTPS" : "HTTPS"}
                    </Badge>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => onToggleSelection(server._id, false)}
                >
                  Remove
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function SandboxGeneralSettingsSection({
  sandboxDraft,
  onDraftChange,
}: {
  sandboxDraft: SandboxDraftConfig;
  onDraftChange: (
    updater: (draft: SandboxDraftConfig) => SandboxDraftConfig,
  ) => void;
}) {
  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 p-4">
        <div className="space-y-1">
          <h4 className="text-sm font-semibold">General</h4>
          <p className="text-sm text-muted-foreground">
            Name the sandbox and add an internal description for collaborators.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="settings-sandbox-name">Sandbox name</Label>
          <Input
            id="settings-sandbox-name"
            value={sandboxDraft.name}
            onChange={(event) =>
              onDraftChange((draft) => ({
                ...draft,
                name: event.target.value,
              }))
            }
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="settings-sandbox-description">Description</Label>
          <Textarea
            id="settings-sandbox-description"
            rows={4}
            value={sandboxDraft.description}
            onChange={(event) =>
              onDraftChange((draft) => ({
                ...draft,
                description: event.target.value,
              }))
            }
          />
        </div>
      </div>
    </ScrollArea>
  );
}

function SandboxHostContextSettingsSection({
  sandboxDraft,
  onDraftChange,
}: {
  sandboxDraft: SandboxDraftConfig;
  onDraftChange: (
    updater: (draft: SandboxDraftConfig) => SandboxDraftConfig,
  ) => void;
}) {
  const hostedModels = useMemo(
    () =>
      SUPPORTED_MODELS.filter((model) =>
        isMCPJamProvidedModel(String(model.id)),
      ),
    [],
  );

  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 p-5">
        <div className="space-y-1">
          <h4 className="text-sm font-semibold">Host Context</h4>
          <p className="text-sm text-muted-foreground">
            Configure host style, model, prompt, and policies.
          </p>
        </div>

        <div className="space-y-2">
          <Label>Host style</Label>
          <div className="grid gap-2">
            {(["claude", "chatgpt"] as SandboxHostStyle[]).map((hostStyle) => {
              const selected = sandboxDraft.hostStyle === hostStyle;
              return (
                <button
                  key={hostStyle}
                  type="button"
                  className={`flex items-center gap-3 rounded-2xl border px-4 py-4 text-left transition-colors ${
                    selected
                      ? "border-primary/50 bg-primary/10"
                      : "border-border/70 bg-card/60 hover:bg-muted/20"
                  }`}
                  onClick={() =>
                    onDraftChange((draft) => ({
                      ...draft,
                      hostStyle,
                    }))
                  }
                >
                  <img
                    src={getSandboxHostLogo(hostStyle)}
                    alt={getSandboxHostLabel(hostStyle)}
                    className="size-6 rounded-md object-contain"
                  />
                  <div>
                    <p className="font-medium">
                      {getSandboxHostLabel(hostStyle)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {hostStyle === "chatgpt"
                        ? "OpenAI-style sandbox chrome"
                        : "Claude-style sandbox chrome"}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <Separator />

        <div className="space-y-2">
          <Label>Model</Label>
          <Select
            value={sandboxDraft.modelId}
            onValueChange={(value) =>
              onDraftChange((draft) => ({
                ...draft,
                modelId: value,
              }))
            }
          >
            <SelectTrigger>
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

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <Label>Temperature</Label>
            <span className="text-sm text-muted-foreground">
              {sandboxDraft.temperature.toFixed(2)}
            </span>
          </div>
          <Slider
            min={0}
            max={2}
            step={0.05}
            value={[sandboxDraft.temperature]}
            onValueChange={(values) =>
              onDraftChange((draft) => ({
                ...draft,
                temperature: values[0] ?? 0.7,
              }))
            }
          />
        </div>

        <Separator />

        <div className="space-y-2">
          <Label htmlFor="builder-prompt">System prompt</Label>
          <Textarea
            id="builder-prompt"
            rows={10}
            value={sandboxDraft.systemPrompt}
            onChange={(event) =>
              onDraftChange((draft) => ({
                ...draft,
                systemPrompt: event.target.value,
              }))
            }
          />
        </div>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card/60 px-4 py-4">
            <div>
              <p className="text-sm font-medium">Require tool approval</p>
              <p className="text-xs text-muted-foreground">
                Visitors must approve tool calls before execution.
              </p>
            </div>
            <Switch
              checked={sandboxDraft.requireToolApproval}
              onCheckedChange={(checked) =>
                onDraftChange((draft) => ({
                  ...draft,
                  requireToolApproval: checked,
                }))
              }
            />
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}

function SandboxServersSettingsSection({
  sandboxDraft,
  workspaceServers,
  onOpenAddServer,
  onToggleServer,
}: {
  sandboxDraft: SandboxDraftConfig;
  workspaceServers: RemoteServer[];
  onOpenAddServer: () => void;
  onToggleServer: (serverId: string, checked: boolean) => void;
}) {
  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 p-5">
        <div className="space-y-1">
          <h4 className="text-sm font-semibold">Servers</h4>
          <p className="text-sm text-muted-foreground">
            Attach and manage the MCP servers available to this sandbox.
          </p>
        </div>

        <ServerSelectionEditor
          workspaceServers={workspaceServers}
          selectedServerIds={sandboxDraft.selectedServerIds}
          onToggleSelection={onToggleServer}
          onOpenAdd={onOpenAddServer}
        />
      </div>
    </ScrollArea>
  );
}

function BuilderSettingsPanel({
  sandboxDraft,
  activeTab,
  workspaceServers,
  workspaceName,
  savedSandbox,
  onDraftChange,
  tabsRowRef,
  onTabChange,
  onOpenAddServer,
  onToggleServer,
  onClose,
}: {
  sandboxDraft: SandboxDraftConfig;
  activeTab: SettingsTab;
  workspaceServers: RemoteServer[];
  workspaceName?: string | null;
  savedSandbox: SandboxSettings | null;
  onDraftChange: (
    updater: (draft: SandboxDraftConfig) => SandboxDraftConfig,
  ) => void;
  tabsRowRef: RefObject<HTMLDivElement | null>;
  onTabChange: (tab: SettingsTab) => void;
  onOpenAddServer: () => void;
  onToggleServer: (serverId: string, checked: boolean) => void;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-5 py-4">
        <h3 className="text-base font-semibold">Settings</h3>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 rounded-lg"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(value) => onTabChange(value as SettingsTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div ref={tabsRowRef} className="px-5 pb-1">
          <TabsList className="h-auto justify-start gap-1 overflow-x-auto rounded-2xl border border-border/60 bg-muted/35 p-1.5 md:overflow-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <TabsTrigger value="general" className={SETTINGS_TAB_TRIGGER_CLASS}>
              General
            </TabsTrigger>
            <TabsTrigger
              value="hostContext"
              className={SETTINGS_TAB_TRIGGER_CLASS}
            >
              Host Context
            </TabsTrigger>
            <TabsTrigger value="servers" className={SETTINGS_TAB_TRIGGER_CLASS}>
              Servers
            </TabsTrigger>
            <TabsTrigger value="share" className={SETTINGS_TAB_TRIGGER_CLASS}>
              Share
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent
          value="general"
          className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden"
        >
          <SandboxGeneralSettingsSection
            sandboxDraft={sandboxDraft}
            onDraftChange={onDraftChange}
          />
        </TabsContent>

        <TabsContent
          value="hostContext"
          className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden"
        >
          <SandboxHostContextSettingsSection
            sandboxDraft={sandboxDraft}
            onDraftChange={onDraftChange}
          />
        </TabsContent>

        <TabsContent
          value="servers"
          className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden"
        >
          <SandboxServersSettingsSection
            sandboxDraft={sandboxDraft}
            workspaceServers={workspaceServers}
            onOpenAddServer={onOpenAddServer}
            onToggleServer={onToggleServer}
          />
        </TabsContent>

        <TabsContent
          value="share"
          className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden"
        >
          {savedSandbox ? (
            <ScrollArea className="h-full">
              <div className="p-4">
                <SandboxShareSection
                  sandbox={savedSandbox}
                  workspaceName={workspaceName}
                  appearance="builder"
                />
              </div>
            </ScrollArea>
          ) : (
            <EmptyInspector
              title="Save sandbox first"
              body="Sharing depends on a persisted sandbox link. Save this sandbox, then come back here to manage access and invitations."
            />
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function SandboxBuilderView({
  workspaceId,
  workspaceName,
  workspaceServers,
  sandboxId,
  draft,
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
            } as SandboxSettings),
        ),
    );
  const [viewMode, setViewMode] = useState<ViewMode>("builder");
  const [chatKey, setChatKey] = useState(0);
  const [playgroundId, setPlaygroundId] = useState(() => crypto.randomUUID());
  const [isSettingsOpen, setIsSettingsOpen] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("host");
  const [activeSettingsTab, setActiveSettingsTab] =
    useState<SettingsTab>("hostContext");
  const [desktopSettingsPaneSize, setDesktopSettingsPaneSize] = useState(
    DESKTOP_SETTINGS_PANE_DEFAULT_PERCENT,
  );
  const [requiredSettingsPanePercent, setRequiredSettingsPanePercent] =
    useState(DESKTOP_SETTINGS_PANE_DEFAULT_PERCENT);
  const [isSaving, setIsSaving] = useState(false);
  const [isAddServerOpen, setIsAddServerOpen] = useState(false);
  const panelGroupContainerRef = useRef<HTMLDivElement | null>(null);
  const rightPanelRef = useRef<ImperativePanelHandle | null>(null);
  const settingsTabsRowRef = useRef<HTMLDivElement | null>(null);
  const isInitialMountRef = useRef(true);
  const pendingRestartRef = useRef(false);
  const prevViewModeRef = useRef(viewMode);

  const behaviorFingerprint = useMemo(
    () =>
      JSON.stringify({
        name: draftSandboxConfig.name,
        hostStyle: draftSandboxConfig.hostStyle,
        systemPrompt: draftSandboxConfig.systemPrompt,
        modelId: draftSandboxConfig.modelId,
        temperature: draftSandboxConfig.temperature,
        requireToolApproval: draftSandboxConfig.requireToolApproval,
        selectedServerIds: [...draftSandboxConfig.selectedServerIds].sort(),
      }),
    [
      draftSandboxConfig.name,
      draftSandboxConfig.hostStyle,
      draftSandboxConfig.systemPrompt,
      draftSandboxConfig.modelId,
      draftSandboxConfig.temperature,
      draftSandboxConfig.requireToolApproval,
      draftSandboxConfig.selectedServerIds,
    ],
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
      allowGuestAccess: sandbox.allowGuestAccess,
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
      surface: "internal",
      playgroundId,
      updatedAt: Date.now(),
    });
  }, [draftSandboxConfig, sandbox, workspaceServers, playgroundId]);

  useEffect(() => {
    if (!draft && sandbox) {
      setDraftSandboxConfig(toDraftConfig(sandbox));
    }
  }, [draft, sandbox]);

  useLayoutEffect(() => {
    if (isMobile || !isSettingsOpen) {
      return;
    }

    const measureRequiredWidth = () => {
      const panelGroupContainer = panelGroupContainerRef.current;
      const tabsRow = settingsTabsRowRef.current;
      const tabsList = tabsRow?.firstElementChild;
      if (!panelGroupContainer || !(tabsList instanceof HTMLElement)) {
        return;
      }

      const panelGroupWidth =
        panelGroupContainer.getBoundingClientRect().width ||
        panelGroupContainer.clientWidth;
      const tabsWidth = tabsList.scrollWidth;

      setRequiredSettingsPanePercent(
        calculateRequiredSettingsPanePercent({
          panelGroupWidth,
          tabsWidth,
        }),
      );
    };

    measureRequiredWidth();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      measureRequiredWidth();
    });

    if (typeof resizeObserver.observe !== "function") {
      return;
    }

    const panelGroupContainer = panelGroupContainerRef.current;
    const tabsRow = settingsTabsRowRef.current;
    const tabsList = tabsRow?.firstElementChild;

    if (panelGroupContainer) {
      resizeObserver.observe(panelGroupContainer);
    }
    if (tabsRow) {
      resizeObserver.observe(tabsRow);
    }
    if (tabsList instanceof HTMLElement) {
      resizeObserver.observe(tabsList);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [isMobile, isSettingsOpen]);

  useLayoutEffect(() => {
    if (isMobile || !isSettingsOpen) {
      return;
    }

    const rightPanel = rightPanelRef.current;
    if (!rightPanel) {
      return;
    }

    const targetSize = Math.max(
      desktopSettingsPaneSize,
      requiredSettingsPanePercent,
    );
    const currentSize = rightPanel.getSize();

    if (currentSize < targetSize) {
      rightPanel.resize(targetSize);
    }
  }, [
    desktopSettingsPaneSize,
    isMobile,
    isSettingsOpen,
    requiredSettingsPanePercent,
  ]);

  const context = useMemo<SandboxBuilderContext>(
    () => ({
      sandbox: sandbox ?? null,
      draft: draftSandboxConfig,
      workspaceServers,
    }),
    [draftSandboxConfig, sandbox, workspaceServers],
  );
  const viewModel = useMemo(() => buildSandboxCanvas(context), [context]);
  const desktopRightPanelDefaultSize = Math.max(
    desktopSettingsPaneSize,
    requiredSettingsPanePercent,
  );
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
      JSON.stringify(currentIds) !== JSON.stringify(draftIds)
    );
  }, [draftSandboxConfig, sandbox]);

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

  const saveSandbox = useCallback(async () => {
    const trimmedName = draftSandboxConfig.name.trim();
    if (!trimmedName) {
      toast.error("Sandbox name is required");
      return;
    }
    if (draftSandboxConfig.selectedServerIds.length === 0) {
      toast.error("Select at least one HTTPS server");
      return;
    }
    const selectedServers = workspaceServers.filter((server) =>
      draftSandboxConfig.selectedServerIds.includes(server._id),
    );
    if (selectedServers.some((server) => isInsecureUrl(server.url))) {
      toast.error("Only HTTPS servers can be used in sandboxes");
      return;
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
        allowGuestAccess:
          (draftSandboxConfig as { allowGuestAccess?: boolean })
            .allowGuestAccess ??
          sandbox?.allowGuestAccess ??
          false,
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
        onSavedDraft(created);
        return;
      }

      await updateSandbox({
        sandboxId: sandbox.sandboxId,
        ...payload,
      });
      toast.success("Sandbox updated");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save sandbox",
      );
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

  const handleOpenPreview = useCallback(() => {
    if (!sandbox?.link?.token) {
      toast.error("Save the sandbox first to preview");
      return;
    }
    setViewMode("preview");
  }, [sandbox]);

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
        setActiveSettingsTab("servers");
        setIsSettingsOpen(true);
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
        setActiveSettingsTab("servers");
        setIsSettingsOpen(true);
        return;
      }

      setSelectedNodeId((current) =>
        current === `server:${serverId}` ? "host" : current,
      );
    },
    [],
  );

  const rightPaneContent = (
    <div className="sandbox-builder-pane h-full min-h-0 border-l border-border/70">
      <BuilderSettingsPanel
        sandboxDraft={draftSandboxConfig}
        activeTab={activeSettingsTab}
        workspaceServers={workspaceServers}
        workspaceName={workspaceName}
        savedSandbox={sandbox ?? null}
        onDraftChange={(updater) =>
          setDraftSandboxConfig((current) => updater(current))
        }
        tabsRowRef={settingsTabsRowRef}
        onTabChange={setActiveSettingsTab}
        onOpenAddServer={() => {
          setActiveSettingsTab("servers");
          setIsSettingsOpen(true);
          setIsAddServerOpen(true);
        }}
        onToggleServer={handleToggleServer}
        onClose={() => setIsSettingsOpen(false)}
      />
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <BuilderHeader
        title={viewModel.title}
        isDirty={isDirty}
        isSaving={isSaving}
        canPreview={!!shareLink}
        isCanvasActive={viewMode === "builder"}
        isPreviewActive={viewMode === "preview"}
        isInsightsActive={viewMode === "insights"}
        canOpenInsights={!!sandbox}
        isSettingsOpen={isSettingsOpen}
        onBack={onBack}
        onSave={() => void saveSandbox()}
        onShowCanvas={() => setViewMode("builder")}
        onShowPreview={handleOpenPreview}
        onOpenFullPreview={handleOpenFullPreview}
        onCopyLink={() => void handleCopyLink()}
        onOpenShareSettings={() => {
          setIsSettingsOpen(true);
          setActiveSettingsTab("share");
        }}
        onToggleInsights={() => {
          setViewMode((current) =>
            current === "insights" ? "builder" : "insights",
          );
        }}
        onToggleSettings={() => {
          setIsSettingsOpen((current) => !current);
        }}
      />

      {viewMode === "insights" && sandbox ? (
        <div className="min-h-0 flex-1">
          <SandboxUsagePanel sandbox={sandbox} />
        </div>
      ) : (
        <div className="min-h-0 flex-1 p-4">
          <div ref={panelGroupContainerRef} className="h-full">
            <ResizablePanelGroup direction="horizontal" className="h-full">
              <ResizablePanel
                defaultSize={desktopLeftPanelDefaultSize}
                minSize={30}
              >
                <div className="h-full pr-2">
                  {viewMode === "preview" ? (
                    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[28px] border border-border/70 bg-card/60">
                      <div className="flex items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
                        <div>
                          <h3 className="text-sm font-semibold">Preview</h3>
                          <p className="text-xs text-muted-foreground">
                            Preview traffic is recorded in insights.
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              const nextId = crypto.randomUUID();
                              setPlaygroundId(nextId);
                              setChatKey((k) => k + 1);
                            }}
                          >
                            Reload
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={handleOpenFullPreview}
                            disabled={!sandbox?.link?.token}
                          >
                            Open full preview
                          </Button>
                        </div>
                      </div>
                      <div className="flex min-h-0 flex-1">
                        {sandbox?.link?.token ? (
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
                              hostedWorkspaceIdOverride={sandbox.workspaceId}
                              hostedSelectedServerIdsOverride={
                                draftSandboxConfig.selectedServerIds
                              }
                              hostedOAuthTokensOverride={{}}
                              hostedSandboxToken={sandbox.link.token}
                              hostedSandboxSurface="internal"
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
                            />
                          </SandboxHostStyleProvider>
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
                  ) : (
                    <ReactFlowProvider>
                      <SandboxCanvas
                        viewModel={viewModel}
                        selectedNodeId={selectedNodeId}
                        onAddServer={() => {
                          setActiveSettingsTab("servers");
                          setIsSettingsOpen(true);
                          setIsAddServerOpen(true);
                        }}
                        onSelectNode={(nodeId) => {
                          setSelectedNodeId(nodeId);
                          setActiveSettingsTab(getSettingsTabForNode(nodeId));
                          setIsSettingsOpen(true);
                        }}
                        onClearSelection={() => {
                          setSelectedNodeId(null);
                        }}
                      />
                    </ReactFlowProvider>
                  )}
                </div>
              </ResizablePanel>

              {!isMobile && isSettingsOpen ? (
                <>
                  <ResizableHandle withHandle />
                  <ResizablePanel
                    ref={rightPanelRef}
                    defaultSize={desktopRightPanelDefaultSize}
                    minSize={requiredSettingsPanePercent}
                    maxSize={DESKTOP_SETTINGS_PANE_MAX_PERCENT}
                    onResize={(size) => setDesktopSettingsPaneSize(size)}
                  >
                    {rightPaneContent}
                  </ResizablePanel>
                </>
              ) : null}
            </ResizablePanelGroup>
          </div>
        </div>
      )}

      <Sheet
        open={isMobile && isSettingsOpen}
        onOpenChange={(open) => {
          if (!open) {
            setIsSettingsOpen(false);
          }
        }}
      >
        <SheetContent
          side="bottom"
          className="h-[78vh] rounded-t-[28px] border-border/70 p-0"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Sandbox settings</SheetTitle>
            <SheetDescription>
              Manage general, host, server, and sharing settings.
            </SheetDescription>
          </SheetHeader>
          {rightPaneContent}
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
