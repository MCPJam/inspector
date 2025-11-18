import { Code } from "lucide-react";
import { JsonRpcLoggerView } from "../logging/json-rpc-logger-view";

interface ServerConnectionDetailsProps {
  serverCount?: number;
}

export function ServerConnectionDetails({
  serverCount,
}: ServerConnectionDetailsProps) {
  return (
    <div className="h-full flex flex-col bg-background border-l border-border">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <Code className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">JSON-RPC Traces</h2>
          <span className="text-xs text-muted-foreground">(Servers)</span>
        </div>
      </div>

      {/* JSON-RPC Logger - Full Height */}
      <div className="flex-1 overflow-hidden">
        <JsonRpcLoggerView key={serverCount} />
      </div>
    </div>
  );
}
