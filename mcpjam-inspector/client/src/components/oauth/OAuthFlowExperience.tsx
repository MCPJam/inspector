import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { OAuthSequenceDiagram } from "@/components/oauth/OAuthSequenceDiagram";
import { OAuthAuthorizationModal } from "@/components/oauth/OAuthAuthorizationModal";
import { OAuthFlowLogger } from "@/components/oauth/OAuthFlowLogger";
import { RefreshTokensConfirmModal } from "@/components/oauth/RefreshTokensConfirmModal";
import type {
  OAuthFlowState,
  OAuthFlowStep,
  OAuthProtocolVersion,
} from "@/lib/oauth/state-machines/types";
import type { OAuthRegistrationStrategy } from "@/lib/oauth/profile";
import {
  resolveOAuthFlowExperienceCapabilities,
  type OAuthFlowExperienceConfig,
  type OAuthFlowExperienceSummary,
} from "./oauthFlowShared";

interface OAuthFlowExperienceProps {
  flowState: OAuthFlowState;
  focusedStep: OAuthFlowStep | null;
  onFocusStep: (step: OAuthFlowStep | null) => void;
  hasProfile: boolean;
  protocolVersion: OAuthProtocolVersion;
  registrationStrategy: OAuthRegistrationStrategy;
  summary: OAuthFlowExperienceSummary;
  config?: OAuthFlowExperienceConfig;
  onClearLogs: () => void;
  onClearHttpHistory: () => void;
  onConfigureTarget?: () => void | Promise<void>;
  onReset?: () => void | Promise<void>;
  onContinue?: () => void | Promise<void>;
  continueLabel: string;
  continueDisabled: boolean;
  onApplyTokens?: () => void | Promise<void>;
  onRefreshTokens?: () => void | Promise<void>;
  isApplyingTokens?: boolean;
  authModal: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    authorizationUrl?: string;
  };
  refreshModal?: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    serverName: string;
    onConfirm: () => void | Promise<void>;
    isLoading?: boolean;
  };
}

export function OAuthFlowExperience({
  flowState,
  focusedStep,
  onFocusStep,
  hasProfile,
  protocolVersion,
  registrationStrategy,
  summary,
  config,
  onClearLogs,
  onClearHttpHistory,
  onConfigureTarget,
  onReset,
  onContinue,
  continueLabel,
  continueDisabled,
  onApplyTokens,
  onRefreshTokens,
  isApplyingTokens,
  authModal,
  refreshModal,
}: OAuthFlowExperienceProps) {
  const capabilities = resolveOAuthFlowExperienceCapabilities(config);
  const canConfigureTarget =
    capabilities.canConfigureTarget && Boolean(onConfigureTarget);
  const canEditTarget =
    capabilities.canEditTarget &&
    capabilities.canConfigureTarget &&
    Boolean(onConfigureTarget);

  return (
    <div className="h-full flex flex-col bg-background">
      <div className="flex-1 overflow-hidden">
        <ResizablePanelGroup direction="horizontal" className="h-full">
          <ResizablePanel defaultSize={50} minSize={30}>
            <OAuthSequenceDiagram
              flowState={flowState}
              registrationStrategy={registrationStrategy}
              protocolVersion={protocolVersion}
              focusedStep={focusedStep}
              hasProfile={hasProfile}
              onConfigure={canConfigureTarget ? onConfigureTarget : undefined}
            />
          </ResizablePanel>

          <ResizableHandle withHandle />

          <ResizablePanel defaultSize={50} minSize={20} maxSize={50}>
            <OAuthFlowLogger
              oauthFlowState={flowState}
              onClearLogs={onClearLogs}
              onClearHttpHistory={onClearHttpHistory}
              activeStep={focusedStep ?? flowState.currentStep}
              onFocusStep={(step) => onFocusStep(step)}
              hasProfile={hasProfile}
              summary={summary}
              actions={{
                onConfigure: onConfigureTarget,
                showConfigureTarget: canConfigureTarget,
                showEditTarget: canEditTarget,
                onReset,
                onContinue,
                continueLabel,
                continueDisabled,
                resetDisabled: !hasProfile || flowState.isInitiatingAuth,
                onConnectServer: capabilities.canApplyTokens
                  ? onApplyTokens
                  : undefined,
                onRefreshTokens: capabilities.canRefreshTokens
                  ? onRefreshTokens
                  : undefined,
                isApplyingTokens,
              }}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>

      {authModal.authorizationUrl && (
        <OAuthAuthorizationModal
          open={authModal.open}
          onOpenChange={authModal.onOpenChange}
          authorizationUrl={authModal.authorizationUrl}
        />
      )}

      {capabilities.canRefreshTokens && refreshModal && (
        <RefreshTokensConfirmModal
          open={refreshModal.open}
          onOpenChange={refreshModal.onOpenChange}
          serverName={refreshModal.serverName}
          onConfirm={refreshModal.onConfirm}
          isLoading={refreshModal.isLoading}
        />
      )}
    </div>
  );
}
