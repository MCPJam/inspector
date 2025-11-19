import { JsonRpcLoggerView } from "../logging/json-rpc-logger-view";

interface ServerConnectionDetailsProps {
  serverCount?: number;
}

export function ServerConnectionDetails({
  serverCount,
}: ServerConnectionDetailsProps) {
  return (
    <div className="h-full flex flex-col bg-background border-l border-border">
      {/* JSON-RPC Logger - Full Height */}
      <div className="flex-1 overflow-hidden">
        <JsonRpcLoggerView key={serverCount} />
      </div>
    </div>
  );
}
