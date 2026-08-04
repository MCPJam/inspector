import { Inbox } from "lucide-react";
import type { HostConfigMcpProfileV1 } from "@/lib/client-config-v2";
import { previewIframeAllow } from "@/lib/client-preview-iframe-allow";

/**
 * Live published chatbox in an iframe so users can spot-check chrome /
 * welcome / tool flow without leaving the tab. Points at the public share
 * URL (same as "Open preview").
 */
export function ChatboxPreviewPane({
  publishLink,
  mcpProfile,
  emptyTitle = "No share link yet",
  emptyBody = "Save the test to generate a share link, then come back here to preview it.",
}: {
  publishLink: string | null;
  mcpProfile: HostConfigMcpProfileV1 | undefined;
  emptyTitle?: string;
  emptyBody?: string;
}) {
  const allow = previewIframeAllow(mcpProfile);
  if (!publishLink) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="max-w-sm">
          <Inbox className="mx-auto size-8 text-muted-foreground/70" />
          <p className="mt-3 text-sm font-medium">{emptyTitle}</p>
          <p className="mt-1 text-xs text-muted-foreground">{emptyBody}</p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/10">
      <iframe
        key={publishLink}
        src={publishLink}
        title="Test preview"
        className="size-full flex-1 border-0 bg-background"
        allow={allow}
      />
    </div>
  );
}
