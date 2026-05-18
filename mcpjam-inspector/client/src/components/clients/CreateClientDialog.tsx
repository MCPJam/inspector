import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useConvexAuth } from "convex/react";
import { usePostHog } from "posthog-js/react";
import { detectEnvironment, detectPlatform } from "@/lib/PosthogUtils";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { useHostMutations } from "@/hooks/useClients";
import { useProjectServers } from "@/hooks/useViews";
import {
  DEFAULT_HOST_TEMPLATE_ID,
  HOST_TEMPLATES,
  seedFromHostTemplate,
  type HostTemplateId,
} from "@/lib/client-templates";
import { cn } from "@/lib/utils";

interface CreateHostDialogProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: (hostId: string) => void;
}

export function CreateClientDialog({
  isOpen,
  onClose,
  projectId,
  onCreated,
}: CreateHostDialogProps) {
  const posthog = usePostHog();
  const { createHost } = useHostMutations();
  const { isAuthenticated } = useConvexAuth();
  const { servers } = useProjectServers({ isAuthenticated, projectId });
  const [name, setName] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<HostTemplateId>(
    DEFAULT_HOST_TEMPLATE_ID,
  );
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const template = HOST_TEMPLATES.find((t) => t.id === selectedTemplateId);
    setName(template?.label ?? "");
  }, [isOpen, selectedTemplateId]);

  const handleClose = () => {
    setName("");
    setSelectedTemplateId(DEFAULT_HOST_TEMPLATE_ID);
    onClose();
  };

  // `useProjectServers` returns `undefined` while loading and `[]` for a
  // truly empty project. Collapsing both into `[]` at create-time would
  // silently seed the host with zero attachments whenever the user
  // clicked Create before the query resolved — the host never self-
  // corrects, so the only fix is a manual edit in the host tab. Gate the
  // Create button on `servers !== undefined` so the loading window
  // disables the action instead of producing a wrong host. The auth gate
  // matches `useProjectServers`'s own skip rule: unauthenticated users
  // never fire the query, so "loading" can't apply to them.
  const isServersLoading = isAuthenticated && servers === undefined;

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (isServersLoading) {
      toast.error("Still loading project servers. Try again in a moment.");
      return;
    }
    setIsSaving(true);
    try {
      // Pre-attach every existing project server as required so the new
      // host's Servers tab opens with checkboxes filled in instead of
      // every server reading "optional / uses defaults".
      const seed = seedFromHostTemplate(selectedTemplateId);
      // `isServersLoading` already guards the authenticated-loading case;
      // for unauthenticated callers the query is skipped so `servers` is
      // undefined and we seed with no attachments.
      const projectServerIds = servers?.map((s) => s._id) ?? [];
      const { hostId, hostConfigId } = await createHost({
        projectId,
        name: trimmed,
        input: { ...seed, serverIds: projectServerIds },
      });
      posthog.capture("client_created", {
        location: "create_client_dialog",
        platform: detectPlatform(),
        environment: detectEnvironment(),
        client_id: hostId,
        client_config_id: hostConfigId,
        template_id: selectedTemplateId,
        server_count: projectServerIds.length,
      });
      toast.success(`Client "${trimmed}" created`);
      handleClose();
      onCreated(hostId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create client");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Client</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label>Start from template</Label>
            <div className="grid grid-cols-3 gap-2">
              {HOST_TEMPLATES.map((template) => {
                const isSelected = template.id === selectedTemplateId;
                return (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => setSelectedTemplateId(template.id)}
                    className={cn(
                      "flex flex-col items-start gap-2 rounded-md border p-3 text-left transition-colors",
                      isSelected
                        ? "border-primary ring-2 ring-primary/30 bg-accent"
                        : "border-border hover:bg-accent/50",
                    )}
                    aria-pressed={isSelected}
                  >
                    <img
                      src={template.logoSrc}
                      alt=""
                      className="h-6 w-6 object-contain"
                    />
                    <span className="text-sm font-medium leading-none">
                      {template.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="host-name">Name</Label>
            <Input
              id="host-name"
              placeholder="My Client"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              autoFocus
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!name.trim() || isSaving || isServersLoading}
          >
            {(isSaving || isServersLoading) && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
