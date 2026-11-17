import { useImperativeHandle, useRef, type Ref } from "react";
import type { TourPoint } from "./geometry";

export type GhostCursorHandle = {
  show: (at: TourPoint) => void;
  hide: () => void;
  moveTo: (to: TourPoint, durationMs: number) => Promise<void>;
  click: () => Promise<void>;
  position: () => TourPoint;
};

const EASE = "cubic-bezier(0.65, 0, 0.35, 1)";
const CLICK_MS = 520;

function translate(point: TourPoint): string {
  return `translate(${point.x}px, ${point.y}px)`;
}

/** Runs a Web Animation when the browser has them; resolves at once otherwise. */
async function play(
  el: Element,
  frames: Keyframe[],
  durationMs: number,
): Promise<void> {
  if (typeof el.animate !== "function" || durationMs <= 0) return;
  const animation = el.animate(frames, {
    duration: durationMs,
    easing: EASE,
  });
  await animation.finished;
}

/**
 * The orange pointer that "drives" the tour: glides to a control, presses
 * it with a ripple, and types. Purely visual; the tour switches screens
 * itself when a scripted click lands.
 */
export function TourGhostCursor({ ref }: { ref: Ref<GhostCursorHandle> }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<SVGSVGElement>(null);
  const rippleRef = useRef<HTMLSpanElement>(null);
  const pos = useRef<TourPoint>({ x: 0, y: 0 });

  useImperativeHandle(
    ref,
    () => ({
      show(at) {
        const el = rootRef.current;
        if (!el) return;
        pos.current = at;
        el.style.transform = translate(at);
        el.style.opacity = "1";
      },
      hide() {
        if (rootRef.current) rootRef.current.style.opacity = "0";
      },
      async moveTo(to, durationMs) {
        const el = rootRef.current;
        if (!el) return;
        const from = pos.current;
        pos.current = to;
        await play(
          el,
          [{ transform: translate(from) }, { transform: translate(to) }],
          durationMs,
        );
        el.style.transform = translate(to);
      },
      async click() {
        const pointer = pointerRef.current;
        const ripple = rippleRef.current;
        if (!pointer || !ripple) return;
        await Promise.all([
          play(
            pointer,
            [
              { transform: "scale(1)" },
              { transform: "scale(0.82)" },
              { transform: "scale(1)" },
            ],
            CLICK_MS * 0.6,
          ),
          play(
            ripple,
            [
              { transform: "translate(-50%, -50%) scale(0.3)", opacity: 0.9 },
              { transform: "translate(-50%, -50%) scale(1.6)", opacity: 0 },
            ],
            CLICK_MS,
          ),
        ]);
      },
      position: () => pos.current,
    }),
    [],
  );

  return (
    <div
      ref={rootRef}
      aria-hidden
      data-testid="guided-tour-cursor"
      className="pointer-events-none absolute left-0 top-0 z-20 opacity-0 transition-opacity duration-200"
    >
      <span
        ref={rippleRef}
        className="absolute left-0 top-0 h-10 w-10 rounded-full border-2 border-primary opacity-0"
      />
      <svg
        ref={pointerRef}
        width="22"
        height="22"
        viewBox="0 0 22 22"
        className="origin-top-left drop-shadow-sm"
      >
        <path
          d="M3 2 L3 18 L7.5 13.8 L10.6 20.4 L13.6 19 L10.6 12.6 L16.8 12.6 Z"
          className="fill-primary stroke-primary-foreground"
          strokeWidth={1.4}
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
