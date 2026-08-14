import { useEffect, useRef, useState } from "react";
import { Switch } from "@mcpjam/design-system/switch";

import {
  type ChatboxSettings,
  useChatboxMutations,
} from "@/hooks/useChatboxes";
import { toast } from "@/lib/toast";
import { convexErrMessage } from "@/lib/convex-error";

/**
 * The per-scenario rollout control for per-turn ratings.
 *
 * MOUNT ONE PER SCENARIO — the call site passes `key={chatbox.chatboxId}`.
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
export function ChatboxPerTurnFeedbackToggle({
  chatbox,
}: {
  chatbox: ChatboxSettings;
}) {
  const { updateChatbox } = useChatboxMutations();
  const stored = chatbox.chatUi?.surfaces?.perTurnFeedback?.enabled === true;

  // Optimistic display value. Held until the SERVER's value catches up, not
  // cleared when the mutation resolves: `chatbox` arrives through a reactive
  // query, so dropping the override on resolve makes the switch snap back to
  // the old setting for the frame or two before the update lands.
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const enabled = optimistic ?? stored;

  useEffect(() => {
    if (optimistic !== null && stored === optimistic) setOptimistic(null);
  }, [optimistic, stored]);

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
    setOptimistic(next);
    try {
      await updateChatbox({
        chatboxId: chatbox.chatboxId,
        chatUi: { surfaces: { perTurnFeedback: { enabled: next } } },
      } as any);
    } catch (err) {
      setOptimistic(null);
      toast.error(
        convexErrMessage(err, "Failed to update the per-turn ratings setting")
      );
    } finally {
      inFlightRef.current = false;
      setSaving(false);
    }
  };

  return (
    <div className="mt-8 border-t border-border/40 pt-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            Per-turn ratings
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Let testers rate each response 1–5 stars and leave a comment.
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
    </div>
  );
}
