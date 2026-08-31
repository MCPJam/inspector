import { SCORE_PREVIEW_DIMENSIONS } from "./score-runner-view-model";

const PREVIEW_SCORES = ["75", "77", "100", "100", "88"] as const;
const PREVIEW_STATUSES = [
  "MIXED",
  "INCOMPLETE",
  "PASSED",
  "PASSED",
  "REVIEW",
] as const;

/**
 * The Paper mock's 432px bar, kept as proportions rather than pixel widths:
 * the card narrows on mobile, where fixed widths pushed the trailing
 * segments past the `overflow-hidden` edge.
 */
const PREVIEW_BAR_SEGMENTS = [
  { color: "bg-[#3D8A5A]", share: 241 },
  { color: "bg-[#C45A3A]", share: 31 },
  { color: "bg-[#C49A4A]", share: 27 },
  { color: "bg-[var(--score-border)]", share: 103 },
  { color: "bg-[#1A1918]", share: 30 },
] as const;

export function ScorePreviewCard({ compact = false }: { compact?: boolean }) {
  return (
    <aside
      aria-hidden="true"
      className="score-preview-card flex w-full flex-col gap-4 rounded-md border border-[var(--score-border)] bg-[var(--score-card)] p-6 xl:w-[480px] xl:shrink-0"
    >
      <div className="font-[family-name:var(--font-score-sans)] text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--score-primary)]">
        Overall · run 2026-08-26
      </div>
      <div className="flex items-baseline justify-between xl:w-[432px]">
        <div className="font-[family-name:var(--font-score-mono)] text-[13px] leading-[18px] text-[var(--score-muted)]">
          mcp.monday.com
        </div>
        <div className="font-[family-name:var(--font-score-display)] text-[64px] font-extrabold leading-16 tracking-[-0.04em] text-[var(--score-primary)]">
          84
        </div>
      </div>
      {!compact && (
        <>
          <div className="flex flex-col border-t border-[var(--score-border)] pt-2 xl:w-[432px]">
            {SCORE_PREVIEW_DIMENSIONS.map((label, index) => (
              <div key={label} className="flex h-9 items-center">
                <div className="grow text-[14px] leading-5 text-[var(--score-fg)]">
                  {label}
                </div>
                <div className="w-12 shrink-0 font-[family-name:var(--font-score-mono)] text-[13px] font-medium leading-[18px] text-[var(--score-fg)]">
                  {PREVIEW_SCORES[index]}
                </div>
                <div
                  className={`w-[88px] shrink-0 text-[11px] leading-4 tracking-[0.08em] ${
                    PREVIEW_STATUSES[index] === "PASSED"
                      ? "text-[var(--score-muted)]"
                      : "text-[var(--score-primary)]"
                  }`}
                >
                  {PREVIEW_STATUSES[index]}
                </div>
              </div>
            ))}
          </div>
          <div className="flex h-2 overflow-hidden rounded">
            {PREVIEW_BAR_SEGMENTS.map(({ color, share }) => (
              <div
                key={color}
                className={color}
                style={{ flex: `${share} 1 0%` }}
              />
            ))}
          </div>
        </>
      )}
      <div className="text-xs leading-4 text-[var(--score-muted)]">
        113 checks. 63 passed, 8 failed.
      </div>
    </aside>
  );
}
