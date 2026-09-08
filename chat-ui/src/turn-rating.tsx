import { useEffect, useState } from "react";
import { Star, ThumbsDown, ThumbsUp } from "lucide-react";

import { cn } from "./internal/cn";

const STARS = [1, 2, 3, 4, 5] as const;

/** Thumbs, worst-first, so the row reads left-to-right like the star scale. */
const THUMBS = [
  { value: 0, label: "Thumbs down", Icon: ThumbsDown },
  { value: 1, label: "Thumbs up", Icon: ThumbsUp },
] as const;

export type TurnRatingStatus = "idle" | "pending" | "submitted" | "error";

/**
 * Which control the tester sees. The host picks it from the scenario's
 * `perTurnFeedback.style`; both emit the same `onSubmit({value, comment})`
 * contract, only the value domain differs.
 */
export type TurnRatingVariant = "stars" | "thumbs";

/**
 * What a screen reader hears for a RECORDED rating. Spelled out, because the
 * read-only row is a single image: five separate star icons would otherwise
 * announce as five things, none of which says what the tester chose.
 */
function readOnlyRatingLabel(
  variant: TurnRatingVariant,
  value: number | undefined
): string {
  if (value === undefined) return "No rating left";
  if (variant === "thumbs") {
    return value === 1 ? "Tester rated thumbs up" : "Tester rated thumbs down";
  }
  return `Tester rated ${value} of 5`;
}

export interface TurnRatingProps {
  /**
   * Current rating: 1–5 for `stars`, or 0|1 for `thumbs`. Absent ⇒ nothing
   * rated yet.
   */
  value?: number;
  comment?: string;
  status?: TurnRatingStatus;
  /** Display-only (session detail view): no inputs, no submit. */
  readOnly?: boolean;
  /** Which control to render. Default `stars`. */
  variant?: TurnRatingVariant;
  /** Label above the control. Falsy ⇒ the default copy. */
  title?: string;
  commentPlaceholder?: string;
  submitLabel?: string;
  /** Shown once a rating has landed. Falsy ⇒ the default copy. */
  thanksMessage?: string;
  onSubmit?: (next: { value: number; comment?: string }) => void;
  className?: string;
}

/**
 * Per-turn rating widget: five stars (or 👍/👎) plus an optional comment.
 *
 * PRESENTATIONAL ONLY — no mutation, no store, no network. The host owns
 * submission and passes `status` back in, which is what lets the same
 * component serve the interactive tester page and the read-only session
 * detail view without a second implementation.
 *
 * `submitted` is a resting state, not a terminal one: a tester can revise a
 * rating, so the control stays interactive and re-clicking it opens the
 * comment row again. The host's mutation upserts, so a revision replaces
 * rather than accumulates.
 *
 * THUMBS IS A VARIANT, NOT A SIBLING COMPONENT. Everything except the row of
 * buttons is shared — the comment editor and its collapse-on-success rule,
 * the four status states, the two rehydration effects, the read-only render,
 * and the `draftValue === undefined` sentinel that distinguishes "unrated"
 * from "rated 0" (which a thumbs-down actually is, and which a second
 * implementation would be free to get wrong).
 */
