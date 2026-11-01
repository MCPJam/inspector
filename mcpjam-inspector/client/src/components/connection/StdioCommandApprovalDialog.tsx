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

/**
 * Quote only what a shell would need quoted, so the line reads as typed. A
 * control or format character (a bidi override, a zero-width space) is quoted
 * and escaped too: left raw it would reorder or hide part of what is approved.
 */
const shellWord = (word: string) =>
  word === "" || /[\s"'$`\\\p{C}]/u.test(word)
    ? JSON.stringify(word).replace(
        /\p{C}/gu,
        (char) => `\\u{${(char.codePointAt(0) ?? 0).toString(16)}}`,
      )
    : word;

export function formatStdioCommandLine(command: string, args: string[]) {
  return [command, ...args].map(shellWord).join(" ");
}

/**
 * Asks, once per device and per exact command, before the local inspector
 * starts a project STDIO server. Renders the head of the approval
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
  const codeLoading = Object.entries(terms.codeLoadingEnv ?? {});
  const hiddenEnvNames = terms.envNames.filter(
    (name) => !codeLoading.some(([shown]) => shown === name),
  );
  // The second click of a double click lands on the NEXT prompt's button,
  // answering a command nobody read.
  const answer = (allowed: boolean) => (event: { detail: number }) => {
    if (event.detail <= 1) settle(allowed);
  };

  return (
    // Keyed per prompt: the next one remounts, so focus returns to Cancel
    // instead of staying on the Allow a repeated Enter would press.
    <AlertDialog key={prompt.id} open onOpenChange={() => {}}>
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
          {hiddenEnvNames.length > 0 && (
            <p className="text-muted-foreground">
              Environment variables:{" "}
              <span className="font-mono">
                {hiddenEnvNames.map(shellWord).join(", ")}
              </span>{" "}
              (values hidden)
            </p>
          )}
          {codeLoading.length > 0 && (
            <div className="space-y-1 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-foreground">
              <p className="font-medium">
                {codeLoading.length === 1
                  ? "Allow only if you expected this value. It can run other code."
                  : "Allow only if you expected these values. They can run other code."}
              </p>
              <pre className="whitespace-pre-wrap break-all font-mono text-xs">
                {codeLoading
                  .map(
                    ([name, value]) => `${shellWord(name)}=${shellWord(value)}`,
                  )
                  .join("\n")}
              </pre>
            </div>
          )}
          {terms.changedEnvNames && terms.changedEnvNames.length > 0 && (
            <p className="font-medium">
              Changed since you approved it:{" "}
              <span className="font-mono">
                {terms.changedEnvNames
                  .map((name) =>
                    terms.envNames.includes(name)
                      ? shellWord(name)
                      : `${shellWord(name)} (removed)`,
                  )
                  .join(", ")}
              </span>
            </p>
          )}
          {terms.cwd && (
            <p className="text-muted-foreground">
              Working directory:{" "}
              <span className="font-mono">{shellWord(terms.cwd)}</span>
            </p>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={answer(false)}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={answer(true)}>
            Allow on this device
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
