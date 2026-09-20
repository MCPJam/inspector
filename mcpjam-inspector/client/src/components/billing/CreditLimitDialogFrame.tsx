import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { JamIllustration } from "./JamIllustration";

/** Shared presentation for Eval and Swarm credit recovery, across plans. */
export function CreditLimitDialogFrame({
  title,
  description,
  onDismiss,
  modal = true,
  children,
}: {
  title: string;
  description: string;
  onDismiss: () => void;
  modal?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      modal={modal}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <JamIllustration />
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription
            className="text-pretty"
            data-testid="limit-dialog-description"
          >
            {description}
          </DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
