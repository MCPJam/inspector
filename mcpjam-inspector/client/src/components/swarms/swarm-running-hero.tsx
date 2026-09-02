/**
 * Running-step header graphic: the Paper runner, three-across.
 *
 * Replaces the pixel-golem row on this screen only. The empty-state and
 * Describe heroes still preview the personas a real swarm will populate;
 * here the illustration is the "swarm is moving" mark from the running
 * frame, not a stand-in for those personas.
 *
 * Motion is CSS-only (`animate-swarm-hero-jump`, which honors
 * `prefers-reduced-motion`). Each runner carries a negative delay so the
 * row lands as a wave instead of three copies moving in lockstep.
 */

import runningSwarmSrc from "../../assets/swarms/running-swarm.png";
import { cn } from "@/lib/utils";

const RUNNER_COUNT = 3;

/**
 * A third-cycle apart against the 1.1s loop. Negative so every runner is
 * already mid-wave on first paint — a positive delay would show three
 * still figures for up to a second before anything moved.
 */
const JUMP_PERIOD_S = 1.1;

export function SwarmRunningHero({ className }: { className?: string }) {
  return (
    <div
      className={cn("flex items-end", className)}
      data-testid="swarm-running-hero"
      aria-hidden
    >
      {Array.from({ length: RUNNER_COUNT }, (_, index) => (
        <span
          key={index}
          className="animate-swarm-hero-jump inline-flex"
          style={{
            animationDelay: `-${((index * JUMP_PERIOD_S) / RUNNER_COUNT).toFixed(3)}s`,
          }}
        >
          <img
            src={runningSwarmSrc}
            alt=""
            width={41}
            height={48}
            draggable={false}
            className="h-12 w-[2.5625rem] shrink-0 select-none object-cover object-center [image-rendering:pixelated]"
          />
        </span>
      ))}
    </div>
  );
}
