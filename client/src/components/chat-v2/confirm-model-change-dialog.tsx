import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface ConfirmModelChangeDialogProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  currentModelName: string;
  newModelName: string;
}

export function ConfirmModelChangeDialog({
  open,
  onConfirm,
  onCancel,
  currentModelName,
  newModelName,
}: ConfirmModelChangeDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Change model?</AlertDialogTitle>
          <AlertDialogDescription>
            Changing from <strong>{currentModelName}</strong> to{" "}
            <strong>{newModelName}</strong> will clear your current conversation
            thread. This action cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            Change model
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
