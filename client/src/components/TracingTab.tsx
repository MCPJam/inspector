import { LoggerView } from "./logging/logger-view";

export function TracingTab() {
  return (
    <div className="flex flex-col h-full">
      <LoggerView />
    </div>
  );
}
