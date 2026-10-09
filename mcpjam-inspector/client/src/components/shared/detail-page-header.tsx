/**
 * Shared chrome for detail pages (Swarm run, User Testing scenario, …).
 *
 * Layout:
 *   Row: [back] | [title]  [tabs]          [meta] [actions]
 *   Optional body (children)
 *
 * Surfaces keep different title/body content; spacing, back-link style, and
 * tab placement live here so a chrome tweak applies everywhere.
 */
import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import {
  ViewModeSelector,
  type ViewModeSelectorOption,
} from "@/components/shared/view-mode-selector";
import { cn } from "@/lib/utils";

// The strip always yields to the trailing meta + actions. Tab buttons stay
// shrink-0, so a tight row scrolls ("Sessions" stays "Sessions") instead of
// painting over Complete. `lg:shrink-0` used to win at desktop viewports even
// when the sidebar had already eaten the width the strip needed.
const TAB_CLASSNAME =
  "w-auto min-w-0 shrink justify-start overflow-x-auto [&_button]:min-h-8 [&_button]:px-2.5 [&_button]:py-1 [&_button]:text-sm sm:[&_button]:min-h-8 sm:[&_button]:px-3 sm:[&_button]:text-sm md:[&_button]:min-h-8 lg:[&_button]:px-3.5";

/**
 * The way back out of a detail page.
 *
 * A RAISED CONTROL, not a text link. It used to be the literal character "←"
 * in front of muted text, which is the same treatment the rest of the header
 * gives to labels — so the one thing on the row you can press to leave looked
 * like the things you cannot press at all.
 *
 * `h-8` and `rounded-lg` are Edit and Open preview's, three controls along the
 * same row: a header whose buttons disagree about their own height or corners
 * reads as two designs sharing a strip.
 *
 * ON HOVER the arrow glides the way it points and darkens with the label. The
 * movement is the whole reason the icon lost its chip — a glyph that travels
 * inside a circle reads as a thing rattling in a box, and the circle was doing
 * no other work once the pill itself said "pressable".
 *
 * The transition sits on the element rather than inside the `:hover` state, so
 * it eases out on the way back as well as in — a transform declared only under
 * hover snaps home the moment the cursor leaves.
 *
 * `motion-reduce` takes the movement away and keeps the colour: the darkening
 * is the part that says "this is the thing under your cursor", and someone who
 * asked for less motion still needs that answer.
 */
export function DetailBackLink({
  label,
  onBack,
  testId,
}: {
  label: string;
  onBack: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onBack}
      className={cn(
        "group inline-flex h-8 shrink-0 items-center gap-2 rounded-lg",
        "border border-border/60 bg-card pl-2.5 pr-3 shadow-sm",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      )}
      data-testid={testId}
    >
      <ArrowLeft
        aria-hidden
        className={cn(
          "size-4 shrink-0 text-muted-foreground",
          // 5px over 300ms on an ease-out quint: far enough to register as
          // travel rather than a redraw, slow enough to be a glide rather than
          // a snap, and decelerating so it settles instead of stopping dead.
          // The first pass was 2px in 200ms and read as the icon jumping.
          // `translate`, NOT `transform`. Tailwind v4 compiles -translate-x to
          // the `translate` property (`translate: var(--tw-translate-x) …`),
          // so a transition naming `transform` animates a property that never
          // changes here and the arrow jumps to its new position instead of
          // travelling there. Verified against the built stylesheet.
          "transition-[color,translate] duration-300",
          "ease-[cubic-bezier(0.22,1,0.36,1)]",
          "group-hover:-translate-x-[5px] group-hover:text-foreground",
          "motion-reduce:transition-colors motion-reduce:group-hover:translate-x-0",
        )}
      />
      <span className="text-sm font-semibold text-muted-foreground transition-colors duration-300 group-hover:text-foreground">
        {label}
      </span>
    </button>
  );
}

export function DetailPageHeader<T extends string>({
  backLabel,
  onBack,
  backTestId,
  title,
  meta,
  actions,
  tabs,
  children,
  className,
  testId,
}: {
  backLabel: string;
  onBack: () => void;
  backTestId?: string;
  title: ReactNode;
  /** Outcome / count in the gap before the actions, not against the tabs. */
  meta?: ReactNode;
  actions?: ReactNode;
  /** Omit on sibling routes (e.g. User Testing Edit) that share this chrome. */
  tabs?: {
    value: T;
    options: readonly ViewModeSelectorOption<T>[];
    onChange: (value: T) => void;
    ariaLabel: string;
    indicatorId: string;
  };
  children?: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <div
      className={cn(
        "relative shrink-0 border-b border-border/40 px-8 pt-2.5 pb-2.5",
        className,
      )}
      data-testid={testId}
    >
      <div className="flex items-center justify-between gap-6">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <DetailBackLink
            label={backLabel}
            onBack={onBack}
            testId={backTestId}
          />
          <div
            className="hidden h-4 w-px shrink-0 bg-border/60 sm:block"
            aria-hidden="true"
          />
          {/* Bounds how far a long name can push the tabs right; past the cap
              the surface's own title ellipsizes. Names under it still size the
              slot to content, so the tab row is not pinned to one spot. */}
          <div className="min-w-[10rem] max-w-[52ch] shrink">{title}</div>
          {tabs ? (
            <>
              <div
                className="hidden h-4 w-px shrink-0 bg-border/60 sm:block"
                aria-hidden="true"
              />
              <ViewModeSelector
                value={tabs.value}
                options={tabs.options}
                onChange={tabs.onChange}
                ariaLabel={tabs.ariaLabel}
                indicatorId={tabs.indicatorId}
                className={TAB_CLASSNAME}
              />
            </>
          ) : null}
        </div>
        {meta || actions ? (
          <div className="flex shrink-0 items-center gap-3">
            {meta ? (
              <div className="flex items-center">{meta}</div>
            ) : null}
            {meta && actions ? (
              <div
                className="hidden h-4 w-px shrink-0 bg-border/60 sm:block"
                aria-hidden="true"
              />
            ) : null}
            {actions ? (
              <div className="flex shrink-0 items-center gap-2">{actions}</div>
            ) : null}
          </div>
        ) : null}
      </div>

      {children ? <div className="mt-3 min-w-0">{children}</div> : null}
    </div>
  );
}
