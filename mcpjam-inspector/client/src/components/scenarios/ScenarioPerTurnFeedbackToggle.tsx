import { useEffect, useRef, useState } from "react";
import { Switch } from "@mcpjam/design-system/switch";

import {
  type ScenarioSettings,
  useScenarioMutations,
} from "@/hooks/useScenarios";
import type { ScenarioPerTurnFeedbackStyle as PerTurnFeedbackStyle } from "@/types/chatUi";
import { toast } from "@/lib/toast";
import { convexErrMessage } from "@/lib/convex-error";

const STYLE_OPTIONS: Array<{
  value: PerTurnFeedbackStyle;
  label: string;
  hint: string;
}> = [
  { value: "stars", label: "Stars", hint: "Rate each response 1–5 stars" },
  { value: "thumbs", label: "Thumbs", hint: "Rate each response 👍 or 👎" },
];

/**
 * The per-scenario rollout control for per-turn ratings.
 *
 * MOUNT ONE PER SCENARIO — the call site passes `key={scenario.scenarioId}`.
 * This component holds optimistic state across an await, and reusing one
 * instance across scenarios would let a write started on one resolve into
 * another's state. A remount is a cheaper and more complete answer than
 * scoping every piece of that state to a scenario id.
 *
 * This exists because the backend default is `enabled: false` and normalization
 * returns a fully-defaulted `chatUi` envelope through redeem — so a `true`
 * default would have switched the widget on for every existing scenario the
 * moment the UI shipped. Rollout is a decision per scenario, and this is where
 * it is made.
 */
export function ScenarioPerTurnFeedbackToggle({
  scenario,
}: {
  scenario: ScenarioSettings;
}) {
  const { updateScenario } = useScenarioMutations();
  const storedSurface = scenario.chatUi?.surfaces?.perTurnFeedback;
  const stored = storedSurface?.enabled === true;
  // Absent ⇒ stars, matching the backend normalizer. Every scenario that
  // predates the style field reads as the widget it already had.
  const storedStyle: PerTurnFeedbackStyle =
    storedSurface?.style === "thumbs" ? "thumbs" : "stars";

  // Optimistic display value. Held until the SERVER's value catches up, not
  // cleared when the mutation resolves: `scenario` arrives through a reactive
  // query, so dropping the override on resolve makes the switch snap back to
  // the old setting for the frame or two before the update lands.
  //
  // ONE OBJECT, not two slots: a `boolean | null` cannot carry both fields,
  // and a second independent slot would let a style write clear the toggle's
  // override (or the reverse) while the other was still in flight. Each field
  // is `null` when it has no pending override of its own.
  const [optimistic, setOptimistic] = useState<{
    enabled: boolean | null;
    style: PerTurnFeedbackStyle | null;
  }>({ enabled: null, style: null });
  const [saving, setSaving] = useState(false);
  const enabled = optimistic.enabled ?? stored;
  const style = optimistic.style ?? storedStyle;

  useEffect(() => {
    // Each override stands down on its OWN field catching up. Clearing both
    // together would drop a style override the instant an `enabled` write
    // landed, snapping the segmented control back for a frame.
    setOptimistic((prev) => {
      const next = {
        enabled:
          prev.enabled !== null && prev.enabled === stored
            ? null
            : prev.enabled,
        style:
          prev.style !== null && prev.style === storedStyle ? null : prev.style,
      };
      return next.enabled === prev.enabled && next.style === prev.style
        ? prev
        : next;
    });
  }, [stored, storedStyle]);

  // Synchronous in-flight latch. A `saving` STATE check cannot serialize this:
  // two `onCheckedChange` calls in the same tick both read the pre-commit
  // value, start two mutations, and let out-of-order responses persist the
  // opposite of the last click. A ref is set before the await, so the second
  // caller sees it.
  //
  // Together with the per-scenario `key` at the call site, this is the whole
  // concurrency story: at most one write per mount, and a scenario switch is a
  // fresh mount rather than reused state. Scoping completion handlers to a
  // scenario id or a write generation would be defending against a shape this
  // component can no longer take.
  const inFlightRef = useRef(false);

  const handleChange = async (next: boolean) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setSaving(true);
    setOptimistic((prev) => ({ ...prev, enabled: next }));
    try {
      await updateScenario({
        scenarioId: scenario.scenarioId,
        chatUi: { surfaces: { perTurnFeedback: { enabled: next } } },
      } as any);
    } catch (err) {
      setOptimistic((prev) => ({ ...prev, enabled: null }));
      toast.error(
        convexErrMessage(err, "Failed to update the per-turn ratings setting")
      );
    } finally {
      inFlightRef.current = false;
      setSaving(false);
    }
  };

  const handleStyleChange = async (next: PerTurnFeedbackStyle) => {
    if (inFlightRef.current) return;
    if (next === style) return;
    inFlightRef.current = true;
    setSaving(true);
    setOptimistic((prev) => ({ ...prev, style: next }));
    try {
      // `{style}` ALONE. The backend merges the patch over the stored surface,
      // so restating `enabled` here would be this control asserting a rollout
      // decision it is not making — and would race a toggle write.
      await updateScenario({
        scenarioId: scenario.scenarioId,
        chatUi: { surfaces: { perTurnFeedback: { style: next } } },
      } as any);
    } catch (err) {
      setOptimistic((prev) => ({ ...prev, style: null }));
      toast.error(
        convexErrMessage(err, "Failed to update the rating widget style")
      );
    } finally {
      inFlightRef.current = false;
      setSaving(false);
    }
  };

  return (
    // No heading or rule of its own: this sits under the Edit page's
    // "Ratings" section, which owns both.
    <div>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            Per-turn ratings
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {style === "thumbs"
              ? "Let testers rate each response 👍 or 👎 and leave a comment."
              : "Let testers rate each response 1–5 stars and leave a comment."}{" "}
            Ratings show up on the Sessions tab, where the list can be filtered
            by them.
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={saving}
          onCheckedChange={(next) => void handleChange(next)}
          aria-label="Enable per-turn ratings"
          data-testid="user-testing-per-turn-feedback-toggle"
        />
      </div>

      {/* Only while the surface is on. A widget style is a question about a
          widget nobody is being shown otherwise. */}
      {enabled ? (
        <div
          role="radiogroup"
          aria-label="Rating widget style"
          className="mt-3 inline-flex rounded-md border border-border/60 p-0.5"
          data-testid="user-testing-per-turn-feedback-style"
        >
          {STYLE_OPTIONS.map((option) => {
            const selected = style === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={selected}
                title={option.hint}
                disabled={saving}
                className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                  selected
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                } ${saving ? "cursor-default opacity-70" : ""}`}
                onClick={() => void handleStyleChange(option.value)}
                data-testid={`user-testing-per-turn-feedback-style-${option.value}`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      ) : null}

      {/* Switching style does not rewrite history: ratings already left under
          the old widget keep counting on the Sessions tab. Said here because
          the tester-facing consequence (those turns read as unrated in the new
          widget) is invisible from this screen. */}
      {enabled ? (
        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Changing the style only affects new ratings. Ratings already left in
          the other style still count on the Sessions tab.
        </p>
      ) : null}
    </div>
  );
}
