/**
 * The Paper send-off mark, cropped to the dart. Remaining black in the
 * asset is the void — lighten blend drops it out against the ground.
 */
export function ScorePlane({ className }: { className?: string }) {
  return (
    <img
      src="/score-plane.png?v=2"
      alt=""
      className={`score-preview-plane-mark ${className ?? ""}`}
    />
  );
}
