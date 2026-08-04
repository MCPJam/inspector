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
  /** Demo / layout preview — show share UI without writing invites. */
  previewMode?: boolean;
}

export function ShareChatboxDialog({
  isOpen,
  onClose,
  chatbox,
  onUpdated,
  previewMode = false,
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
          <DialogTitle>Share &ldquo;{settings.name}&rdquo;</DialogTitle>
          <DialogDescription className="sr-only">
            Invite people and manage access for this prototype.
          </DialogDescription>
        </DialogHeader>

        {!isAuthenticated && !previewMode ? (
          <p className="text-sm text-muted-foreground">
            Sign in to manage prototype access.
          </p>
        ) : (
          <>
            {previewMode ? (
              <p className="text-sm text-muted-foreground">
                Demo preview — invites and access changes apply on a published
                prototype.
              </p>
            ) : null}
            <ChatboxShareSection
              chatbox={settings}
              previewMode={previewMode}
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
