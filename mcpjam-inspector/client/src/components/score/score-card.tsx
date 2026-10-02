import { ScoreServerMark } from "./score-server-mark";

export type ScoreCardRow = {
  label: string;
  score: string;
  status: string;
  emphasize: boolean;
};

export type ScoreCardBarSegment = {
  colorClass: string;
  share: number;
};

export function ScoreCard({
  kicker,
  server,
  score,
  rows,
  segments,
  footer,
  compact = false,
  animated = true,
  departing = false,
}: {
  kicker: string;
  server: string;
  score: string;
  rows: readonly ScoreCardRow[];
  segments: readonly ScoreCardBarSegment[];
  footer: string;
  compact?: boolean;
  animated?: boolean;
  departing?: boolean;
}) {
  const motionClass = departing
    ? "score-card--depart"
    : animated
      ? "score-card--enter"
      : "";

  return (
    <div
      className={`score-card flex w-full flex-col gap-4 rounded-md border border-[var(--score-border)] bg-[var(--score-card)] p-6 ${motionClass}`}
    >
      <div className="score-card-kicker font-[family-name:var(--font-score-sans)] text-[11px] font-medium uppercase leading-[14px] tracking-[0.12em] text-[var(--score-primary)]">
        {kicker}
      </div>
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-end gap-2">
          <div className="score-card-number font-[family-name:var(--font-score-display)] text-[64px] font-extrabold leading-none tracking-[-0.04em] text-[var(--score-fg)]">
            {score}
          </div>
          <div className="mb-1.5 font-[family-name:var(--font-score-display)] text-[20px] font-extrabold leading-none text-[var(--score-muted)]">
            /100
          </div>
        </div>
        <div className="score-card-server flex min-w-0 items-center gap-2.5">
          <ScoreServerMark host={server} />
          <div className="truncate text-sm font-semibold leading-5 text-[var(--score-fg)]">
            {server}
          </div>
        </div>
      </div>
      {!compact && (
        <>
          <div className="flex flex-col border-t border-[var(--score-border)] pt-2">
            {rows.map((row, index) => (
              <div
                key={row.label}
                className="score-card-row flex h-9 items-center"
                style={{ animationDelay: `${40 + index * 50}ms` }}
              >
                <div className="grow text-[14px] leading-5 text-[var(--score-fg)]">
                  {row.label}
                </div>
                <div className="w-12 shrink-0 font-[family-name:var(--font-score-mono)] text-[13px] font-medium leading-[18px] text-[var(--score-fg)]">
                  {row.score}
                </div>
                <div
                  className={`w-[88px] shrink-0 text-[11px] leading-4 tracking-[0.08em] ${
                    row.status === "PASSED"
                      ? "text-[#3D8A5A]"
                      : row.emphasize
                        ? "text-[var(--score-primary)]"
                        : "text-[var(--score-muted)]"
                  }`}
                >
                  {row.status}
                </div>
              </div>
            ))}
          </div>
          <div className="score-card-bar flex h-2 overflow-hidden rounded">
            {segments.map((segment) => (
              <div
                key={`${segment.colorClass}-${segment.share}`}
                className={segment.colorClass}
                style={{ flex: `${segment.share} 1 0%` }}
              />
            ))}
          </div>
        </>
      )}
      <div className="score-card-footer text-xs leading-4 text-[var(--score-muted)]">
        {footer}
      </div>
    </div>
  );
}
