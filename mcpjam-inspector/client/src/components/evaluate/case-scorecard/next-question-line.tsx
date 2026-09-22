import { ArrowRight } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { nextQuestionFor, type NextQuestionState } from "./next-question";

export function NextQuestionLine({
  state,
  onAct,
}: {
  state: NextQuestionState;
  onAct?: (
    action: NonNullable<ReturnType<typeof nextQuestionFor>>["action"],
  ) => void;
}) {
  const next = nextQuestionFor(state);
  if (!next) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground"
      data-testid="next-question-line"
      data-action={next.action}
    >
      <span>{next.copy}</span>
      {onAct ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-1.5 text-[11px]"
          onClick={() => onAct(next.action)}
        >
          {next.actionLabel}
          <ArrowRight className="h-3 w-3" />
        </Button>
      ) : null}
    </div>
  );
}
