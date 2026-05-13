import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2, Save, Server } from "lucide-react";
import { toast } from "sonner";
import { useConvexAuth } from "convex/react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { HostConfigEditor } from "@/components/host-config/HostConfigEditor";
import { useHost, useHostMutations } from "@/hooks/useHosts";
import { useProjectServers } from "@/hooks/useProjects";
import {
  hostConfigDtoToInput,
  hostConfigInputsEqual,
  serverConnectionOverridesEqual,
  type HostConfigInputV2,
} from "@/lib/host-config-v2";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import { AddServerModal } from "@/components/connection/AddServerModal";
import { useServerMutations } from "@/hooks/useProjects";
import type { ServerFormData } from "@/shared/types";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { ServerConnectionOverrideSection } from "./ServerConnectionOverrideSection";

interface HostBuilderViewProps {
  hostId: string;
  projectId: string;
  onBack: () => void;
}

export function HostBuilderView({ hostId, projectId, onBack }: HostBuilderViewProps) {
  const { isAuthenticated } = useConvexAuth();
  const { host, isLoading: hostLoading } = useHost({ isAuthenticated, hostId });
  const { servers } = useProjectServers({ projectId, isAuthenticated });
  const { updateHost } = useHostMutations();
  const { createServer } = useServerMutations();

  const [draftName, setDraftName] = useState("");
  const [draftConfig, setDraftConfig] = useState<HostConfigInputV2 | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [showAddServer, setShowAddServer] = useState(false);

  useEffect(() => {
    if (!host) return;
    setDraftName(host.name);
    setDraftConfig(hostConfigDtoToInput(host.config));
  }, [host]);

  const savedConfig = useMemo(
    () => (host ? hostConfigDtoToInput(host.config) : null),
    [host],
  );

  const isDirty = useMemo(() => {
    if (!host || !draftConfig || !savedConfig) return false;
    return (
      draftName !== host.name ||
      !hostConfigInputsEqual(draftConfig, savedConfig) ||
      !serverConnectionOverridesEqual(
        draftConfig.serverConnectionOverrides,
        savedConfig.serverConnectionOverrides,
      )
    );
  }, [host, draftName, draftConfig, savedConfig]);

  const handleSave = useCallback(async () => {
    if (!draftConfig) return;
    setIsSaving(true);
    try {
      await updateHost({ hostId, name: draftName, input: draftConfig });
      toast.success("Host saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save host");
    } finally {
      setIsSaving(false);
    }
  }, [hostId, draftName, draftConfig, updateHost]);

  const handleAddServer = useCallback(
    async (formData: ServerFormData) => {
      try {
        const serverId = (await createServer({
          projectId,
          name: formData.name,
          enabled: true,
          transportType: formData.type === "stdio" ? "stdio" : "http",
          url: formData.url,
          headers: formData.headers,
          timeout: formData.requestTimeout,
          useOAuth: formData.useOAuth,
          oauthScopes: formData.oauthScopes,
          clientId: formData.clientId,
        })) as string;
        // auto-select newly added server
        setDraftConfig((prev) =>
          prev
            ? { ...prev, serverIds: [...(prev.serverIds ?? []), serverId] }
            : prev,
        );
        toast.success(`Server "${formData.name}" added`);
      } catch (err) {
        toast.error(getBillingErrorMessage(err, "Failed to add server"));
      }
    },
    [createServer, projectId],
  );

  if (hostLoading || !draftConfig) {
    return (
      <div className="flex flex-col gap-4 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const availableServers =
    servers?.map((s) => ({ id: s._id, name: s.name })) ?? [];

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <Button variant="ghost" size="icon" onClick={onBack} className="h-8 w-8">
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <Input
          className="h-8 max-w-xs border-transparent bg-transparent text-base font-semibold shadow-none focus-visible:border-input focus-visible:bg-background"
          value={draftName}
          onChange={(e) => setDraftName(e.target.value)}
          placeholder="Host name"
        />
        <div className="flex-1" />
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!isDirty || isSaving || hasError}
        >
          {isSaving ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Save className="mr-2 h-4 w-4" />
          )}
          Save
        </Button>
      </div>

      {/* Body */}
      <ResizablePanelGroup direction="horizontal" className="flex-1 overflow-hidden">
        {/* Left: server list + overrides */}
        <ResizablePanel defaultSize={50} minSize={30}>
          <div className="flex h-full flex-col overflow-y-auto p-4 gap-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Servers</h2>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowAddServer(true)}
              >
                <Server className="mr-2 h-4 w-4" />
                Add Server
              </Button>
            </div>
            <ServerConnectionOverrideSection
              serverIds={draftConfig.serverIds ?? []}
              optionalServerIds={draftConfig.optionalServerIds ?? []}
              projectServers={availableServers}
              overrides={draftConfig.serverConnectionOverrides ?? {}}
              onChange={(overrides) =>
                setDraftConfig((prev) =>
                  prev ? { ...prev, serverConnectionOverrides: overrides } : prev,
                )
              }
              onServerSelectionChange={(serverIds, optionalServerIds) =>
                setDraftConfig((prev) =>
                  prev ? { ...prev, serverIds, optionalServerIds } : prev,
                )
              }
            />
          </div>
        </ResizablePanel>

        <ResizableHandle withHandle />

        {/* Right: config editor */}
        <ResizablePanel defaultSize={50} minSize={30}>
          <div className="h-full overflow-y-auto p-4">
            <HostConfigEditor
              value={draftConfig}
              onChange={(next) => setDraftConfig(next)}
              owner="host"
              availableServers={availableServers}
              onValidityChange={setHasError}
            />
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>

      {showAddServer && (
        <AddServerModal
          isOpen={showAddServer}
          onClose={() => setShowAddServer(false)}
          onSubmit={handleAddServer}
        />
      )}
    </div>
  );
}
