import type { SequenceDiagramActorConfig } from "./types";
import { MIN_ACTOR_SPACING, DIAGRAM_MARGIN } from "./constants";

/**
 * Compute x-positions for actors, spreading them evenly.
 * Used by lifecycle wrapper. OAuth uses its own fixed positions.
 */
export function computeActorXPositions(
  actors: SequenceDiagramActorConfig[],
): Record<string, number> {
  const positions: Record<string, number> = {};
  actors.forEach((actor, i) => {
    positions[actor.id] = DIAGRAM_MARGIN + i * MIN_ACTOR_SPACING;
  });
  return positions;
}
