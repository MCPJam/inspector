/**
 * The Paper send-off mark: a faceted dart in the score primary, pointed
 * up-right. Used when the preview card folds into a plane.
 */
export function ScorePlane({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 160 160"
      className={className}
      aria-hidden="true"
      fill="none"
    >
      <path d="M22 86 L148 36 L88 92 Z" fill="var(--score-primary)" />
      <path d="M88 92 L148 36 L108 108 Z" fill="#D46848" />
      <path d="M22 86 L88 92 L68 124 Z" fill="#C45A3A" />
      <path d="M22 86 L88 92 L78 108 Z" fill="#E07856" />
    </svg>
  );
}
