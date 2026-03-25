import { useLearningServer } from "@/hooks/use-learning-server";
import { ToolsTab } from "@/components/ToolsTab";
import { LearningConnectionGate } from "./LearningConnectionGate";

export function LearningToolsExplorer() {
  const { serverName, config, connectionStatus } = useLearningServer();

  return (
    <LearningConnectionGate connectionStatus={connectionStatus} label="Tools">
      <ToolsTab serverConfig={config} serverName={serverName} />
    </LearningConnectionGate>
  );
}
