import { cn } from "@/lib/utils";

/**
 * Microsoft 365 Copilot thinking indicator — three gradient circles
 * passing the baton over 3.6s. Faithful (within reason) to the real
 * product's Houdini paint worklet `paint(pulsingDot)`:
 *
 *   - 14×14px container (matches `min-height/min-width: 14px` on the
 *     real `.fai-CoTLatencyAnimation` element)
 *   - 3 circles, each with its own 2-color brand gradient (pink/coral,
 *     teal/green, blue/purple), the same six colors Copilot exposes
 *     via `--fai-chain-of-thought-latency-circle-{1,2,3}-gradient-color-{1,2}`
 *   - Animation: `cubic-bezier(0.8, 0, 0.2, 1)` (Fluent's
 *     `--curveEasyEaseMax`), 3.6s, infinite — copied off the live
 *     `animation-*` computed styles
 *   - Per-circle keyframes are the per-property unwrap of the original
 *     7-stop `@keyframes r1a0u976` rule (which encodes all three
 *     circles together via CSS custom properties feeding the paint
 *     worklet). See `client/src/index.css` for the unwrapped form.
 *
 * The original animates `--scale-{N}` (0%/100%), `--opacity-{N}` (0/1),
 * and `--x-position-{N}` (0/50/100, interpreted by the worklet). We map
 * those to a literal CSS `transform: translateX() scale()` per circle
 * (centered at the box midpoint, ±7px slides). Visually
 * indistinguishable from the real product at 14px without buying into
 * the paint worklet (unsupported in Firefox).
 *
 * Honors `prefers-reduced-motion` via the media query in index.css.
 */
export function CopilotPulseIndicator({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-flex min-h-6 items-center", className)}
      aria-live="polite"
    >
      <span className="sr-only">Thinking</span>
      <span
        aria-hidden="true"
        data-testid="loading-indicator-copilot-pulse"
        className="copilot-pulse-indicator"
      >
        <span
          data-testid="loading-indicator-copilot-pulse-circle-1"
          className="copilot-pulse-indicator__circle copilot-pulse-indicator__circle--1"
        />
        <span
          data-testid="loading-indicator-copilot-pulse-circle-2"
          className="copilot-pulse-indicator__circle copilot-pulse-indicator__circle--2"
        />
        <span
          data-testid="loading-indicator-copilot-pulse-circle-3"
          className="copilot-pulse-indicator__circle copilot-pulse-indicator__circle--3"
        />
      </span>
    </span>
  );
}
