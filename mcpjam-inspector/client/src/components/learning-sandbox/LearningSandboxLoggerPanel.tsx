import { LoggerView } from "@/components/logger-view";

interface LearningSandboxLoggerPanelProps {
  serverId: string;
  onClose?: () => void;
}

export function LearningSandboxLoggerPanel({
  serverId,
  onClose,
}: LearningSandboxLoggerPanelProps) {
  return (
    <div className="h-full min-h-0 overflow-hidden">
      <LoggerView serverIds={[serverId]} onClose={onClose} />
    </div>
  );
}
