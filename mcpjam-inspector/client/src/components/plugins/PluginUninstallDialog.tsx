import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";

/**
 * Confirm uninstalling a plugin. The caller runs the mutation (and reports a
 * refusal, such as a live environment still pinning one of its versions).
 */
export function PluginUninstallDialog({
  open,
  onOpenChange,
  pluginLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pluginLabel: string;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Uninstall {pluginLabel}?</AlertDialogTitle>
          <AlertDialogDescription>
            Revisions already used by runs and sessions are preserved, so
            existing history stays reproducible. Uninstall is blocked while a
            live environment still pins one of this plugin's versions.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Uninstall</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
