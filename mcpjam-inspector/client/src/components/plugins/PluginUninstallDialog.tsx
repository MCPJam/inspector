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
import { useProjectEnvironmentsEnabled } from "@/hooks/useProjectEnvironmentsEnabled";

/**
 * Confirm uninstalling a plugin. The caller runs the mutation (and reports a
 * refusal, such as a live environment still pinning one of its versions).
 *
 * Environments are only mentioned to someone who can see them; with the
 * environments UI hidden the sentence about pins would name something they
 * have no way to find.
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
  const environmentsVisible = useProjectEnvironmentsEnabled();
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Uninstall {pluginLabel}?</AlertDialogTitle>
          <AlertDialogDescription>
            Revisions already used by runs and sessions are preserved, so
            existing history stays reproducible.
            {environmentsVisible
              ? " Uninstall is blocked while a live environment still pins one of this plugin's versions."
              : null}
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
