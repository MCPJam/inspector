import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { isMCPJamProvidedModel, SUPPORTED_MODELS } from "@/shared/types";
import type { ChatboxSettings } from "@/hooks/useChatboxes";
import { useChatboxMutations } from "@/hooks/useChatboxes";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Textarea } from "@mcpjam/design-system/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import { Slider } from "@mcpjam/design-system/slider";
import { Switch } from "@mcpjam/design-system/switch";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";

interface WorkspaceServerOption {
  _id: string;
  name: string;
  transportType: "stdio" | "http";
}

interface CreateChatboxDialogProps {
  isOpen: boolean;
  onClose: () => void;
  workspaceId: string;
  workspaceServers: WorkspaceServerOption[];
  chatbox?: ChatboxSettings | null;
  onSaved?: (chatbox: ChatboxSettings) => void;
}

const DEFAULT_SYSTEM_PROMPT = "You are a helpful assistant.";

export function CreateChatboxDialog({
  isOpen,
  onClose,
  workspaceId,
  workspaceServers,
  chatbox,
  onSaved,
}: CreateChatboxDialogProps) {
  const { createChatbox, updateChatbox } = useChatboxMutations();
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

    setName(chatbox?.name ?? "");
    setDescription(chatbox?.description ?? "");
    setSystemPrompt(chatbox?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT);
    setModelId(
      chatbox?.modelId ??
        hostedModels[0]?.id?.toString() ??
        "openai/gpt-5-mini",
    );
    setTemperature(chatbox?.temperature ?? 0.7);
    setRequireToolApproval(chatbox?.requireToolApproval ?? false);
    setAllowGuestAccess(chatbox?.allowGuestAccess ?? false);
    setSelectedServerIds(
      chatbox?.servers.map((server) => server.serverId) ?? [],
    );
  }, [hostedModels, isOpen, chatbox]);

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
      toast.error("Chatbox name is required");
      return;
    }
    if (selectedServerIds.length === 0) {
      toast.error("Select at least one HTTP server");
      return;
    }

    setIsSaving(true);
    try {
      const optionalServerIds = chatbox
        ? chatbox.servers
            .filter(
              (s) =>
                s.optional === true && selectedServerIds.includes(s.serverId),
            )
            .map((s) => s.serverId)
        : [];

      const payload = {
        name: trimmedName,
        description: description.trim() || undefined,
        systemPrompt: systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT,
        modelId,
        temperature,
        hostStyle: chatbox?.hostStyle ?? "claude",
        requireToolApproval,
        allowGuestAccess,
        serverIds: selectedServerIds,
        optionalServerIds,
      };

      const next = (
        chatbox
          ? await updateChatbox({
              chatboxId: chatbox.chatboxId,
              ...payload,
            })
          : await createChatbox({
              workspaceId,
              ...payload,
            })
      ) as ChatboxSettings;

      onSaved?.(next);
      toast.success(chatbox ? "Chatbox updated" : "Chatbox created");
      onClose();
    } catch (error) {
      toast.error(getBillingErrorMessage(error, "Failed to save chatbox"));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {chatbox ? "Edit Chatbox" : "Create Chatbox"}
          </DialogTitle>
          <DialogDescription>
            Configure a hosted chat environment with a fixed model, prompt, and
            server set.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="grid gap-2">
            <Label htmlFor="chatbox-name">Name</Label>
            <Input
              id="chatbox-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Support Assistant Demo"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="chatbox-description">Description</Label>
            <Textarea
              id="chatbox-description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Short context for anyone opening this chatbox."
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="chatbox-system-prompt">System prompt</Label>
            <Textarea
              id="chatbox-system-prompt"
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
                  Unauthenticated visitors can open the link when the chatbox
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
                Only HTTP servers can be used in chatboxes.
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
            {chatbox ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
