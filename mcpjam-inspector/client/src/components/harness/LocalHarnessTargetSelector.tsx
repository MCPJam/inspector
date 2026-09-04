import { Laptop, Cloud } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { track } from "@/lib/analytics";
import type {
  HarnessExecutionTarget,
  LocalHarnessTargetState,
} from "@/hooks/useLocalHarnessTarget";

/**
 * Hosted ⇄ Native on this machine, for a Claude Code harness turn.
 *
 * Rendered only when the previewed host IS the Claude Code harness host and the
 * `local-harness-enabled` flag is on. Everywhere else it does not exist — a
 * selector offering a target the turn path cannot honour would be a lie the
 * user only discovers by trying it.
 *
 * Selecting Native is consent-BLIND: it records the preference and lets the
 * consent sheet render. That split lives in `useLocalHarnessTarget` and is the
 * reason picking Native does not silently bounce back to Hosted — see the
 * comment there.
 */
export function LocalHarnessTargetSelector({
  state,
  location,
}: {
  state: LocalHarnessTargetState;
  /** Where in the product this rendered, for the funnel. An enum, not a path. */
  location: string;
}) {
  const { selectedTarget, localAvailable, availability, loading, select } =
    state;

  const choose = (target: HarnessExecutionTarget) => {
    if (target === selectedTarget) return;
    track("local_harness_target_selected", { location, target });
    select(target);
  };

  return (
    <div
      data-testid="local-harness-target-selector"
      className="flex flex-col gap-2"
    >
      <div className="flex items-center gap-1 rounded-md border border-border/60 bg-muted/20 p-1">
        <Button
          size="sm"
          variant={selectedTarget === "hosted" ? "secondary" : "ghost"}
          className="flex-1 justify-start gap-2"
          onClick={() => choose("hosted")}
        >
          <Cloud className="size-3.5" aria-hidden />
          Hosted
        </Button>
        <Button
          size="sm"
          variant={selectedTarget === "local-native" ? "secondary" : "ghost"}
          className="flex-1 justify-start gap-2"
          onClick={() => choose("local-native")}
          // Disabled rather than hidden when unavailable: the reason below is
          // more useful than the option silently not existing, and a user who
          // installed the runtime should see the option become live.
          disabled={!localAvailable || loading}
        >
          <Laptop className="size-3.5" aria-hidden />
          Native on this machine
        </Button>
      </div>
      {!loading && !localAvailable ? (
        <p
          className="text-xs leading-relaxed text-muted-foreground"
          data-testid="local-harness-unavailable-reason"
        >
          {reasonFor(availability)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Why the native target is not on offer.
 *
 * Reads the server's own status enum rather than inventing product copy per
 * failure: the availability gate is the single place that decides, and every
 * status it can return has a message written next to the check that produces
 * it. This maps the handful a user can act on and falls back to the server's
 * message for the rest.
 */
function reasonFor(
  availability: LocalHarnessTargetState["availability"],
): string {
  if (availability === null) {
    return "Running here isn't available in this Inspector.";
  }
  switch (availability.status) {
    case "ok":
      return "";
    case "platform-not-supported":
    case "ownership-unprovable":
      return (
        `Running Claude Code here isn't supported on ${availability.platform} ` +
        `yet: MCPJam can't guarantee that stopping a session stops everything ` +
        `it started.`
      );
    case "runtime-unavailable":
      return availability.runtimeStatus.state === "absent"
        ? "Install the local runtime to run Claude Code on this machine."
        : "The local runtime needs to be reinstalled before it can run.";
    default:
      return (
        availability.message ??
        "Running Claude Code on this machine isn't available right now."
      );
  }
}
