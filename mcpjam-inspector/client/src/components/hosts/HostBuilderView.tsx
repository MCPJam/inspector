import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { useConvexAuth } from "convex/react";
import { ReactFlowProvider } from "@xyflow/react";
import { useFeatureFlagEnabled } from "posthog-js/react";
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
import { HostBuilderViewRedesigned } from "./redesigned/HostBuilderViewRedesigned";

interface HostBuilderViewProps {
  hostId: string;
  projectId: string;
  onBack: () => void;
  /** When set, the redesigned builder shows a host switcher in the header. */
  onSwitchHost?: (hostId: string) => void;
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
    <div className="shrink-0 border-b border-border/40 px-8 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={onBack}
            aria-label="Return to hosts"
            title="Return to hosts"
          >
            <ArrowLeft className="size-4" aria-hidden />
          </Button>
          <Input
            className="h-8 min-w-0 max-w-md flex-1 border-0 bg-transparent px-1 text-base font-semibold tracking-tight shadow-none placeholder:text-muted-foreground focus-visible:border-transparent focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring/45 md:text-base"
            value={draftName}
            onChange={(event) => onDraftNameChange(event.target.value)}
            placeholder="Host name"
          />
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Button
            size="sm"
            onClick={onSave}
            disabled={saveDisabled}
            variant={isDirty ? "default" : "ghost"}
            className={
              isDirty
                ? undefined
                : "text-muted-foreground hover:text-foreground disabled:opacity-40"
            }
          >
            {isSaving ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            {saveLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function HostBuilderView(props: HostBuilderViewProps) {
  const hostsEnabled = useFeatureFlagEnabled("hosts-enabled");
  if (hostsEnabled) {
    return <HostBuilderViewRedesigned {...props} />;
  }
  return <HostBuilderViewLegacy {...props} />;
}

function HostBuilderViewLegacy({
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
