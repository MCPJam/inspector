export type TutorialTrigger = "first_visit" | "first_suite" | "menu";
export type TutorialAutoEvent = "evaluate_visit" | "suite_created";

/**
 * Whether an Evaluate event should auto-open the tutorial. It opens at most
 * once per browser, on whichever comes first, and never while the nav flag is
 * off or still loading.
 */
export function autoOpenTrigger(
  event: TutorialAutoEvent,
  ctx: { enabled: boolean; seen: boolean },
): TutorialTrigger | null {
  if (!ctx.enabled || ctx.seen) return null;
  return event === "evaluate_visit" ? "first_visit" : "first_suite";
}
