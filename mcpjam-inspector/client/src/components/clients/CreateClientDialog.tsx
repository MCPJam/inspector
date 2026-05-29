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
import { Checkbox } from "@mcpjam/design-system/checkbox";
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
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { cn } from "@/lib/utils";

export type CreateClientCallbackOptions = {
  /**
   * When the caller provided `prefillServersOption` and the user checked
   * the prefill box, these are the server IDs that were seeded into the
   * new client's `optionalServerIds`. Callers can use them to pre-enable
   * the corresponding optional toggles on whatever attachment they
   * create from the new host.
   */
  prefilledOptionalServerIds?: string[];
};

export type CreateClientPrefillOption = {
  /** Visible label, e.g. `"Pre-attach the suite's servers (3)"`. */
  label: string;
  /** Initial checked state of the prefill checkbox. Default `false`. */
  defaultChecked: boolean;
  /** Server IDs to seed as optionals when the checkbox is checked at submit time. */
  serverIds: string[];
};

interface CreateHostDialogProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: (hostId: string, opts?: CreateClientCallbackOptions) => void;
  initialTemplateId?: HostTemplateId;
  /**
   * When supplied, the dialog renders an opt-in checkbox between the Name
   * input and the footer. If checked at submit time, the server IDs are
   * seeded into the new client's `optionalServerIds` (not `serverIds`).
   * When undefined, the dialog behaves exactly as before — no checkbox,
   * `serverIds: []`, `optionalServerIds: []`.
   */
  prefillServersOption?: CreateClientPrefillOption;
}

export function CreateClientDialog({
  isOpen,
  onClose,
  projectId,
  onCreated,
  initialTemplateId,
  prefillServersOption,
}: CreateHostDialogProps) {
  const posthog = usePostHog();
  const { createHost } = useHostMutations();
  const { isAuthenticated } = useConvexAuth();
  const { servers } = useProjectServers({ isAuthenticated, projectId });
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const [name, setName] = useState("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<HostTemplateId>(
    initialTemplateId ?? DEFAULT_HOST_TEMPLATE_ID,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [prefillChecked, setPrefillChecked] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setSelectedTemplateId(initialTemplateId ?? DEFAULT_HOST_TEMPLATE_ID);
    setPrefillChecked(prefillServersOption?.defaultChecked ?? false);
  }, [isOpen, initialTemplateId, prefillServersOption?.defaultChecked]);

  useEffect(() => {
    if (!isOpen) return;
    const template = HOST_TEMPLATES.find((t) => t.id === selectedTemplateId);
    setName(template?.label ?? "");
  }, [isOpen, selectedTemplateId]);

  const handleClose = () => {
    setName("");
    setSelectedTemplateId(initialTemplateId ?? DEFAULT_HOST_TEMPLATE_ID);
    setPrefillChecked(false);
    onClose();
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setIsSaving(true);
    try {
      // Default to no seeded servers: keeps creation deliberate. Callers
      // that have a clear server scope (e.g. the suite-attachment editor)
      // can pass `prefillServersOption`; when checked at submit time we
      // seed those IDs as optionals — not required — so the user can
      // toggle them off in place wherever they land.
      //
      // Historically this guarded against an auto-connect storm; the
      // current auto-connect toggle is project-scoped (see
      // preferences-store.ts:40) so the original storm risk is gone,
      // but the deliberate-creation framing stays.
      //
      // Thread MCPJam's current global theme into the seed so the new
      // host opens matching the inspector chrome instead of always
      // defaulting to dark — user can still flip it later from the host
      // editor.
      const seed = seedFromHostTemplate(selectedTemplateId, {
        theme: themeMode,
      });
      const prefilledOptionalServerIds =
        prefillServersOption && prefillChecked
          ? [...prefillServersOption.serverIds]
          : [];
      // Capture available-server count for analytics (independent of
      // whether we prefilled — knowing project size at creation time is
      // useful onboarding signal).
      const projectServerIds = servers?.map((s) => s._id) ?? [];
      const { hostId, hostConfigId } = await createHost({
        projectId,
        name: trimmed,
        input: {
          ...seed,
          serverIds: [],
          optionalServerIds: prefilledOptionalServerIds,
        },
      });
      toast.success(`Client "${trimmed}" created`);
      handleClose();
      onCreated(hostId, { prefilledOptionalServerIds });
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
          prefilled_server_count: prefilledOptionalServerIds.length,
        });
      } catch {
        // swallow — analytics must not block the success path
      }
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
          {prefillServersOption ? (
            <label className="flex cursor-pointer items-start gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
              <Checkbox
                checked={prefillChecked}
                onCheckedChange={(checked) =>
                  setPrefillChecked(checked === true)
                }
                disabled={isSaving}
                className="mt-0.5"
              />
              <span className="leading-snug">
                {prefillServersOption.label}
                <span className="ml-1 text-xs text-muted-foreground">
                  — added as optional, you can untoggle any later.
                </span>
              </span>
            </label>
          ) : null}
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
