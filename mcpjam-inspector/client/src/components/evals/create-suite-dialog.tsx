import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@mcpjam/design-system/dialog";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Textarea } from "@mcpjam/design-system/textarea";
import { Checkbox } from "@mcpjam/design-system/checkbox";
import { Label } from "@mcpjam/design-system/label";
import {
  buildSuiteEnvironmentOptions,
  normalizeServerNames,
  type ProjectServerRecord,
} from "./suite-environment-utils";
import { useHost } from "@/hooks/useHosts";
import { useConvexAuth } from "convex/react";
import { HostPicker } from "@/components/hosts/HostPicker";
import { hostConfigDtoToInput } from "@/lib/host-config-v2";

export type CreateSuitePayload = {
  name: string;
  description?: string;
  selectedServers: string[];
  namedHostId?: string;
  hostConfigInput?: ReturnType<typeof hostConfigDtoToInput>;
};

type CreateSuiteDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectServers: ProjectServerRecord[];
  connectedServerNames: ReadonlySet<string>;
  onSubmit: (payload: CreateSuitePayload) => Promise<void>;
  hostsEnabled?: boolean;
  projectId?: string | null;
};

export function CreateSuiteDialog({
  open,
  onOpenChange,
  projectServers,
  connectedServerNames,
  onSubmit,
  hostsEnabled = false,
  projectId = null,
}: CreateSuiteDialogProps) {
  const { isAuthenticated } = useConvexAuth();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selectedServers, setSelectedServers] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [selectedHostId, setSelectedHostId] = useState<string | null>(null);
  const { host: selectedHost } = useHost({
    isAuthenticated: isAuthenticated && hostsEnabled,
    hostId: selectedHostId,
  });

  useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
      setSelectedServers([]);
      setIsSaving(false);
      setSelectedHostId(null);
    }
  }, [open]);

  // Seed server selection from selected host
  useEffect(() => {
    if (!selectedHost) return;
    const serverNames = selectedHost.config.serverIds
      .map((id) => {
        const found = projectServers.find((s) => s._id === id);
        return found?.name ?? null;
      })
      .filter((n): n is string => n !== null);
    setSelectedServers(serverNames);
  }, [selectedHost, projectServers]);

  const options = useMemo(
    () =>
      buildSuiteEnvironmentOptions({
        configuredServers: [],
        projectServers,
        connectedServerNames,
      }),
    [projectServers, connectedServerNames],
  );

  const canSubmit = name.trim().length > 0 && !isSaving;

  const toggleServer = (serverName: string, checked: boolean) => {
    setSelectedServers((current) => {
      if (checked) {
        return current.includes(serverName) ? current : [...current, serverName];
      }
      return current.filter((candidate) => candidate !== serverName);
    });
  };

  const handleSubmit = async () => {
    if (!canSubmit) {
      return;
    }

    setIsSaving(true);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim() || undefined,
        selectedServers: normalizeServerNames(selectedServers),
        ...(selectedHost && selectedHostId
          ? {
              namedHostId: selectedHostId,
              hostConfigInput: hostConfigDtoToInput(selectedHost.config),
            }
          : {}),
      });
    } catch {
      // onSubmit surfaces its own error toast; keep the dialog open so the
      // user can retry, but don't propagate as an unhandled rejection.
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Create suite</DialogTitle>
          <DialogDescription>
            Create a suite first, then attach servers, generate cases, or import
            a chat transcript into it.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {hostsEnabled && projectId && (
            <div className="grid gap-2">
              <Label>Seed from host (optional)</Label>
              <HostPicker
                projectId={projectId}
                value={selectedHostId}
                onChange={setSelectedHostId}
                placeholder="Choose a host to pre-fill servers"
                includeNone={false}
                noneLabel="No host"
              />
              {selectedHostId && (
                <p className="text-xs text-muted-foreground">
                  Server selection pre-filled from host. You can still adjust it
                  below.
                </p>
              )}
            </div>
          )}

          <div className="grid gap-2">
            <label className="text-sm font-medium text-foreground">
              Suite name
            </label>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Customer support workflows"
            />
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-medium text-foreground">
              Description
            </label>
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Optional context for what this suite covers."
            />
          </div>

          <div className="space-y-2">
            <div>
              <h3 className="text-sm font-medium text-foreground">Servers</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Suites own their server environment. You can update this later
                from suite settings.
              </p>
            </div>

            {options.length === 0 ? (
              <div className="rounded-lg border border-dashed px-4 py-5 text-sm text-muted-foreground">
                No project servers are available yet. You can still create the
                suite now and configure servers later.
              </div>
            ) : (
              <div className="max-h-64 space-y-2 overflow-y-auto rounded-xl border bg-card/60 p-3">
                {options.map((option) => {
                  const isSelected = selectedServers.includes(option.name);
                  return (
                    <label
                      key={option.name}
                      className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 transition-colors hover:bg-accent/35"
                    >
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={(checked) =>
                          toggleServer(option.name, checked === true)
                        }
                        className="mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {option.name}
                          </span>
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                            {option.isConnected ? "Connected" : "Disconnected"}
                          </span>
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Cancel
          </Button>
          <Button type="button" onClick={() => void handleSubmit()} disabled={!canSubmit}>
            {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Create suite
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
