import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import type { ServerWithName } from "@/hooks/use-app-state";
import { XAASequenceDiagram } from "./XAASequenceDiagram";
import { XAAFlowLogger } from "./XAAFlowLogger";
import { XAAConfigModal } from "./XAAConfigModal";
import {
  createInitialXAAFlowState,
  type XAAFlowState,
  type XAAFlowStep,
} from "@/lib/xaa/types";
import {
  deriveXAADebugProfileFromServer,
  loadStoredXAADebugProfile,
  saveStoredXAADebugProfile,
  type XAADebugProfile,
} from "@/lib/xaa/profile";
import { createInspectorXAAStateMachine } from "@/lib/xaa/debug-state-machine-adapter";

const isHttpServer = (server?: ServerWithName) =>
  Boolean(server && "url" in server.config);

function buildFlowStateFromProfile(profile: XAADebugProfile): XAAFlowState {
  return createInitialXAAFlowState({
    serverUrl: profile.serverUrl || undefined,
    authzServerIssuer: profile.authzServerIssuer || undefined,
    negativeTestMode: profile.negativeTestMode,
    userId: profile.userId || undefined,
    email: profile.email || undefined,
    clientId: profile.clientId || undefined,
    scope: profile.scope || undefined,
  });
}

interface XAAFlowTabProps {
  serverConfigs: Record<string, ServerWithName>;
  selectedServerName: string;
  onSelectServer: (serverName: string) => void;
}

export function XAAFlowTab({
  serverConfigs,
  selectedServerName,
  onSelectServer,
}: XAAFlowTabProps) {
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [focusedStep, setFocusedStep] = useState<XAAFlowStep | null>(null);

  const httpServers = useMemo(
    () => Object.values(serverConfigs).filter((server) => isHttpServer(server)),
    [serverConfigs],
  );

  const selectedServer =
    selectedServerName !== "none"
      ? serverConfigs[selectedServerName]
      : undefined;
  const activeServer = isHttpServer(selectedServer)
    ? selectedServer
    : undefined;

  useEffect(() => {
    if (!isHttpServer(selectedServer) && httpServers.length > 0) {
      onSelectServer(httpServers[0].name);
    }
  }, [httpServers, onSelectServer, selectedServer]);

  const [profile, setProfile] = useState(() =>
    deriveXAADebugProfileFromServer(activeServer, loadStoredXAADebugProfile()),
  );
  const [flowState, setFlowState] = useState<XAAFlowState>(() =>
    buildFlowStateFromProfile(
      deriveXAADebugProfileFromServer(activeServer, loadStoredXAADebugProfile()),
    ),
  );

  useEffect(() => {
    if (profile.serverUrl.trim()) {
      return;
    }

    const derived = deriveXAADebugProfileFromServer(activeServer, profile);
    setProfile(derived);
    setFlowState(buildFlowStateFromProfile(derived));
  }, [activeServer, profile.serverUrl]);

  useEffect(() => {
    if (!profile.serverUrl.trim()) {
      setIsConfigModalOpen(true);
    }
  }, [profile.serverUrl]);

  useEffect(() => {
    setFocusedStep(null);
  }, [flowState.currentStep]);

  const flowStateRef = useRef(flowState);
  useEffect(() => {
    flowStateRef.current = flowState;
  }, [flowState]);

  const updateFlowState = useCallback((updates: Partial<XAAFlowState>) => {
    setFlowState((current) => ({ ...current, ...updates }));
  }, []);

  const resetFlow = useCallback((nextProfile?: XAADebugProfile) => {
    const profileToApply = nextProfile ?? profile;
    setFlowState(buildFlowStateFromProfile(profileToApply));
    setFocusedStep(null);
  }, [profile]);

  const hasProfile = Boolean(profile.serverUrl.trim());

  const xaaStateMachine = useMemo(() => {
    return createInspectorXAAStateMachine({
      state: flowStateRef.current,
      getState: () => flowStateRef.current,
      updateState: updateFlowState,
      serverUrl: profile.serverUrl || "http://localhost",
      negativeTestMode: profile.negativeTestMode,
      userId: profile.userId,
      email: profile.email,
      clientId: profile.clientId,
      scope: profile.scope,
      authzServerIssuer: profile.authzServerIssuer,
    });
  }, [profile, updateFlowState]);

  const handleAdvance = useCallback(async () => {
    if (!hasProfile) {
      setIsConfigModalOpen(true);
      return;
    }

    await xaaStateMachine.proceedToNextStep();
  }, [hasProfile, xaaStateMachine]);

  const continueLabel = !hasProfile
    ? "Configure Target"
    : flowState.currentStep === "idle"
      ? "Start"
      : flowState.currentStep === "inspect_id_jag"
        ? "Request Access Token"
        : flowState.currentStep === "received_access_token"
          ? "Call MCP Server"
          : flowState.currentStep === "complete"
            ? "Flow Complete"
            : "Continue";

  const continueDisabled =
    !hasProfile || flowState.isBusy || flowState.currentStep === "complete";

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel defaultSize={52} minSize={30}>
            <XAASequenceDiagram
              flowState={flowState}
              focusedStep={focusedStep}
              hasProfile={hasProfile}
              onConfigure={() => setIsConfigModalOpen(true)}
            />
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={48} minSize={24} maxSize={52}>
            <XAAFlowLogger
              flowState={flowState}
              hasProfile={hasProfile}
              activeStep={focusedStep ?? flowState.currentStep}
              onFocusStep={setFocusedStep}
              actions={{
                onConfigure: () => setIsConfigModalOpen(true),
                onReset: hasProfile ? () => resetFlow() : undefined,
                onContinue: continueDisabled ? undefined : handleAdvance,
                continueLabel,
                continueDisabled,
                resetDisabled: !hasProfile || flowState.isBusy,
              }}
              summary={{
                serverUrl: profile.serverUrl,
                authzServerIssuer: profile.authzServerIssuer || undefined,
                clientId: profile.clientId || undefined,
                scope: profile.scope || undefined,
                negativeTestMode: profile.negativeTestMode,
              }}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      <XAAConfigModal
        open={isConfigModalOpen}
        onOpenChange={setIsConfigModalOpen}
        value={profile}
        onSave={(nextProfile) => {
          saveStoredXAADebugProfile(nextProfile);
          setProfile(nextProfile);
          resetFlow(nextProfile);
        }}
      />
    </div>
  );
}
