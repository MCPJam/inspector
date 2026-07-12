import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "@/lib/toast";
import { useConvexAuth } from "convex/react";
import { track } from "@/lib/analytics";
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
import { useCodexHostEnabled } from "@/hooks/useCodexHostEnabled";
import { cloneHostTemplateInput } from "@/lib/client-config-v2";
import { useHostCatalog } from "@/lib/host-compat/use-host-catalog";
import { usePreferencesStore } from "@/stores/preferences/preferences-provider";
import { cn } from "@/lib/utils";
import {
  getCatalogHost,
  getCatalogHosts,
  getCatalogTemplate,
} from "@mcpjam/sdk/host-compat";
import {
  DEFAULT_CATALOG_HOST_ID,
  getHostLogoSrc,
} from "@/lib/host-ui-metadata";
import { filterHostsByFeatureFlags } from "@/lib/host-compat/feature-visibility";

interface CreateHostDialogProps {
  isOpen: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: (hostId: string) => void;
  initialTemplateId?: string;
}

export function CreateHostDialog({
  isOpen,
  onClose,
  projectId,
  onCreated,
  initialTemplateId,
}: CreateHostDialogProps) {
  const { createHost } = useHostMutations();
  const { isAuthenticated } = useConvexAuth();
  const { servers } = useProjectServers({ isAuthenticated, projectId });
  const themeMode = usePreferencesStore((s) => s.themeMode);
  const catalogState = useHostCatalog();
  const claudeCodeEnabled = useClaudeCodeHostEnabled();
  const codexEnabled = useCodexHostEnabled();
  const visibleCatalogHosts = useMemo(
    () =>
      catalogState.status === "live"
        ? filterHostsByFeatureFlags(getCatalogHosts(catalogState.catalog), {
            claudeCode: claudeCodeEnabled,
            codex: codexEnabled,
          }).sort((a, b) => a.label.localeCompare(b.label))
        : [],
    [catalogState, claudeCodeEnabled, codexEnabled]
  );
  const defaultHostId =
    visibleCatalogHosts.find((host) => host.id === DEFAULT_CATALOG_HOST_ID)
      ?.id ??
    visibleCatalogHosts[0]?.id ??
    DEFAULT_CATALOG_HOST_ID;
  const visibleHostIds = useMemo(
    () => new Set(visibleCatalogHosts.map((host) => host.id)),
    [visibleCatalogHosts]
  );
  const [name, setName] = useState("");
  // True once the user hand-types a (non-empty) name; the template-label
  // defaulting effect below must not clobber it. Tracked outside the
  // setName updater: mutating a ref inside an updater is impure, and
  // StrictMode's double-invoke made the old ref-inside-updater guard
  // misread the defaulted name as user-typed, pinning it forever.
  const userEditedNameRef = useRef(false);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(
    initialTemplateId ?? DEFAULT_CATALOG_HOST_ID
  );
  const [isSaving, setIsSaving] = useState(false);
  const selectedTemplateInput =
    catalogState.status === "live"
      ? getCatalogTemplate(catalogState.catalog, selectedTemplateId)
      : undefined;
  const selectedTemplateLabel =
    (catalogState.status === "live"
      ? getCatalogHost(catalogState.catalog, selectedTemplateId)?.label
      : undefined) ?? "";
  const templatesUnavailableMessage =
    catalogState.status === "loading"
      ? "Loading client templates..."
      : catalogState.status === "fallback" || catalogState.status === "error"
      ? "Could not load live client templates."
      : !selectedTemplateInput
      ? "Selected client template is unavailable."
      : null;
  const canCreate =
    Boolean(name.trim()) &&
    !isSaving &&
    catalogState.status === "live" &&
    Boolean(selectedTemplateInput);

  useEffect(() => {
    if (!isOpen) return;
    if (visibleCatalogHosts.length === 0) return;
    const requested = initialTemplateId ?? DEFAULT_CATALOG_HOST_ID;
    const allowed = visibleHostIds.has(requested);
    setSelectedTemplateId(allowed ? requested : defaultHostId);
  }, [isOpen, initialTemplateId, visibleCatalogHosts.length, visibleHostIds, defaultHostId]);

  useEffect(() => {
    if (!isOpen) return;
    if (userEditedNameRef.current) return;
    setName(selectedTemplateLabel);
  }, [isOpen, selectedTemplateId, selectedTemplateLabel]);

  const handleClose = () => {
    setName("");
    userEditedNameRef.current = false;
    setSelectedTemplateId(initialTemplateId ?? DEFAULT_CATALOG_HOST_ID);
    onClose();
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || !selectedTemplateInput || catalogState.status !== "live") {
      if (trimmed && catalogState.status !== "loading") {
        toast.error("Could not load live client templates");
      }
      return;
    }
    setIsSaving(true);
    try {
      // New hosts start with no seeded servers: keeps creation deliberate.
      // Users opt servers in afterward via the Servers tab on the host.
      //
      // Historical context: this used to guard against an auto-connect
      // storm. The current auto-connect toggle is project-scoped (see
      // preferences-store.ts:40), so the original storm risk is gone,
      // but the deliberate-creation framing stays.
      const seed = cloneHostTemplateInput(selectedTemplateInput, { themeMode });
      // Capture available-server count for analytics (we don't attach
      // them — see above — but knowing the count at creation time is
      // useful signal for onboarding funnels).
      const projectServerIds = servers?.map((s) => s._id) ?? [];
      const { hostId, hostConfigId } = await createHost({
        projectId,
        name: trimmed,
        input: { ...seed, serverIds: [] },
      });
      toast.success(`Client "${trimmed}" created`);
      handleClose();
      onCreated(hostId);
      // Telemetry is best-effort: a posthog throw must not bubble into the
      // shared catch and surface a "creation failed" toast after we've
      // already shown success and notified the caller.
      try {
        track("client_created", {
          location: "create_client_dialog",
          client_id: hostId,
          client_config_id: hostConfigId,
          template_id: selectedTemplateId,
          server_count: projectServerIds.length,
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
              {visibleCatalogHosts.map((host) => {
                const isSelected = host.id === selectedTemplateId;
                const templateAvailable =
                  catalogState.status === "live" &&
                  getCatalogTemplate(catalogState.catalog, host.id) !==
                    undefined;
                return (
                  <button
                    key={host.id}
                    type="button"
                    onClick={() => setSelectedTemplateId(host.id)}
                    disabled={!templateAvailable}
                    className={cn(
                      "flex flex-col items-start gap-2 rounded-md border p-3 text-left transition-colors",
                      isSelected
                        ? "border-primary ring-2 ring-primary/30 bg-accent"
                        : "border-border hover:bg-accent/50",
                      !templateAvailable && "cursor-not-allowed opacity-50"
                    )}
                    aria-pressed={isSelected}
                  >
                    <img
                      src={getHostLogoSrc(host.id, themeMode)}
                      alt=""
                      className="h-6 w-6 object-contain"
                    />
                    <span className="text-sm font-medium leading-none">
                      {host.label}
                    </span>
                  </button>
                );
              })}
            </div>
            {templatesUnavailableMessage && (
              <p className="text-xs text-muted-foreground">
                {templatesUnavailableMessage}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="host-name">Name</Label>
            <Input
              id="host-name"
              placeholder="My Client"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                // Clearing the field re-arms template defaulting.
                userEditedNameRef.current = e.target.value.trim() !== "";
              }}
              onKeyDown={(e) =>
                e.key === "Enter" && canCreate && handleCreate()
              }
              autoFocus
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={handleCreate} disabled={!canCreate}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
