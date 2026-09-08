/**
 * The Swarm empty-state graphic: a short row of the project's pixel golems
 * jumping on a loop (BB-120).
 *
 * Reuses `PersonaPixelAvatar` rather than shipping a separate illustration, so
 * the empty state shows the same characters a real swarm will populate — the
 * graphic is a preview of the personas, not decoration.
 *
 * Motion is CSS-only (`animate-swarm-hero-jump`, which honors
 * `prefers-reduced-motion`). Each character carries a negative delay so the
 * row lands as a wave instead of four sprites moving in lockstep.
 */

import {
  PersonaPixelAvatar,
  type PersonaPixelPose,
} from "@/components/swarms/persona-pixel-avatar";
import { cn } from "@/lib/utils";

/**
 * Fixed looks, in the design's left-to-right order: Basalt, Amethyst, Jade,
 * Oxide. Pinned by index instead of seeded so the hero always shows four
 * distinct silhouettes in the frame's colors — a hashed seed would drift the
 * moment the family or mineral lists grow. The seeds still drive the
 * per-character procedural details (chipped corners, sensor placement).
 */
const HERO_CHARACTERS = [
  { seed: "swarm-hero-basalt", shapeIndex: 0, paletteIndex: 0 },
  { seed: "swarm-hero-amethyst", shapeIndex: 1, paletteIndex: 5 },
  { seed: "swarm-hero-jade", shapeIndex: 4, paletteIndex: 1 },
  { seed: "swarm-hero-oxide", shapeIndex: 5, paletteIndex: 2 },
] as const;

/**
 * Describe's hero is ONE golem, not the row (BB-160).
 *
 * Two things pin it. The V2 frame gives the graphic a 68px slot, and one `lg`
 * avatar is 44px wide against 188px for four with their gaps. And the frame's
 * PNG carries the Lapis palette byte for byte (#1d2740 / #334570 / #54679b /
 * #9ec1f0), which is `MINERALS[3]` and which the row above does not use at all
 * — so rendering any one of those four would still be the wrong colour.
 *
 * The frame's character has an arm up, so this one waves — see
 * {@link PersonaPixelPose}. Two things about it are approximations and want the
 * real asset: a 68px raster is not enough to identify a family, so the shape is
 * the row's own first silhouette, and the frame tilts the whole body, which
 * nothing here does.
 */
export const SOLO_HERO_CHARACTERS: readonly HeroCharacter[] = [
  { seed: "swarm-hero-lapis", shapeIndex: 0, paletteIndex: 3, pose: "wave" },
];

type HeroCharacter = {
  seed: string;
  shapeIndex: number;
  paletteIndex: number;
  pose?: PersonaPixelPose;
};

/**
 * A quarter-cycle apart against the 1.1s loop. Negative so every character is
 * already mid-wave on first paint — a positive delay would show four idle
 * golems for up to a second before anything moved.
 */
const JUMP_PERIOD_S = 1.1;

export function SwarmHeroCharacters({
  className,
  /** Defaults to the four-golem row; Describe passes the solo character. */
  characters = HERO_CHARACTERS,
}: {
  className?: string;
  characters?: readonly HeroCharacter[];
}) {
  return (
    <div
      className={cn("flex items-end justify-center gap-1", className)}
      data-testid="swarm-hero-characters"
      aria-hidden
    >
      {characters.map((character, index) => (
        <span
          key={character.seed}
          className="animate-swarm-hero-jump inline-flex"
          style={{
            animationDelay: `-${(
              (index * JUMP_PERIOD_S) /
              characters.length
            ).toFixed(3)}s`,
          }}
        >
          <PersonaPixelAvatar
            seed={character.seed}
            shapeIndex={character.shapeIndex}
            paletteIndex={character.paletteIndex}
            pose={character.pose}
            size="lg"
          />
        </span>
      ))}
    </div>
  );
}
