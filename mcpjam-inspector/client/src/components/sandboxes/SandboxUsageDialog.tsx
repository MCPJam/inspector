import { ShareUsageDialog } from "@/components/connection/share-usage/ShareUsageDialog";

interface SandboxUsageDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onBackToSettings: () => void;
  sandboxId: string;
  sandboxName: string;
}

export function SandboxUsageDialog({
  isOpen,
  onClose,
  onBackToSettings,
  sandboxId,
  sandboxName,
}: SandboxUsageDialogProps) {
  return (
    <ShareUsageDialog
      isOpen={isOpen}
      onClose={onClose}
      onBackToSettings={onBackToSettings}
      sourceType="sandbox"
      sourceId={sandboxId}
      title={sandboxName}
    />
  );
}
