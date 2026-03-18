import { useEffect, useState } from "react";
import { ArrowLeft, MessageSquare } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { ShareUsageThreadList } from "./ShareUsageThreadList";
import { ShareUsageThreadDetail } from "./ShareUsageThreadDetail";
import type { SharedChatSourceType } from "@/hooks/useSharedChatThreads";

interface ShareUsageDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onBackToSettings: () => void;
  sourceType: SharedChatSourceType;
  sourceId: string;
  title: string;
}

export function ShareUsageDialog({
  isOpen,
  onClose,
  onBackToSettings,
  sourceType,
  sourceId,
  title,
}: ShareUsageDialogProps) {
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  useEffect(() => {
    setSelectedThreadId(null);
  }, [sourceId]);

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open: boolean) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[calc(100vw-4rem)] h-[calc(100vh-4rem)] flex flex-col gap-0 p-0">
        <DialogHeader className="shrink-0 border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onBackToSettings}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <DialogTitle className="text-base">
              Usage &mdash; {title}
            </DialogTitle>
          </div>
        </DialogHeader>

        <div className="flex-1 min-h-0">
          <ResizablePanelGroup direction="horizontal">
            <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
              <div className="h-full overflow-hidden">
                <ShareUsageThreadList
                  sourceType={sourceType}
                  sourceId={sourceId}
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
      </DialogContent>
    </Dialog>
  );
}
