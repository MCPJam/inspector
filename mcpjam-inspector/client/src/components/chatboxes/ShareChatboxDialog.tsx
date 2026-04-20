import { useEffect, useState } from "react";
import { useConvexAuth } from "convex/react";
import type { ChatboxSettings } from "@/hooks/useChatboxes";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { ChatboxShareSection } from "@/components/chatboxes/ChatboxShareSection";

interface ShareChatboxDialogProps {
  isOpen: boolean;
  onClose: () => void;
  chatbox: ChatboxSettings;
  onUpdated?: (chatbox: ChatboxSettings) => void;
}

export function ShareChatboxDialog({
  isOpen,
  onClose,
  chatbox,
  onUpdated,
}: ShareChatboxDialogProps) {
  const { isAuthenticated } = useConvexAuth();
  const [settings, setSettings] = useState<ChatboxSettings>(chatbox);

  useEffect(() => {
    setSettings(chatbox);
  }, [chatbox]);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>Share &ldquo;{settings.name}&rdquo; Chatbox</DialogTitle>
          <DialogDescription className="sr-only">
            Invite people and manage access for this chatbox.
          </DialogDescription>
        </DialogHeader>

        {!isAuthenticated ? (
          <p className="text-sm text-muted-foreground">
            Sign in to manage chatbox access.
          </p>
        ) : (
          <>
            <ChatboxShareSection
              chatbox={settings}
              onUpdated={(next) => {
                setSettings(next);
                onUpdated?.(next);
              }}
            />
            <div className="flex justify-end pt-2">
              <Button size="sm" onClick={onClose}>
                Done
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
