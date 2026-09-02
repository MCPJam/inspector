import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mcpjam/design-system/tooltip";

/**
 * The marker that makes a required field LOOK required, for forms whose Save is
 * already gated on the field being filled. A gate nobody can see reads as a
 * bug — "I can create a scenario without an environment" was reported against a
 * screen that already refused to, because the only sign was an inert button.
 *
 * The glyph is decorative: assistive tech gets the word, and the control itself
 * still has to carry `aria-required` — this marks the LABEL, it does not
 * annotate the input. Hovering the glyph names it for everyone else — a bare
 * asterisk with no footnote to point at reads as a typo.
 *
 * Primary, not destructive: every Production Redesign frame draws the marker in
 * the brand colour, and red on a field nobody has touched yet reads as an error
 * that already happened.
 */
export function RequiredMark() {
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            aria-hidden="true"
            className="cursor-help font-medium text-primary"
            data-testid="required-mark"
          >
            *
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" variant="muted">
          Required
        </TooltipContent>
      </Tooltip>
      <span className="sr-only">(required)</span>
    </>
  );
}

/**
 * The legend a form shows once, near the top, so the marks below it need no
 * guessing. Only for forms that render at least one {@link RequiredMark}.
 */
export function RequiredLegend() {
  return (
    <p className="text-xs text-muted-foreground" data-testid="required-legend">
      <span aria-hidden="true" className="font-medium text-primary">
        *
      </span>{" "}
      Required field
    </p>
  );
}
