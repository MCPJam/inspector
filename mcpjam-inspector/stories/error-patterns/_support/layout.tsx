import * as React from "react";
import { cn } from "@mcpjam/design-system/cn";

/**
 * Framing for the before/after comparisons. Presentation only — no product
 * component should import anything from this file.
 *
 * Every error story in this folder is a pair: the version that shipped (or a
 * faithful composite of versions that shipped) beside the version that follows
 * the rules. Showing only the fixed version teaches the shape but not the
 * reason, and the reason is the part that transfers to the next error someone
 * writes.
 */

export function BeforeAfter({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "grid gap-6 lg:grid-cols-2 lg:items-start",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Where a "before" specimen came from. Required on every before panel, because
 * an earlier draft captioned all of them "What shipped" when only some were
 * quotable from the codebase — which is the kind of overclaim that makes a
 * reader stop trusting the whole page.
 */
export type Provenance = "shipped" | "reported" | "composite" | "illustrative";

const PROVENANCE_LABEL: Record<Provenance, { tag: string; title: string }> = {
  shipped: {
    tag: "Shipped",
    title: "Real copy. The string is in the codebase.",
  },
  reported: {
    tag: "Reported",
    title:
      "Reported by a teammate from the live product. The string is not in this repo, so the wording is as they quoted it.",
  },
  composite: {
    tag: "Composite",
    title:
      "Assembled from phrasings that each appear in the codebase, but this exact string does not.",
  },
  illustrative: {
    tag: "Illustrative",
    title:
      "Written for this page to demonstrate the rule. Plausible, but not copy we shipped.",
  },
};

export function Panel({
  kind,
  caption,
  provenance,
  broken,
  children,
}: {
  kind: "before" | "after";
  /** One line on what this column is showing. */
  caption: string;
  /** Required on a "before" panel; ignored on an "after". */
  provenance?: Provenance;
  /**
   * For a "before" panel: which checks it fails, each as a short phrase.
   * For an "after" panel: which checks it now satisfies.
   */
  broken?: string[];
  children: React.ReactNode;
}) {
  const isBefore = kind === "before";

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
              isBefore
                ? "border-destructive/30 text-destructive"
                : "border-success/40 text-success",
            )}
          >
            {isBefore ? "Before" : "After"}
          </span>

          {isBefore && provenance ? (
            <span
              title={PROVENANCE_LABEL[provenance].title}
              className="inline-flex w-fit items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
            >
              {PROVENANCE_LABEL[provenance].tag}
            </span>
          ) : null}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {caption}
        </p>
      </header>

      {/* The specimen sits on `--background` so it is read against the surface
          it ships on, not against the docs page's own card fill. */}
      <div className="rounded-lg border border-border bg-background p-4">
        {children}
      </div>

      {broken?.length ? (
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {broken.map((item) => (
            <li key={item} className="flex gap-2">
              <span
                aria-hidden
                className={cn(
                  "mt-px font-mono",
                  isBefore ? "text-destructive" : "text-success",
                )}
              >
                {isBefore ? "✗" : "✓"}
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/**
 * A neutral stand-in for whatever surface the error appears on — a settings
 * panel, a server card, a dialog body. Keeps the stories from implying that a
 * pattern belongs to one specific screen.
 */
export function SurfaceFrame({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {children}
    </div>
  );
}
