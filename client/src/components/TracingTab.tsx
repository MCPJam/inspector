import { JsonRpcLoggerView } from "./logging/json-rpc-logger-view";

export function TracingTab() {
  return (
    <div className="flex flex-col h-full">
      <JsonRpcLoggerView />
    </div>
  );
}
