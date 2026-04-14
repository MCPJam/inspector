import { useLearningServer } from "@/hooks/use-learning-server";
import { ResourcesTab } from "@/components/ResourcesTab";
import { LearningConnectionGate } from "./LearningConnectionGate";

export function LearningResourcesExplorer() {
  const { serverName, config, connectionStatus } = useLearningServer();

  return (
    <LearningConnectionGate
      connectionStatus={connectionStatus}
      label="Resources"
    >
      <ResourcesTab serverConfig={config} serverName={serverName} />
    </LearningConnectionGate>
  );
}
