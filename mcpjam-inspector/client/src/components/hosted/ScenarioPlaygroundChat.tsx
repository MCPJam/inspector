import { PlaygroundMain } from "@/components/ui-playground/PlaygroundMain";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { ExecutionConfig } from "@/lib/chat-execution-config";
import type { HostedRuntimeContext } from "@/lib/hosted-runtime-context";
import type { HostedOAuthRequiredDetails } from "@/lib/hosted-oauth-required";
import type { ReasoningDisplayMode } from "@/components/chat-v2/thread/parts/reasoning-part";
import type { TesterChatRules } from "@/components/hosted/tester-chat";

/**
 * The study chat. Same surface as the Playground (`PlaygroundMain`), with the
 * tester rules passed as `tester` so guest access, the locked model, and the
 * quiet composer stay configuration.
 *
 * Props match the contract `ScenarioChatPage` used to hand `ChatTabV2`. The
 * page still owns consent, the study header, and the OAuth overlays.
 */
export interface ScenarioPlaygroundChatProps {
  connectedOrConnectingServerConfigs: Record<string, ServerWithName>;
  selectedServerNames: string[];
  minimalMode?: boolean;
  showContextPopover?: boolean;
  reasoningDisplayMode?: ReasoningDisplayMode;
  hostedContext?: HostedRuntimeContext;
  executionConfig?: ExecutionConfig;
  onOAuthRequired?: (details?: HostedOAuthRequiredDetails) => void;
  scenarioComposerBlocked?: boolean;
  scenarioComposerBlockedReason?: string;
  scenarioOptionalInventory?: TesterChatRules["optionalServers"];
  onEnableScenarioOptionalServer?: (serverId: string) => void;
  renderAssistantTurnActions?: TesterChatRules["renderAssistantTurnActions"];
}

export function ScenarioPlaygroundChat({
  connectedOrConnectingServerConfigs,
  selectedServerNames,
  hostedContext,
  executionConfig,
  onOAuthRequired,
  scenarioComposerBlocked = false,
  scenarioComposerBlockedReason,
  scenarioOptionalInventory,
  onEnableScenarioOptionalServer,
  renderAssistantTurnActions,
}: ScenarioPlaygroundChatProps) {
  const tester: TesterChatRules | undefined =
    hostedContext && executionConfig
      ? {
          hostedContext,
          executionConfig,
          selectedServerNames,
          serverConfigs: connectedOrConnectingServerConfigs,
          composerBlocked: scenarioComposerBlocked,
          composerBlockedReason: scenarioComposerBlockedReason,
          onOAuthRequired,
          optionalServers: scenarioOptionalInventory,
          onEnableOptionalServer: onEnableScenarioOptionalServer,
          renderAssistantTurnActions,
        }
      : undefined;

  const serverName =
    selectedServerNames.find(
      (name) =>
        connectedOrConnectingServerConfigs[name]?.connectionStatus ===
        "connected",
    ) ??
    selectedServerNames[0] ??
    "";

  return (
    <PlaygroundMain
      activeProjectId={hostedContext?.projectId ?? null}
      serverName={serverName}
      pendingExecution={null}
      onExecutionInjected={() => {}}
      enableMultiModelChat={false}
      hideWelcomeHero
      hideCenterHeaderChrome
      hideInlineEdit
      hideMessageEdit
      tester={tester}
    />
  );
}
