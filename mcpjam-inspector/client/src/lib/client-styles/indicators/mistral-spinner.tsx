import { cn } from "@/lib/utils";
import { useChatboxHostTheme } from "@/contexts/chatbox-client-style-context";

/**
 * Mistral Le Chat thinking indicator — the brand's iconic morphing
 * five-square loader followed by a shimmering "Thinking" label, captured
 * verbatim from Le Chat's DevTools while the assistant was reasoning.
 *
 * The loader is a self-contained SMIL animation (no CSS): a 200×200
 * viewBox holds five 40×40 squares that slide between grid cells over
 * 1.033s on spline easing, recycling Mistral's orange→amber ramp
 * (#fa500f / #ff8205 / #ffaf01). Values/keySplines/keyTimes are copied
 * exactly off the live `<animateTransform>` nodes — this IS Le Chat's
 * loader, not an approximation.
 *
 * The "Thinking" text uses Le Chat's `animate-shimmer-text` treatment: a
 * 200%-wide gradient clipped to the glyphs with a bright stripe sweeping
 * `150% → -50%` over 2s ease-in-out infinite (verbatim keyframe). The two
 * gradient tones derive from `--mistral-shimmer-{base,highlight}` so
 * `data-theme` can swap them; dark is the verbatim capture (base
 * `rgba(255,255,255,.498)`, highlight `#fff`), light inverts to a dark
 * base/highlight. Rule + keyframe live in `index.css`
 * (`.mistral-shimmer-text` / `@keyframes mistral-shimmer-text`).
 *
 * Replaces the earlier avatar-ring spinner — real Le Chat shows this
 * square loader + shimmer label during the thinking phase, not the "M"
 * mark with an orbiting arc.
 *
 * Registry-shaped: accepts only `className`.
 */
export function MistralSpinnerIndicator({ className }: { className?: string }) {
  // Chat-shell host theme. Falls back to "dark" to match the rest of the
  // inspector's "no chatbox context" behavior (see CopilotMessageHeader).
  const chatboxHostTheme = useChatboxHostTheme() ?? "dark";

  return (
    <span
      className={cn("inline-flex min-h-6 items-center gap-2", className)}
      aria-live="polite"
      data-testid="loading-indicator-mistral"
    >
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox="0 0 200 200"
        className="block size-4 shrink-0 overflow-hidden"
        data-testid="loading-indicator-mistral-loader"
      >
        <g transform="translate(180 179.997)">
          <animateTransform
            attributeName="transform"
            type="translate"
            calcMode="spline"
            dur="1.033s"
            repeatCount="indefinite"
            keyTimes="0;0.484;0.968;1"
            keySplines="0.88 0.14 0.12 0.86;0.88 0.14 0.12 0.86;0 0 1 1"
            values="180 179.997;20 180.003;180 179.997;180 179.997"
          />
          <rect fill="#fa500f" x="-20" y="-20.003" width="40" height="40.006" />
        </g>
        <g transform="translate(20 140.003)">
          <animateTransform
            attributeName="transform"
            type="translate"
            calcMode="spline"
            dur="1.033s"
            repeatCount="indefinite"
            keyTimes="0;0.484;0.968;1"
            keySplines="0.88 0.139 0.12 0.861;0.88 0.139 0.12 1;0 0 1 1"
            values="20 140.003;140.613 140.003;20 140.003;20 140.003"
          />
          <rect fill="#ff8205" x="-20" y="-20.003" width="40" height="40.006" />
        </g>
        <g transform="translate(100 100.003)">
          <animateTransform
            attributeName="transform"
            type="translate"
            calcMode="spline"
            dur="1.033s"
            repeatCount="indefinite"
            keyTimes="0;0.306;0.661;0.968;1"
            keySplines="0.167 0.167 0.12 0.86;0.88 0.14 0.12 0.86;0.88 0.14 0.833 0.833;0 0 1 1"
            values="100 100.003;20 100.003;180 100.003;100 100.003;100 100.003"
          />
          <rect fill="#ffaf01" x="-20" y="-20.003" width="40" height="40.006" />
        </g>
        <g transform="translate(180 60.003)">
          <animateTransform
            attributeName="transform"
            type="translate"
            calcMode="spline"
            dur="1.033s"
            repeatCount="indefinite"
            keyTimes="0;0.484;0.968;1"
            keySplines="0.42 0 0.58 1;0.42 0 0.58 1;0 0 1 1"
            values="180 60.003;20 60.003;180 60.003;180 60.003"
          />
          <rect fill="#ff8205" x="-20" y="-20.003" width="40" height="40.006" />
        </g>
        <g transform="translate(20 20.003)">
          <animateTransform
            attributeName="transform"
            type="translate"
            calcMode="spline"
            dur="1.033s"
            repeatCount="indefinite"
            keyTimes="0;0.484;0.968;1"
            keySplines="0.88 0.14 0.12 0.86;0.88 0.14 0.12 0.86;0 0 1 1"
            values="20 20.003;180 20.003;20 20.003;20 20.003"
          />
          <rect fill="#fa500f" x="-20" y="-20.003" width="40" height="40.006" />
        </g>
      </svg>

      <span
        aria-hidden="true"
        data-theme={chatboxHostTheme}
        data-testid="loading-indicator-mistral-label"
        className="mistral-shimmer-text text-sm leading-5 font-medium"
      >
        Thinking
      </span>
      <span className="sr-only">Thinking</span>
    </span>
  );
}
