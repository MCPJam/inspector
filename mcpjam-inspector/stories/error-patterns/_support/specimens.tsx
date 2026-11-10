import * as React from "react";
import type { NormalizedError } from "@mcpjam/sdk/browser";
import { toast } from "@/lib/toast";

/**
 * Helpers that let a "before" panel show the real failure without anyone having
 * to click.
 *
 * The first version of these stories put a Connect button in the before column
 * and a caption saying "press Connect to raise the toast this actually
 * produced". That made the comparison useless to read: anyone scrolling the
 * page saw an idle form beside a finished design. The failure has to be ON
 * SCREEN for the before/after to mean anything.
 */

/**
 * Raises a real toast through the app's own wrapper (`@/lib/toast`, not sonner
 * directly, so it gets the longer error duration and the copy button) as soon
 * as the story mounts, and clears it on unmount.
 *
 * `duration: Infinity` pins it open. In the product it times out after a few
 * seconds, which is part of what is wrong with using a toast for these
 * messages — but a specimen that vanishes mid-read cannot be examined, so the
 * stories pin it and say so in the caption.
 *
 * The raiser is held in a ref so the effect can run exactly once on mount
 * while still calling the latest closure. Stories define it inline, so taking
 * it as a dependency would re-raise the toast on every render.
 */
export function useToastSpecimen(raise: (t: typeof toast) => string | number) {
  const raiseRef = React.useRef(raise);
  raiseRef.current = raise;

  React.useEffect(() => {
    // Clear anything a previous mount left behind before raising. React's dev
    // double-invoke mounts the story twice, and without this the specimen
    // stacks two identical toasts — which reads as a bug in the product rather
    // than a quirk of the harness. Switching stories can leave one behind too,
    // since the pinned duration means nothing expires on its own.
    toast.dismiss();

    const id = raiseRef.current(toast);

    // Braces matter: `toast.dismiss` returns the id, and an arrow returning a
    // value is not a valid effect destructor.
    return () => {
      toast.dismiss(id);
    };
  }, []);
}

/** What a story supplies. Everything but the prose has a sensible default. */
type ErrorSpecimen = {
  /** E2: what failed, and which thing it failed on. */
  title: string;
  /** E2: the one-line explanation under the title. */
  oneLine: string;
  /** E2: the cause — stated once, and only when genuinely known. */
  likelyCauses?: string[];
  /** E3: next steps in words, for what no button can do. */
  nextSteps?: string[];
  /** E1: the raw text, parked in the collapsed detail rather than the message. */
  rawMessage?: string;
  severity?: NormalizedError["severity"];
  slug?: string;
  docsAnchor?: string;
};

/**
 * Builds a `NormalizedError` — the shape `sdk/src/error-describer/catalog.ts`
 * produces and the real ErrorCard renders.
 *
 * Stories pass one of these rather than a bare `Error` so the card shows what
 * it shows in the product when a failure HAS a diagnosis. Passing a bare
 * `Error` would exercise the fallback path instead, which is a different and
 * much thinner thing.
 *
 * Every field is written out rather than spread over a `Partial`, so this stays
 * a real `NormalizedError` with no cast: if the catalog's shape gains a
 * required field, this fails to compile instead of lying at runtime.
 */
export function normalizedError(spec: ErrorSpecimen): NormalizedError {
  return {
    slug: spec.slug ?? "stories/specimen",
    title: spec.title,
    oneLine: spec.oneLine,
    likelyCauses: spec.likelyCauses ?? [],
    nextSteps: spec.nextSteps ?? [],
    docsAnchor: spec.docsAnchor ?? "",
    severity: spec.severity ?? "error",
    rawMessage: spec.rawMessage ?? "",
  };
}
