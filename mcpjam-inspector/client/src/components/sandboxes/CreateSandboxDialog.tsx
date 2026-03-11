import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { isMCPJamProvidedModel, SUPPORTED_MODELS } from "@/shared/types";
import type { SandboxSettings } from "@/hooks/useSandboxes";
import { useSandboxMutations } from "@/hooks/useSandboxes";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

interface CreateSandboxDialogProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceId: string;
  workspaceServers: WorkspaceServerOption[];
  sandbox?: SandboxSettings | null;
  onSaved?: (sandbox: SandboxSettings) => void;
}

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

export function CreateSandboxDialog({
  isOpen,
  onClose,
  workspaceId,
  workspaceServers,
  sandbox,
  onSaved,
}: CreateSandboxDialogProps) {
  const { createSandbox, updateSandbox } = useSandboxMutations();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [modelId, setModelId] = useState("openai/gpt-5-mini");
  const [temperature, setTemperature] = useState(0.7);
  const [requireToolApproval, setRequireToolApproval] = useState(false);
  const [allowGuestAccess, setAllowGuestAccess] = useState(false);
  const [selectedServerIds, setSelectedServerIds] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  const availableServers = useMemo(
    () => workspaceServers.filter((server) => server.transportType === "http"),
    [workspaceServers],
  );
  const hostedModels = useMemo(
    () =>
      SUPPORTED_MODELS.filter((model) =>
        isMCPJamProvidedModel(String(model.id)),
      ),
    [],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setName(sandbox?.name ?? "");
    setDescription(sandbox?.description ?? "");
    setSystemPrompt(sandbox?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);
    setModelId(
      sandbox?.modelId ??
        hostedModels[0]?.id?.toString() ??
        "openai/gpt-5-mini",
    );
    setTemperature(sandbox?.temperature ?? 0.7);
    setRequireToolApproval(sandbox?.requireToolApproval ?? false);
    setAllowGuestAccess(sandbox?.allowGuestAccess ?? false);
    setSelectedServerIds(
      sandbox?.servers.map((server) => server.serverId) ?? [],
    );
  }, [hostedModels, isOpen, sandbox]);

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
      const payload = {
        name: trimmedName,
        description: description.trim() || undefined,
        systemPrompt: systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT,
        modelId,
        temperature,
        hostStyle: sandbox?.hostStyle ?? "claude",
        requireToolApproval,
        allowGuestAccess,
        serverIds: selectedServerIds,
      };

      const next = (
        sandbox
          ? await updateSandbox({
              sandboxId: sandbox.sandboxId,
              ...payload,
            })
          : await createSandbox({
              workspaceId,
              ...payload,
            })
      ) as SandboxSettings;

      onSaved?.(next);
      toast.success(sandbox ? "Sandbox updated" : "Sandbox created");
      onClose();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save sandbox",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {sandbox ? "Edit Sandbox" : "Create Sandbox"}
          </DialogTitle>
          <DialogDescription>
            Configure a hosted chat environment with a fixed model, prompt, and
            server set.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-2">
            <Label htmlFor="sandbox-name">Name</Label>
            <Input
              id="sandbox-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Support Assistant Demo"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="sandbox-description">Description</Label>
            <Textarea
              id="sandbox-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Short context for anyone opening this sandbox."
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="sandbox-system-prompt">System prompt</Label>
            <Textarea
              id="sandbox-system-prompt"
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              className="min-h-32"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <Label>Model</Label>
              <Select value={modelId} onValueChange={setModelId}>
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

            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>Temperature</Label>
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
              />
            </div>
          </div>

          <div className="grid gap-3 rounded-lg border p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Require tool approval</p>
                <p className="text-xs text-muted-foreground">
                  Visitors must approve tool calls before execution continues.
                </p>
              </div>
              <Switch
                checked={requireToolApproval}
                onCheckedChange={setRequireToolApproval}
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Allow guest access</p>
                <p className="text-xs text-muted-foreground">
                  Unauthenticated visitors can open the link when the sandbox
                  mode allows it.
                </p>
              </div>
              <Switch
                checked={allowGuestAccess}
                onCheckedChange={setAllowGuestAccess}
              />
            </div>
          </div>

          <div className="grid gap-3">
            <div>
              <p className="text-sm font-medium">Servers</p>
              <p className="text-xs text-muted-foreground">
                Only HTTP servers can be used in sandboxes.
              </p>
            </div>
            <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border p-3">
              {availableServers.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No HTTP servers are available in this workspace yet.
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
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={() => void handleSave()} disabled={isSaving}>
            {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {sandbox ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
