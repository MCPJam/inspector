import { PlusCircle, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

interface ConnectMcpServerCalloutProps {
  className?: string;
}

export function ConnectMcpServerCallout({
  className,
}: ConnectMcpServerCalloutProps) {
  return (
    <div
      className={cn(
        "max-w-xl mx-auto space-y-4 text-center flex flex-col items-center justify-center",
        className,
      )}
    >
      <div className="space-y-1">
        <h2 className="text-base font-medium">
          You must connect to an MCP server
        </h2>
      </div>
      <div className="flex justify-center gap-2 text-xs text-muted-foreground">
        <a
          href="#servers"
          className="inline-flex items-center gap-1 rounded-full border px-3 py-1 transition hover:bg-muted/30"
        >
          <PlusCircle className="h-3 w-3" /> Add server
        </a>
        <a
          href="#settings"
          className="inline-flex items-center gap-1 rounded-full border px-3 py-1 transition hover:bg-muted/30"
        >
          <Settings className="h-3 w-3" /> Settings
        </a>
      </div>
    </div>
  );
}
