import { Check, CircleAlert, TriangleAlert, Undo2 } from "lucide-react";
import { Badge } from "@mcpjam/design-system/badge";
import { RESULT_WORD, type RoundResult } from "./round-model";

/** The mark for a round's result. Status colors carry state only. */
export function ResultIcon({ result }: { result: RoundResult }) {
  switch (result) {
    case "kept":
      return <Check className="size-3.5 text-success" aria-hidden />;
    case "reverted":
      return <Undo2 className="size-3.5 text-muted-foreground" aria-hidden />;
    case "undecided":
      return <TriangleAlert className="size-3.5 text-warning" aria-hidden />;
    case "failed":
      return <CircleAlert className="size-3.5 text-destructive" aria-hidden />;
    case "running":
      return <span className="size-2 animate-pulse rounded-full bg-pending" aria-hidden />;
  }
}

export function ResultBadge({ result }: { result: RoundResult }) {
  return (
    <Badge variant="outline" className="gap-1">
      <ResultIcon result={result} />
      {RESULT_WORD[result]}
    </Badge>
  );
}
