import { Trash2 } from "lucide-react";

/** Minimal shape the list reads — the `journeys:listJourneysByPersona` row. */
export type PersonaGoalListJourney = {
  _id: string;
  goal: string;
};

/**
 * The goals belonging to one persona, in the Personas library.
 *
 * Deliberately flat: a bullet, the goal, and the one action that is not an
 * edit. Runs, targets and grading are not shown here — a goal in the library
 * is a thing you write, and what it produced is read from Overview and
 * Sessions. Same row treatment as Confirm personas in the create flow, so a
 * goal looks the same wherever it is authored.
 */
export function PersonaGoalList({
  journeys,
  onDelete,
}: {
  journeys: PersonaGoalListJourney[];
  onDelete: (journey: PersonaGoalListJourney) => void | Promise<void>;
}) {
  return (
    <ul className="space-y-1.5" data-testid="persona-goal-list">
      {journeys.map((journey) => (
        <li
          key={journey._id}
          data-testid="persona-goal-row"
          className="flex items-center gap-2.5 rounded-lg border border-input bg-background px-3 py-2"
        >
          <span
            className="size-2 shrink-0 rounded-full bg-primary"
            aria-hidden
          />
          <span
            className="min-w-0 flex-1 text-sm leading-snug text-foreground"
            title={journey.goal}
          >
            {journey.goal}
          </span>
          <button
            type="button"
            aria-label={`Delete goal ${journey.goal}`}
            className="shrink-0 rounded-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => void onDelete(journey)}
          >
            <Trash2 className="size-3.5" />
          </button>
        </li>
      ))}
    </ul>
  );
}
