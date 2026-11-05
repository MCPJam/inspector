import { useLayoutEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@mcpjam/design-system/dialog";
import { ComposerFormStatus } from "@/components/chat-v2/chat-input/form-status";
import { registerComposerSlot, useComposerForms } from "./composer-form-store";

/** Move the existing form card above a global App without creating another owner. */
export function TakeoverFormSlot({
  chatWorkspaceId,
  globalWorkspaceId,
}: {
  chatWorkspaceId?: string;
  globalWorkspaceId?: string;
}) {
  const chatForms = useComposerForms(chatWorkspaceId);
  const globalForms = useComposerForms(globalWorkspaceId);
  const forms = [...chatForms, ...globalForms].sort((a, b) => a.order - b.order);
  const workspaceId = forms[0]?.workspaceId;
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (workspaceId && slot) {
      return registerComposerSlot(workspaceId, slot);
    }
  }, [workspaceId, slot]);
  if (!workspaceId) return null;
  return (
    <Dialog open>
      <DialogContent showCloseButton={false} className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader className="sr-only">
          <DialogTitle>App requests information</DialogTitle>
          <DialogDescription>Answer or cancel the form to return to the app.</DialogDescription>
        </DialogHeader>
        <ComposerFormStatus forms={forms} />
        <div ref={setSlot} data-testid="takeover-form-slot" />
      </DialogContent>
    </Dialog>
  );
}
