import { useReducedMotion } from "framer-motion";

/** Per Framer-Motion.md — natural UI motion */
export const springGentle = {
  type: "spring" as const,
  stiffness: 300,
  damping: 24,
};

export const springBouncy = {
  type: "spring" as const,
  stiffness: 400,
  damping: 20,
};

export const springSnappy = {
  type: "spring" as const,
  stiffness: 520,
  damping: 28,
};

export const VIEWPORT_ONCE = { once: true, amount: 0.35 } as const;

export function useDiagramMotion() {
  const reduce = useReducedMotion() ?? false;
  return { reduce };
}
