import { useEffect, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import type { ChangeEntry } from "@mcpjam/sdk/climbs";
import { Alert, AlertDescription } from "@mcpjam/design-system/alert";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@mcpjam/design-system/sheet";
import { Switch } from "@mcpjam/design-system/switch";
import { Textarea } from "@mcpjam/design-system/textarea";
import { draftChange } from "@/lib/apis/climbs-api";
import { canDraft, changeValue, entryLabel, fieldKind, initialText } from "./change-model";
import { plural } from "./climb-format";
import type { Climb } from "./climb-types";
import { runRound } from "./run-round";

/**
 * Writes one change and runs it as a round on the mock. "Draft with a model"
 * fills the text from the failed steering cases; it saves nothing, so the
 * person reads and edits the draft before anything runs.
 */
export function ChangeForm({
  climb,
  entry,
  onClose,
  onSubmitted,
}: {
  climb: Climb;
  entry: ChangeEntry | null;
  onClose: () => void;
  onSubmitted: (roundNumber: number) => void;
}) {
  const [text, setText] = useState("");
  const [hide, setHide] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState<"draft" | "run" | null>(null);

  useEffect(() => {
    setText(entry ? initialText(entry) : "");
    setHide(true);
    setNote(null);
    setFailure(null);
    setPending(null);
  }, [entry]);

  if (!entry) return <Sheet open={false} />;
  const label = entryLabel(entry);
  const kind = fieldKind(entry);
  const steeringTools = climb.groups.steeringCases.map((candidate) => candidate.tool);
  const drafting = canDraft(entry, steeringTools);
  const field = entry.where.field;

  const draft = async () => {
    setPending("draft");
    setFailure(null);
    try {
      const drafted = await draftChange({
        projectId: climb.projectId,
        climbId: climb.climbId,
        toolName: entry.where.tool ?? "",
        includeTitle: field === "title",
      });
      setText(field === "title" ? (drafted.title ?? drafted.description) : drafted.description);
      setNote(`Drafted by ${drafted.modelUsed} from ${plural(drafted.trialsRead, "failed iteration")}. Read it and edit it before you run the round.`);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The draft did not come back. Try again.");
    } finally {
      setPending(null);
    }
  };

  const run = async () => {
    const value = changeValue(entry, text, hide);
    if (!value.ok) {
      setFailure(value.error);
      return;
    }
    setPending("run");
    setFailure(null);
    try {
      const { roundNumber } = await runRound({ climb, entry, value: value.value });
      onSubmitted(roundNumber);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "The round did not start. Try again.");
      setPending(null);
    }
  };

  return (
    <Sheet open onOpenChange={(open) => !open && pending === null && onClose()}>
      <SheetContent className="flex w-[520px] max-w-full flex-col gap-0 p-0">
        <SheetHeader>
          <SheetTitle>Try a change</SheetTitle>
          <SheetDescription>On the mock server. Your server isn't changed.</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="change-where">Where</Label>
            <Input id="change-where" readOnly value={`${label.name} · ${label.field}`} />
          </div>
          {kind === "hidden" ? (
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="change-hide">Hide this tool from clients</Label>
              <Switch id="change-hide" checked={hide} onCheckedChange={setHide} />
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="change-text">Change to</Label>
                {drafting ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() => void draft()}
                    disabled={pending !== null}
                  >
                    {pending === "draft" ? <Loader2 className="animate-spin" aria-hidden /> : <Sparkles aria-hidden />}
                    Draft with a model
                  </Button>
                ) : null}
              </div>
              <Textarea
                id="change-text"
                rows={kind === "json" ? 10 : 4}
                className={kind === "json" ? "font-mono text-xs" : undefined}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
              {!drafting && entry.where.kind === "tool" && field === "description" ? (
                <p className="text-xs text-muted-foreground">
                  No steering case calls this tool, so there is nothing for a model to draft from.
                </p>
              ) : null}
            </div>
          )}
          {failure ? (
            <Alert variant="destructive">
              <AlertDescription>
                <p>{failure}</p>
              </AlertDescription>
            </Alert>
          ) : null}
        </div>
        <SheetFooter className="border-t border-border">
          <div className="flex w-full items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              Round {climb.limits.roundsStarted + 1} of {climb.limits.roundLimit}. {climb.limits.creditsLeft.toLocaleString("en-US")} credits left.
            </span>
            <Button onClick={() => void run()} disabled={pending !== null}>
              {pending === "run" ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Run round
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
