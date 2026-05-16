import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
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
import { Label } from "@mcpjam/design-system/label";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { HostPicker } from "@/components/hosts/HostPicker";

interface CreateChatboxDialogProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  chatbox?: ChatboxSettings | null;
  onSaved?: (chatbox: ChatboxSettings) => void;
}

/**
 * Create / edit a chatbox. Live-reference model: the chatbox owns only
 * its name, description, and a pointer to a named host. All execution
 * config (model, prompt, servers, capabilities, sandbox) lives on the
 * referenced host and is edited through the hosts surface.
 */
export function CreateChatboxDialog({
  isOpen,
  onClose,
  projectId,
  chatbox,
  onSaved,
}: CreateChatboxDialogProps) {
  const { createChatbox, updateChatbox } = useChatboxMutations();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [namedHostId, setNamedHostId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setName(chatbox?.name ?? "");
    setDescription(chatbox?.description ?? "");
    // For edits, preselect the chatbox's current host so the picker
    // shows "Change host" rather than appearing unset. The backend
    // response now includes `namedHostId` on the settings envelope.
    setNamedHostId(chatbox?.namedHostId ?? null);
  }, [isOpen, chatbox]);

  const handleSave = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error("Chatbox name is required");
      return;
    }
    if (!namedHostId) {
      toast.error("Pick a host before saving");
      return;
    }

    setIsSaving(true);
    try {
      const next = (
        chatbox
          ? await updateChatbox({
              chatboxId: chatbox.chatboxId,
              name: trimmedName,
              description: description.trim() || undefined,
              namedHostId,
            })
          : await createChatbox({
              projectId,
              name: trimmedName,
              description: description.trim() || undefined,
              namedHostId,
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
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {chatbox ? "Edit Chatbox" : "Create Chatbox"}
          </DialogTitle>
          <DialogDescription>
            Chatboxes reuse a project host for their execution config. To
            change the model, prompt, or servers, edit the host.
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
            <Label>Host</Label>
            <HostPicker
              projectId={projectId}
              value={namedHostId}
              onChange={setNamedHostId}
              placeholder="Pick a host for this chatbox"
              includeNone={false}
              noneLabel="No host"
            />
            <p className="text-xs text-muted-foreground">
              Model, system prompt, and servers come from the host. Open the
              Hosts tab to edit them.
            </p>
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
