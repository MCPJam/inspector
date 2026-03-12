import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Globe,
  Loader2,
  Lock,
  Plus,
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
import { SandboxShareSection } from "@/components/sandboxes/SandboxShareSection";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  getSandboxHostLabel,
  getSandboxHostLogo,
  type SandboxHostStyle,
} from "@/lib/sandbox-host-style";

interface WorkspaceServerOption {
  _id: string;
  name: string;
  transportType: "stdio" | "http";
  url?: string;
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
  const [isSaving, setIsSaving] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(isCreateMode);
  const [isAddServerOpen, setIsAddServerOpen] = useState(false);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);

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
      setIsEditingTitle(true);
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
    setIsEditingTitle(false);
  }, [hostedModels, sandbox]);

  const availableServers = useMemo(
    () => workspaceServers.filter((s) => s.transportType === "http"),
    [workspaceServers],
  );

  const hasUnsavedChanges = useMemo(() => {
    if (isCreateMode) return true;
    const currentServerIds = sandbox!.servers.map((s) => s.serverId).sort();
    const formServerIds = [...selectedServerIds].sort();
    return (
      name !== sandbox!.name ||
      description !== (sandbox!.description ?? "") ||
      hostStyle !== sandbox!.hostStyle ||
      systemPrompt !== sandbox!.systemPrompt ||
      modelId !== sandbox!.modelId ||
      temperature !== sandbox!.temperature ||
      requireToolApproval !== sandbox!.requireToolApproval ||
      allowGuestAccess !== sandbox!.allowGuestAccess ||
      JSON.stringify(formServerIds) !== JSON.stringify(currentServerIds)
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
    sandbox,
  ]);

  const handleToggleServer = (serverId: string, checked: boolean) => {
    setSelectedServerIds((current) => {
      if (checked) {
        return current.includes(serverId) ? current : [...current, serverId];
      }
      return current.filter((id) => id !== serverId);
    });
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
      toast.error(
        error instanceof Error ? error.message : "Failed to add server",
      );
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
      toast.error(
        error instanceof Error ? error.message : "Failed to save sandbox",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!sandbox) return;
    const shouldDelete = window.confirm(
      `Delete "${sandbox.name}"? This will also delete persisted usage history.`,
    );
    if (!shouldDelete) return;

    try {
      await deleteSandbox({ sandboxId: sandbox.sandboxId });
      toast.success("Sandbox deleted");
      onDeleted?.();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete sandbox",
      );
    }
  };

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
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium text-muted-foreground">
                Servers
              </Label>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                  onClick={() => setIsAddServerOpen(true)}
                >
                  <Plus className="h-3 w-3" />
                  Add
                </button>
              </div>
            </div>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-md border-0 bg-muted/50 px-3 py-2 text-sm transition-colors hover:bg-muted"
                >
                  {selectedServerIds.length === 0 ? (
                    <span className="text-muted-foreground">
                      Select servers…
                    </span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {selectedServerIds.map((id) => {
                        const server = availableServers.find(
                          (s) => s._id === id,
                        );
                        return (
                          <Badge
                            key={id}
                            variant="secondary"
                            className="text-xs"
                          >
                            {server?.name ?? id}
                          </Badge>
                        );
                      })}
                    </span>
                  )}
                  <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
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
                            checked={
                              !insecure &&
                              selectedServerIds.includes(server._id)
                            }
                            onCheckedChange={(checked) =>
                              handleToggleServer(server._id, checked === true)
                            }
                            disabled={insecure}
                          />
                          <span className="flex-1 text-sm">{server.name}</span>
                          {insecure && (
                            <span className="text-[10px] text-destructive">
                              Requires HTTPS
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                )}
              </PopoverContent>
            </Popover>
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
              onClick={() => void handleDelete()}
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </Button>
          </div>
        )}
      </div>

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
