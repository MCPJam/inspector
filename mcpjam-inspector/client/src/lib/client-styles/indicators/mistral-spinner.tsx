import { cn } from "@/lib/utils";

const SPINNER_CIRCUMFERENCE = 56.548667764616276;
const SPINNER_OFFSET = 42.411500823462205;

export function MistralSpinnerIndicator({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "relative inline-flex min-h-12 min-w-12 items-center justify-center leading-none",
        className
      )}
      aria-live="polite"
      data-testid="loading-indicator-mistral"
    >
      <span className="sr-only">Thinking</span>
      <svg
        viewBox="0 0 24 24"
        className="absolute size-12"
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
            stroke: "var(--bg-badge-orange, rgba(255, 138, 0, 0.28))",
          }}
        />
        <g
          className="animate-spin motion-reduce:animate-none"
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
            strokeDasharray={SPINNER_CIRCUMFERENCE}
            strokeDashoffset={SPINNER_OFFSET}
            transform="rotate(-90, 12, 12)"
            style={{
              stroke: "var(--bg-basic-orange-strong, #ff8a00)",
            }}
          />
        </g>
      </svg>
      <span
        className="relative z-10 flex items-center justify-center"
        aria-hidden="true"
        data-testid="loading-indicator-mistral-mark"
        style={{
          width: 28,
          height: 28,
          backgroundColor:
            "var(--bg-brand-500, var(--bg-basic-orange-strong, #ff8a00))",
          color: "var(--text-white-default, #ffffff)",
        }}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          width="21"
          height="21"
          fill="currentColor"
        >
          <path d="M13.3715 16.358H16.1144V13.6486H13.3712L13.3715 16.358H10.6283V13.6486H7.88568V16.358H10.6283V19.0676H2.3999V16.358H5.14279V5.52002H7.88568V8.22963H10.6286V10.939H13.3715V8.22963H16.1144V5.52002H18.8572V16.358H21.5999V19.0676H13.3715V16.358Z" />
        </svg>
      </span>
    </span>
  );
}