export function TurnRating({
  value,
  comment,
  status = "idle",
  readOnly = false,
  variant = "stars",
  title,
  commentPlaceholder,
  submitLabel,
  thanksMessage,
  onSubmit,
  className,
}: TurnRatingProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [draftValue, setDraftValue] = useState<number | undefined>(value);
  const [draftComment, setDraftComment] = useState(comment ?? "");
  // Whether the comment row is open. Opening on the first star click keeps the
  // resting transcript quiet — a row of stars under every response is already
  // a lot of chrome, and a text input under every response is too much.
  const [expanded, setExpanded] = useState(false);
  // A comment submit is in flight. The editor collapses on its success and
  // stays open on its failure, so a save that did not land keeps both the
  // draft and the way to retry it.
  const [awaitingCommentSave, setAwaitingCommentSave] = useState(false);

  // Follow the host when it rehydrates a stored rating (page reload) or a
  // submission resolves. Guarded on identity so it never clobbers a draft the
  // user is mid-way through typing.
  useEffect(() => {
    setDraftValue(value);
  }, [value]);
  useEffect(() => {
    setDraftComment(comment ?? "");
  }, [comment]);

  // Resolve the comment submit. Only `submitted` closes the editor — a star
  // click also reaches `submitted` but never sets the flag, so re-rating
  // cannot yank the input out from under someone about to type in it.
  useEffect(() => {
    if (!awaitingCommentSave) return;
    if (status === "submitted") {
      setAwaitingCommentSave(false);
      setExpanded(false);
    } else if (status === "error") {
      setAwaitingCommentSave(false);
    }
  }, [awaitingCommentSave, status]);

  const effective = hovered ?? draftValue ?? 0;
  const disabled = readOnly || status === "pending";

  function selectValue(next: number) {
    if (disabled) return;
    setDraftValue(next);
    setExpanded(true);
    // Submit the rating immediately. A rating that only counts once someone
    // also writes a comment is a rating most testers never leave; the comment
    // is a second, optional submit on top.
    //
    // The SAVED comment rides along — `comment`, not `draftComment`. Omitting
    // it means "leave the stored comment alone" to the backend, but the host's
    // optimistic state would still show the turn as uncommented until the next
    // round-trip, blanking an annotation the server quietly kept.
    //
    // Deliberately not the draft: text someone typed and has not sent is not a
    // rating they submitted, and changing their mind about the rating is not
    // consent to publish it. The draft stays in the editor for `submitComment`.
    const saved = comment?.trim() ?? "";
    onSubmit?.({
      value: next,
      ...(saved.length > 0 ? { comment } : {}),
    });
  }

  function submitComment() {
    if (disabled || draftValue === undefined) return;
    setAwaitingCommentSave(true);
    onSubmit?.({ value: draftValue, comment: draftComment });
  }

  return (
    <div
      className={cn(
        "mcpjam-chat-turn-rating mt-2 flex flex-col gap-2 text-xs",
        className
      )}
      data-status={status}
    >
      <div className="flex flex-wrap items-center gap-2">
        {title !== "" ? (
          <span className="text-muted-foreground">
            {title || (readOnly ? "Tester rating" : "Rate this response")}
          </span>
        ) : null}
        {readOnly ? (
          /**
           * A RECORD, not a control.
           *
           * The version this replaces rendered the same `<button role="radio">`
           * row with `disabled` — visually identical to the live widget, so a
           * PM reading a recorded session tried to click it: "it looks like
           * I'm selecting because it's the same design as these guys, but I
           * can't select it" (BB-198). `disabled` is invisible when the only
           * difference it makes is a hover colour nobody hovers for.
           *
           * Icons in a labelled group instead: same shapes, same amber, no
           * button affordance and nothing focusable. `aria-checked` is gone
           * too — a checkbox that cannot be checked is a lie to a screen
           * reader as much as to a mouse.
           */
          <span
            role="img"
            aria-label={readOnlyRatingLabel(variant, value)}
            className="flex items-center gap-0.5"
            data-testid="turn-rating-readonly"
          >
            {variant === "thumbs"
              ? THUMBS.filter(
                  ({ value: thumbValue }) => thumbValue === value
                ).map(({ value: thumbValue, Icon }) => (
                  <Icon
                    key={thumbValue}
                    className="h-4 w-4 text-amber-500"
                    fill="currentColor"
                    aria-hidden
                  />
                ))
              : STARS.map((star) => (
                  <Star
                    key={star}
                    className={cn(
                      "h-4 w-4",
                      star <= (value ?? 0)
                        ? "text-amber-500"
                        : "text-muted-foreground/40"
                    )}
                    fill={star <= (value ?? 0) ? "currentColor" : "none"}
                    aria-hidden
                  />
                ))}
          </span>
        ) : (
          <div
            role="radiogroup"
            aria-label={title || "Rate this response"}
            className="flex items-center gap-0.5"
            onMouseLeave={() => setHovered(null)}
          >
            {variant === "thumbs"
              ? THUMBS.map(({ value: thumbValue, label, Icon }) => {
                  // Compared against the DRAFT, not `effective`: a thumb is
                  // picked, not accumulated, so there is no "fills up to here"
                  // hover preview to mirror — hovering 👍 must not light 👎.
                  const selected = draftValue === thumbValue;
                  return (
                    <button
                      key={thumbValue}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      aria-label={label}
                      disabled={disabled}
                      className={cn(
                        "rounded-sm p-0.5 text-muted-foreground transition-colors",
                        !disabled &&
                          "hover:text-amber-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                        selected && "text-amber-500",
                        disabled && "cursor-default"
                      )}
                      onClick={() => selectValue(thumbValue)}
                    >
                      <Icon
                        className="h-4 w-4"
                        fill={selected ? "currentColor" : "none"}
                        aria-hidden
                      />
                    </button>
                  );
                })
              : STARS.map((star) => (
                  <button
                    key={star}
                    type="button"
                    role="radio"
                    aria-checked={draftValue === star}
                    aria-label={`${star} of 5`}
                    disabled={disabled}
                    className={cn(
                      "rounded-sm p-0.5 text-muted-foreground transition-colors",
                      !disabled &&
                        "hover:text-amber-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      star <= effective && "text-amber-500",
                      disabled && "cursor-default"
                    )}
                    onMouseEnter={() => !disabled && setHovered(star)}
                    onClick={() => selectValue(star)}
                  >
                    <Star
                      className="h-4 w-4"
                      // Fill tracks hover as well as selection, so the row reads
                      // as "clicking here gives 3 stars" before the click.
                      fill={star <= effective ? "currentColor" : "none"}
                      aria-hidden
                    />
                  </button>
                ))}
          </div>
        )}
        {status === "pending" ? (
          <span className="text-muted-foreground">Saving…</span>
        ) : null}
        {status === "error" ? (
          <span className="text-destructive">Could not save — try again</span>
        ) : null}
        {status === "submitted" && !expanded ? (
          <span className="text-muted-foreground">
            {thanksMessage || "Thanks"}
          </span>
        ) : null}
      </div>

      {readOnly ? (
        comment ? (
          <p className="text-muted-foreground italic">“{comment}”</p>
        ) : null
      ) : expanded ? (
        /**
         * WIDTH-CAPPED, so Send stays next to what you typed.
         *
         * `flex-1` on the input alone let this row grow to the transcript's
         * measure — on a wide session that put the button most of a screen
         * away from the stars that opened it: "it's all the way to the right,
         * I never even saw it until you mentioned it" (BB-198). The cap keeps
         * the pair together under the response being rated, and `w-full`
         * keeps it honest on a narrow one.
         */
        <div className="flex w-full max-w-md items-center gap-2">
          <input
            type="text"
            value={draftComment}
            disabled={disabled}
            placeholder={commentPlaceholder || "Add a comment (optional)"}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onChange={(event) => setDraftComment(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitComment();
            }}
          />
          <button
            type="button"
            disabled={disabled}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            onClick={submitComment}
          >
            {submitLabel || "Send"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
