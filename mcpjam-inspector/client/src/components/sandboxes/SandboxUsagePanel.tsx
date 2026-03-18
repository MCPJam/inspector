import { useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import type { SandboxSettings } from "@/hooks/useSandboxes";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { ShareUsageThreadList } from "@/components/connection/share-usage/ShareUsageThreadList";
import { ShareUsageThreadDetail } from "@/components/connection/share-usage/ShareUsageThreadDetail";

interface SandboxUsagePanelProps {
  sandbox: SandboxSettings;
}

export function SandboxUsagePanel({ sandbox }: SandboxUsagePanelProps) {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedThreadId(null);
  }, [sandbox.sandboxId]);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b px-5 py-4">
        <h2 className="truncate text-lg font-semibold">{sandbox.name}</h2>
        {sandbox.description && (
          <p className="mt-0.5 text-sm text-muted-foreground">
            {sandbox.description}
          </p>
        )}
      </div>

      {/* Usage body */}
      <div className="min-h-0 flex-1">
        <ResizablePanelGroup direction="horizontal">
          <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
            <div className="h-full overflow-hidden">
              <ShareUsageThreadList
                sourceType="sandbox"
                sourceId={sandbox.sandboxId}
                selectedThreadId={selectedThreadId}
                onSelectThread={setSelectedThreadId}
              />
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel defaultSize={70}>
            <div className="h-full overflow-hidden">
              {selectedThreadId ? (
                <ShareUsageThreadDetail threadId={selectedThreadId} />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <div className="text-center">
                    <MessageSquare className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
                    <p className="text-sm text-muted-foreground">
                      Select a conversation to view
                    </p>
                  </div>
                </div>
              )}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
