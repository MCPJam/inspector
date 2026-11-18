import { Dialog, DialogContent } from "@mcpjam/design-system/dialog";
import type { ReactNode } from "react";
import { useAnnouncementSlot } from "../announcement-slot";

export function TrialDecisionDialog({
  eligible,
  onDismiss,
  children,
}: {
  eligible: boolean;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const { open, contentRef } = useAnnouncementSlot(eligible);

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onDismiss()}>
      <DialogContent
        ref={contentRef}
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        data-testid="trial-decision-modal"
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
