import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { useConvexAuth } from "convex/react";
import { ReactFlowProvider } from "@xyflow/react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Skeleton } from "@mcpjam/design-system/skeleton";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useHost, useHostMutations } from "@/hooks/useHosts";
import { useProjectServers, useServerMutations } from "@/hooks/useProjects";
import {
  hostConfigDtoToInput,
  hostConfigInputsEqual,
  serverConnectionOverridesEqual,
  type HostConfigInputV2,
} from "@/lib/host-config-v2";
import { AddServerModal } from "@/components/connection/AddServerModal";
import type { ServerFormData } from "@/shared/types";
import { getBillingErrorMessage } from "@/lib/billing-entitlements";
import { buildHostCanvas } from "./hostCanvasBuilder";
import { HostCanvas } from "./HostCanvas";
import {
  HostSetupChecklistPanel,
} from "./HostSetupChecklistPanel";
import type { HostSetupSectionId } from "./host-builder-types";

interface HostBuilderViewProps {
  hostId: string;
  projectId: string;
  onBack: () => void;
}

function HostBuilderChrome({
  draftName,
  onDraftNameChange,
  isDirty,
  isSaving,
  canSave,
  onBack,
  onSave,
}: {
  draftName: string;
  onDraftNameChange: (value: string) => void;
  isDirty: boolean;
  isSaving: boolean;
  canSave: boolean;
  onBack: () => void;
  onSave: () => void;
}) {
  const saveDisabled = !canSave;
  const saveLabel = isDirty ? "Save changes" : "Save";
  return (
    <div className="shrink-0 border-b border-border/70 px-6 py-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] md:items-center md:gap-x-4 md:gap-y-0">
        <div className="order-1 flex min-w-0 items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 rounded-xl"
            onClick={onBack}
            aria-label="Return to hosts"
            title="Return to hosts"
          >
            <ArrowLeft className="size-4" aria-hidden />
          </Button>
          <Input
            className="h-9 max-w-md border-transparent bg-transparent text-xl font-semibold shadow-none focus-visible:border-input focus-visible:bg-background"
            value={draftName}
            onChange={(event) => onDraftNameChange(event.target.value)}
            placeholder="Host name"
          />
        </div>

        <div className="hidden md:block" />

        <div className="order-2 flex flex-wrap items-center justify-end gap-2 md:order-3">
          <Button
            onClick={onSave}
            disabled={saveDisabled}
            variant={!isDirty ? "ghost" : "default"}
            className="rounded-xl"
          >
            {isSaving ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : (
              <Save className="mr-1.5 size-4" />
            )}
            {saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function HostBuilderView({
  hostId,
  projectId,
  onBack,
}: HostBuilderViewProps) {
  const { isAuthenticated } = useConvexAuth();
  const { host, isLoading: hostLoading } = useHost({ isAuthenticated, hostId });
  const { servers } = useProjectServers({ projectId, isAuthenticated });
  const { updateHost } = useHostMutations();
  const { createServer } = useServerMutations();

  const [draftName, setDraftName] = useState("");
  const [draftConfig, setDraftConfig] = useState<HostConfigInputV2 | null>(
    null,
  );
  const [isSaving, setIsSaving] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [showAddServer, setShowAddServer] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>("host");
  const [focusedSetupSection, setFocusedSetupSection] =
    useState<HostSetupSectionId | null>(null);

  // Seed draft state from the loaded host.
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

  const availableServers = useMemo(
    () => servers?.map((s) => ({ id: s._id, name: s.name })) ?? [],
    [servers],
  );

  const availableServersForCanvas = useMemo(
    () =>
      servers?.map((s) => ({
        id: s._id,
        name: s.name,
        url: s.url ?? undefined,
      })) ?? [],
    [servers],
  );

  const viewModel = useMemo(
    () =>
      buildHostCanvas({
        hostName: draftName,
        draft:
          draftConfig ??
          ({
            hostStyle: "claude",
            modelId: "",
            systemPrompt: "",
            temperature: 0.7,
            requireToolApproval: false,
            serverIds: [],
            optionalServerIds: [],
            connectionDefaults: { headers: {}, requestTimeout: 30000 },
            clientCapabilities: {},
            hostContext: {},
          } as HostConfigInputV2),
        projectServers: availableServersForCanvas,
      }),
    [draftName, draftConfig, availableServersForCanvas],
  );

  const handleSelectNode = useCallback((nodeId: string) => {
    if (nodeId === "host") {
      setSelectedNodeId("host");
      setFocusedSetupSection("basics");
      return;
    }
    if (nodeId.startsWith("server:")) {
      setSelectedNodeId(nodeId);
      setFocusedSetupSection("servers");
      return;
    }
    if (nodeId === "add-server") {
      setShowAddServer(true);
    }
  }, []);

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
        setDraftConfig((prev) =>
          prev
            ? { ...prev, serverIds: [...(prev.serverIds ?? []), serverId] }
            : prev,
        );
        setSelectedNodeId(`server:${serverId}`);
        setFocusedSetupSection("servers");
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

  const canSave = isDirty && !isSaving && !hasError;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <HostBuilderChrome
        draftName={draftName}
        onDraftNameChange={setDraftName}
        isDirty={isDirty}
        isSaving={isSaving}
        canSave={canSave}
        onBack={onBack}
        onSave={() => void handleSave()}
      />

      <div className="relative min-h-0 flex-1 p-4">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel defaultSize={50} minSize={30}>
            <div className="h-full min-h-0 pr-2">
              <ReactFlowProvider>
                <HostCanvas
                  viewModel={viewModel}
                  selectedNodeId={selectedNodeId}
                  onSelectNode={handleSelectNode}
                  onClearSelection={() => setSelectedNodeId(null)}
                  onAddServer={() => setShowAddServer(true)}
                />
              </ReactFlowProvider>
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={50} minSize={30}>
            <div className="flex h-full min-h-0 flex-col border-l border-border/70">
              <HostSetupChecklistPanel
                draft={draftConfig}
                onDraftChange={(updater) =>
                  setDraftConfig((prev) => (prev ? updater(prev) : prev))
                }
                availableServers={availableServers}
                focusedSection={focusedSetupSection}
                onValidityChange={setHasError}
                onOpenAddServer={() => setShowAddServer(true)}
              />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

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
