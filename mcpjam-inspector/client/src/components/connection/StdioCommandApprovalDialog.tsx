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
import { useStdioCommandApprovalStore } from "@/lib/stdio-command-approval";

/** Quote only what a shell would need quoted, so the line reads as typed. */
const shellWord = (word: string) =>
  word === "" || /[\s"'$`\\]/.test(word) ? JSON.stringify(word) : word;

export function formatStdioCommandLine(command: string, args: string[]) {
  return [command, ...args].map(shellWord).join(" ");
}

/**
 * Asks, once per device and per exact command, before the local inspector
 * starts a project STDIO server (PLB-192). Renders the head of the approval
 * queue; `obtainStdioCommandApproval` is what enqueues, and the buttons
 * answer it. The dialog is controlled by the queue alone, so a button's own
 * close must not also answer the NEXT prompt: `onOpenChange` is a no-op and
 * only Escape declines.
 */
export function StdioCommandApprovalDialog() {
  const prompt = useStdioCommandApprovalStore(
    (state) => state.queue[0] ?? null,
  );
  const settle = useStdioCommandApprovalStore((state) => state.settle);
  if (!prompt) return null;
  const { serverName, terms } = prompt;

  return (
    <AlertDialog open onOpenChange={() => {}}>
      <AlertDialogContent
        data-testid="stdio-command-approval-dialog"
        onEscapeKeyDown={() => settle(false)}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            Run "{serverName}" on this machine?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {terms.previouslyApproved
              ? `The command "${serverName}" runs has changed since you approved it on this device.`
              : `This device has not started "${serverName}" before.`}{" "}
            Anyone who can edit this project can change what it runs. MCPJam
            will start it with your user's permissions.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2 text-sm">
          <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-xs">
            {formatStdioCommandLine(terms.command, terms.args)}
          </pre>
          {terms.envNames.length > 0 && (
            <p className="text-muted-foreground">
              Environment variables:{" "}
              <span className="font-mono">{terms.envNames.join(", ")}</span>{" "}
              (values hidden)
            </p>
          )}
          {terms.cwd && (
            <p className="text-muted-foreground">
              Working directory: <span className="font-mono">{terms.cwd}</span>
            </p>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => settle(false)}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction onClick={() => settle(true)}>
            Allow on this device
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
