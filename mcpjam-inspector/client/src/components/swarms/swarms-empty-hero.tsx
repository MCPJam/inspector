import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { SwarmHeroCharacters } from "@/components/swarms/swarm-hero-characters";

const FIRST_SWARM_EMPTY_DESCRIPTION =
  "We invent realistic users, drop them into the clients your users actually use, and report what breaks.";

interface SwarmsEmptyHeroProps {
  onNewSwarm: () => void;
  /**
   * Replaces the create button, and nothing else (REEV-6).
   *
   * The signed-out preview shows this exact hero — same graphic, same
   * heading, same sentence — because a visitor and a member are looking at
   * the same empty tab and should read the same description of it. Only the
   * control differs: a member can create a swarm, a visitor has to sign in
   * first.
   *
   * A slot rather than a copy of the strings. The previous version restated
   * the heading and body inside the preview's own copy module, where they
   * drifted immediately: the User Testing line came out as a paraphrase that
   * changed three words nobody had approved. Rendering the component makes
   * drift impossible rather than merely discouraged.
   */
  action?: ReactNode;
}

/**
 * Swarm empty state (BB-120): the jumping character graphic, the headline, one
 * line of body copy, and the primary CTA — centered, nothing else.
 *
 * The three "What swarms looks like" preview cards that used to sit below this
 * (a faked goal trend, client matrix, and session trace) are gone. They are
 * not in the redesigned frame, and mock charts on an empty page invite the
 * reader to interpret numbers that were never real.
 */
export function SwarmsEmptyHero({ onNewSwarm, action }: SwarmsEmptyHeroProps) {
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-6 py-10"
      data-testid="swarms-empty-hero"
    >
      <div className="my-auto flex flex-col items-center text-center">
        <SwarmHeroCharacters />
        <h3 className="mt-4 text-lg font-semibold text-foreground">
          Create your first swarm
        </h3>
        <p className="mt-2 max-w-md text-pretty text-sm text-foreground">
          {FIRST_SWARM_EMPTY_DESCRIPTION}
        </p>
        <div className="mt-4">
          {action ?? (
            <Button type="button" size="sm" onClick={onNewSwarm}>
              <Plus className="mr-1.5 size-4" />
              Create new swarm
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
