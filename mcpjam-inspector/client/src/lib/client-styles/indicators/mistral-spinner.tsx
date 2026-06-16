import { cn } from "@/lib/utils";
import { MistralStaticAvatar } from "@/lib/client-styles/mistral-avatar";

export function MistralSpinnerIndicator({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "mistral-spinner-indicator relative inline-flex size-12 items-center justify-center leading-none",
        className
      )}
      aria-live="polite"
      data-testid="loading-indicator-mistral"
    >
      <span className="sr-only">Thinking</span>
      <MistralStaticAvatar
        avatarClassName="rounded-full"
        borderRadius="50%"
        className="relative size-12"
        testId="loading-indicator-mistral-mark"
      >
        <svg
          viewBox="0 0 24 24"
          className="absolute inset-0 size-12"
          role="progressbar"
          aria-label="Loading"
          fill="none"
          data-testid="loading-indicator-mistral-spinner"
        >
          <circle
            cx="12"
            cy="12"
            r="9"
            strokeWidth="2.5"
            style={{
              stroke: "var(--bg-badge-orange, var(--mistral-spinner-badge))",
            }}
          />
          <g
            className="animate-spin"
            style={{
              transformOrigin: "center center",
              transformBox: "view-box",
            }}
          >
            <circle
              cx="12"
              cy="12"
              r="9"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray="56.548667764616276"
              strokeDashoffset="42.411500823462205"
              transform="rotate(-90, 12, 12)"
              style={{
                stroke:
                  "var(--bg-basic-orange-strong, var(--mistral-spinner-strong))",
              }}
            />
          </g>
        </svg>
      </MistralStaticAvatar>
    </div>
  );
}
