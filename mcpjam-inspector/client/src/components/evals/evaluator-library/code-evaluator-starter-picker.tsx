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
import { Button } from "@mcpjam/design-system/button";
import { useState } from "react";
import {
  CODE_EVALUATOR_STARTERS,
  fileNameForStarter,
  isEditedScript,
  type CodeEvaluatorStarter,
} from "./code-evaluator-starters";

/**
 * The Starter choices above a code evaluator's script. Picking one fills the
 * file name and the script, and asks first before it replaces a script
 * someone wrote. The current file's language reads as pressed.
 */
export function CodeEvaluatorStarterPicker({
  fileName,
  script,
  language,
  onPick,
}: {
  fileName: string;
  script: string;
  language: string | undefined;
  onPick: (next: { fileName: string; script: string }) => void;
}) {
  // A starter waiting to replace a script someone wrote.
  const [pending, setPending] = useState<CodeEvaluatorStarter | null>(null);
  const apply = (starter: CodeEvaluatorStarter) =>
    onPick({
      fileName: fileNameForStarter(fileName, starter),
      script: starter.script,
    });
  return (
    <>
      <div
        role="group"
        aria-label="Starter"
        className="flex items-center gap-1"
      >
        <span aria-hidden className="mr-1 text-xs text-muted-foreground">
          Starter
        </span>
        {CODE_EVALUATOR_STARTERS.map((starter) => (
          <Button
            key={starter.language}
            type="button"
            size="sm"
            variant={language === starter.language ? "secondary" : "ghost"}
            aria-pressed={language === starter.language}
            onClick={() =>
              isEditedScript(script) ? setPending(starter) : apply(starter)
            }
          >
            {starter.language}
          </Button>
        ))}
      </div>
      <AlertDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (!next) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace your script?</AlertDialogTitle>
            <AlertDialogDescription>
              The {pending?.language} starter replaces the script you wrote.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my script</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) apply(pending);
                setPending(null);
              }}
            >
              Replace script
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
