import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useConvexAuth } from "convex/react";
import { usePostHog } from "posthog-js/react";
import { standardEventProps } from "@/lib/PosthogUtils";
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
import { useClaudeCodeHostEnabled } from "@/hooks/useClaudeCodeHostEnabled";
import {
  DEFAULT_HOST_TEMPLATE_ID,
  HOST_TEMPLATES,
  seedFromHostTemplate,
  type HostTemplateId,
} from "@/lib/client-templates";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { cn } from "@/lib/utils";

interface CreateHostDialogProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: (hostId: string) => void;
  initialTemplateId?: HostTemplateId;
}

export function CreateHostDialog({
  isOpen,
  onClose,
  projectId,
  onCreated,
  initialTemplateId,
}: CreateHostDialogProps) {
  const posthog = usePostHog();
  const { createHost } = useHostMutations();
  const { isAuthenticated } = useConvexAuth();
  const { servers } = useProjectServers({ isAuthenticated, projectId });
  const themeMode = usePreferencesStore((s) => s.themeMode);
  // The Claude Code host template is gated behind a PostHog flag while the
  // CLI host profile is iterated on. Off ⇒ drop it from the picker grid.
  // claude-code is never a default or `initialTemplateId` (no caller seeds
  // it), so hiding it here can't strand the selection on a missing tile.
  const claudeCodeEnabled = useClaudeCodeHostEnabled();
  const visibleTemplates = HOST_TEMPLATES.filter(
    (t) => t.id !== "claude-code" || claudeCodeEnabled,
  );
  const [name, setName] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<HostTemplateId>(
    initialTemplateId ?? DEFAULT_HOST_TEMPLATE_ID,
  );
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedTemplateId(initialTemplateId ?? DEFAULT_HOST_TEMPLATE_ID);
  }, [isOpen, initialTemplateId]);

  useEffect(() => {
    if (!isOpen) return;
    const template = HOST_TEMPLATES.find((t) => t.id === selectedTemplateId);
    setName(template?.label ?? "");
  }, [isOpen, selectedTemplateId]);

  const handleClose = () => {
    setName("");
    setSelectedTemplateId(initialTemplateId ?? DEFAULT_HOST_TEMPLATE_ID);
    onClose();
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setIsSaving(true);
    try {
      // New hosts start with no seeded servers: keeps creation deliberate.
      // Users opt servers in afterward via the Servers tab on the host.
      //
      // Historical context: this used to guard against an auto-connect
      // storm. The current auto-connect toggle is project-scoped (see
      // preferences-store.ts:40), so the original storm risk is gone,
      // but the deliberate-creation framing stays.
      //
      // Thread MCPJam's current global theme into the seed so the new
      // host opens matching the inspector chrome instead of always
      // defaulting to dark — user can still flip it later from the host
      // editor.
      const seed = seedFromHostTemplate(selectedTemplateId, {
        theme: themeMode,
      });
      // Capture available-server count for analytics (we don't attach
      // them — see above — but knowing the count at creation time is
      // useful signal for onboarding funnels).
      const projectServerIds = servers?.map((s) => s._id) ?? [];
      const { hostId, hostConfigId } = await createHost({
        projectId,
        name: trimmed,
        input: { ...seed, serverIds: [] },
      });
      toast.success(`Host "${trimmed}" created`);
      handleClose();
      onCreated(hostId);
      // Telemetry is best-effort: a posthog throw must not bubble into the
      // shared catch and surface a "creation failed" toast after we've
      // already shown success and notified the caller.
      try {
        posthog.capture("client_created", {
          ...standardEventProps("create_client_dialog"),
          client_id: hostId,
          client_config_id: hostConfigId,
          template_id: selectedTemplateId,
          server_count: projectServerIds.length,
        });
      } catch {
        // swallow — analytics must not block the success path
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create host");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New Host</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <Label>Start from template</Label>
            <div className="grid grid-cols-3 gap-2">
              {visibleTemplates.map((template) => {
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
              placeholder="My Host"
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
            disabled={!name.trim() || isSaving}
          >
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
