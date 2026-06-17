import { cn } from "@/lib/utils";
import { useChatboxHostTheme } from "@/contexts/chatbox-client-style-context";
import perplexityLogo from "/perplexity_logo.svg";

/**
 * Perplexity's thinking indicator — its spinning brand mark next to a
 * shimmering "Thinking" label, recreated from a live perplexity.ai DevTools
 * capture. The captured status text sits in a `.shimmer` wrapper running
 * `@keyframes shimmer` at `1.2s ease infinite` (a `mask-position` sweep) and
 * paints the verb in Perplexity's muted teal — `color(srgb 0.305882 0.6
 * 0.639216)` ≈ `#4E99A3`. The mark spins alongside it (the rotating logo the
 * user observed while the client was thinking).
 *
 * We render the shimmer via the codebase's established `background-clip: text`
 * gradient sweep (same idiom as Cursor/Codex) rather than Perplexity's
 * `mask-position` technique — visually identical, and it inherits the tested
 * reduced-motion fallback. Colors and timing are taken verbatim from the
 * capture. Visual rules live in `index.css` (`.perplexity-shimmer-text`,
 * `.perplexity-spin`).
 *
 * Honors `prefers-reduced-motion` (stops the spin, freezes the shimmer to the
 * solid teal base). Registry-shaped: accepts only `className`.
 */
export function PerplexityShimmerIndicator({
  className,
}: {
  className?: string;
}) {
  // Chat-shell host theme. Falls back to "dark" to match the rest of the
  // inspector's "no chatbox context" behavior (see CopilotMessageHeader).
  const chatboxHostTheme = useChatboxHostTheme() ?? "dark";

  return (
    <span
      data-testid="loading-indicator-perplexity"
      aria-live="polite"
      className={cn("inline-flex min-h-6 items-center gap-2", className)}
    >
      <img
        src={perplexityLogo}
        alt=""
        aria-hidden="true"
        data-testid="loading-indicator-perplexity-logo"
        className="perplexity-spin block size-4 shrink-0 rounded-[4px]"
      />
      <span
        aria-hidden="true"
        data-testid="loading-indicator-perplexity-label"
        data-theme={chatboxHostTheme}
        className="perplexity-shimmer-text text-sm leading-5 font-medium"
      >
        Thinking
      </span>
      <span className="sr-only">Thinking</span>
    </span>
  );
}
