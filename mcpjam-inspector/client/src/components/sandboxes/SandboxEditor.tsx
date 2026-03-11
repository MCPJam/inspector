import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { isMCPJamProvidedModel, SUPPORTED_MODELS } from "@/shared/types";
import type { SandboxSettings } from "@/hooks/useSandboxes";
import { useSandboxMutations } from "@/hooks/useSandboxes";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";

interface WorkspaceServerOption {
  _id: string;
  name: string;
  transportType: "stdio" | "http";
}

interface SandboxEditorProps {
  sandbox: SandboxSettings;
  workspaceServers: WorkspaceServerOption[];
  onBack: () => void;
  onDeleted: () => void;
}

export function SandboxEditor({
  sandbox,
  workspaceServers,
  onBack,
  onDeleted,
}: SandboxEditorProps) {
  const { updateSandbox, deleteSandbox } = useSandboxMutations();

  const [name, setName] = useState(sandbox.name);
  const [description, setDescription] = useState(sandbox.description ?? "");
  const [systemPrompt, setSystemPrompt] = useState(sandbox.systemPrompt);
  const [modelId, setModelId] = useState(sandbox.modelId);
  const [temperature, setTemperature] = useState(sandbox.temperature);
  const [requireToolApproval, setRequireToolApproval] = useState(
    sandbox.requireToolApproval,
  );
  const [allowGuestAccess, setAllowGuestAccess] = useState(
    sandbox.allowGuestAccess,
  );
  const [selectedServerIds, setSelectedServerIds] = useState<string[]>(
    sandbox.servers.map((s) => s.serverId),
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);

  // Reset form when sandbox changes
  useEffect(() => {
    setName(sandbox.name);
    setDescription(sandbox.description ?? "");
    setSystemPrompt(sandbox.systemPrompt);
    setModelId(sandbox.modelId);
    setTemperature(sandbox.temperature);
    setRequireToolApproval(sandbox.requireToolApproval);
    setAllowGuestAccess(sandbox.allowGuestAccess);
    setSelectedServerIds(sandbox.servers.map((s) => s.serverId));
    setIsEditingTitle(false);
  }, [sandbox]);

  const availableServers = useMemo(
    () => workspaceServers.filter((s) => s.transportType === "http"),
    [workspaceServers],
  );

  const hostedModels = useMemo(
    () =>
      SUPPORTED_MODELS.filter((model) =>
        isMCPJamProvidedModel(String(model.id)),
      ),
    [],
  );

  const hasUnsavedChanges = useMemo(() => {
    const currentServerIds = sandbox.servers.map((s) => s.serverId).sort();
    const formServerIds = [...selectedServerIds].sort();
    return (
      name !== sandbox.name ||
      description !== (sandbox.description ?? "") ||
      systemPrompt !== sandbox.systemPrompt ||
      modelId !== sandbox.modelId ||
      temperature !== sandbox.temperature ||
      requireToolApproval !== sandbox.requireToolApproval ||
      allowGuestAccess !== sandbox.allowGuestAccess ||
      JSON.stringify(formServerIds) !== JSON.stringify(currentServerIds)
    );
  }, [
    name,
    description,
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

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error("Sandbox name is required");
      return;
    }
    if (selectedServerIds.length === 0) {
      toast.error("Select at least one HTTP server");
      return;
    }

    setIsSaving(true);
    try {
      await updateSandbox({
        sandboxId: sandbox.sandboxId,
        name: trimmedName,
        description: description.trim() || undefined,
        systemPrompt: systemPrompt.trim() || "You are a helpful assistant.",
        modelId,
        temperature,
        requireToolApproval,
        allowGuestAccess,
        serverIds: selectedServerIds,
      });
      toast.success("Sandbox updated");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save sandbox",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    const shouldDelete = window.confirm(
      `Delete "${sandbox.name}"? This will also delete persisted usage history.`,
    );
    if (!shouldDelete) return;

    try {
      await deleteSandbox({ sandboxId: sandbox.sandboxId });
      toast.success("Sandbox deleted");
      onDeleted();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to delete sandbox",
      );
    }
  };

  const handleTitleBlur = () => {
    setIsEditingTitle(false);
    if (!name.trim()) {
      setName(sandbox.name);
    }
  };

  const handleTitleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      setIsEditingTitle(false);
      if (!name.trim()) {
        setName(sandbox.name);
      }
    }
    if (e.key === "Escape") {
      setName(sandbox.name);
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
                className="w-full border-none bg-transparent px-0 py-0 text-lg font-semibold focus:outline-none focus:ring-0"
              />
            ) : (
              <h2
                className="cursor-pointer truncate text-lg font-semibold transition-opacity hover:opacity-60"
                onClick={() => setIsEditingTitle(true)}
              >
                {name}
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
              Save
            </Button>
          )}
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 space-y-1 overflow-y-auto p-2">
        {/* System prompt */}
        <div className="px-1 pt-2">
          <Label className="text-xs font-medium text-muted-foreground">
            System prompt
          </Label>
          <p className="mb-1.5 text-[10px] text-muted-foreground">
            Instructions given to the model at the start of each conversation.
          </p>
          <Textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={6}
            className="resize-none border-0 bg-muted/30 px-3 py-2 text-sm transition-colors focus-visible:bg-muted/50"
          />
        </div>

        {/* Model + Temperature */}
        <div className="grid gap-4 px-1 pt-3 md:grid-cols-2">
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
        </div>

        {/* Servers */}
        <div className="px-1 pt-3">
          <Label className="text-xs font-medium text-muted-foreground">
            Servers
          </Label>
          <p className="mb-1.5 text-[10px] text-muted-foreground">
            Only HTTP servers can be used in sandboxes.
          </p>
          <div className="max-h-56 space-y-1 overflow-y-auto rounded-md bg-muted/30 p-2">
            {availableServers.length === 0 ? (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">
                No HTTP servers are available in this workspace.
              </p>
            ) : (
              availableServers.map((server) => (
                <label
                  key={server._id}
                  className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/50"
                >
                  <Checkbox
                    checked={selectedServerIds.includes(server._id)}
                    onCheckedChange={(checked) =>
                      handleToggleServer(server._id, checked === true)
                    }
                  />
                  <span className="text-sm">{server.name}</span>
                </label>
              ))
            )}
          </div>
        </div>

        {/* Settings */}
        <div className="px-1 pt-3">
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

        {/* Danger zone */}
        <div className="px-1 pb-4 pt-4">
          <Label className="text-xs font-medium text-destructive">
            Danger zone
          </Label>
          <p className="mb-2 text-[10px] text-muted-foreground">
            Delete the sandbox and all persisted hosted chat usage.
          </p>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => void handleDelete()}
          >
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Delete sandbox
          </Button>
        </div>
      </div>
    </div>
  );
}
