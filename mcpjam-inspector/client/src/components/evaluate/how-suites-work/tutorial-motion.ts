import { useReducedMotion } from "framer-motion";

export type TutorialEase = (properties: string[], delayMs?: number) => string;

/** Builds the tutorial's step-change transitions; none under reduced motion. */
export function useTutorialEase(): TutorialEase {
  const reduce = useReducedMotion() ?? false;
  return (properties, delayMs = 0) =>
    reduce
      ? "none"
      : properties
          .map((p) => `${p} 320ms cubic-bezier(.2,.8,.2,1) ${delayMs}ms`)
          .join(", ");
}
