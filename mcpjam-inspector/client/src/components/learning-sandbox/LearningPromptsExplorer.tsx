import { useLearningServer } from "@/hooks/use-learning-server";
import { PromptsTab } from "@/components/PromptsTab";
import { LearningConnectionGate } from "./LearningConnectionGate";

export function LearningPromptsExplorer() {
  const { serverName, config, connectionStatus } = useLearningServer();

  return (
    <LearningConnectionGate connectionStatus={connectionStatus} label="Prompts">
      <PromptsTab serverConfig={config} serverName={serverName} />
    </LearningConnectionGate>
  );
}
