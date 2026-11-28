import type { ReactNode } from "react";
import { AnnouncementDialog } from "../announcement-popups";

export function TrialDecisionDialog({
  eligible,
  onDismiss,
  children,
}: {
  eligible: boolean;
  onDismiss: () => void;
  children: ReactNode;
}) {
  return (
    <AnnouncementDialog
      eligible={eligible}
      onDismiss={onDismiss}
      onPointerDownOutside={(e) => e.preventDefault()}
      onEscapeKeyDown={(e) => e.preventDefault()}
      data-testid="trial-decision-modal"
    >
      {children}
    </AnnouncementDialog>
  );
}
