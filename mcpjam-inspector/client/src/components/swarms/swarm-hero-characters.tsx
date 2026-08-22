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

import { PersonaPixelAvatar } from "@/components/swarms/persona-pixel-avatar";

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
 * A quarter-cycle apart against the 1.1s loop. Negative so every character is
 * already mid-wave on first paint — a positive delay would show four idle
 * golems for up to a second before anything moved.
 */
const JUMP_PERIOD_S = 1.1;

export function SwarmHeroCharacters() {
  return (
    <div
      className="flex items-end justify-center gap-1"
      data-testid="swarm-hero-characters"
      aria-hidden
    >
      {HERO_CHARACTERS.map((character, index) => (
        <span
          key={character.seed}
          className="animate-swarm-hero-jump inline-flex"
          style={{
            animationDelay: `-${(
              (index * JUMP_PERIOD_S) /
              HERO_CHARACTERS.length
            ).toFixed(3)}s`,
          }}
        >
          <PersonaPixelAvatar
            seed={character.seed}
            shapeIndex={character.shapeIndex}
            paletteIndex={character.paletteIndex}
            size="lg"
          />
        </span>
      ))}
    </div>
  );
}
