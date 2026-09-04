import { track } from "@/lib/analytics";
import { HOSTED_MODE } from "@/lib/config";
import { ViewModeSelector } from "@/components/shared/view-mode-selector";
import { useComputerEngine } from "@/hooks/useComputerEngine";
import { ComputerView } from "./ComputerView";
import { LocalComputerView } from "./LocalComputerView";

/**
 * The Computer tab's outer shell. Chooses the FACE:
 *
 *  - Hosted, a guest/non-member, or no synced project ⇒ the existing cloud
 *    `ComputerView`, byte-identical to before (it also owns the sign-in /
 *    no-project empty states, and the "not resolved yet" one).
 *  - A signed-in member on a non-hosted inspector ⇒ a Local⇄Cloud face chosen
 *    by the user's SELECTED engine, with a toggle when both engines exist.
 *
 * The face follows `selectedEngine` (consent-blind) rather than the resolved
 * `engine`, so picking "This machine" before consenting shows the local
 * face's consent gate instead of bouncing back to cloud.
 */
export function ComputerTabView({
  projectId,
  isSignedInMember,
}: {
  projectId: string | null;
  /**
   * Tri-state — `undefined` is "Convex has not said yet"; see `ComputerView`.
   * The local face is member-only too, so the unresolved window takes the
   * cloud branch below and the engine toggle appears once the actor lands.
   */
  isSignedInMember: boolean | undefined;
}) {
  // Called unconditionally (hooks rule); returns cloud defaults when there's
  // no project or in hosted mode.
  const engine = useComputerEngine(projectId);

  if (HOSTED_MODE || isSignedInMember !== true || !projectId) {
    return (
      <ComputerView projectId={projectId} isSignedInMember={isSignedInMember} />
    );
  }

  const showLocalFace = engine.selectedEngine === "local";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {engine.toggleVisible ? (
        <div className="flex justify-end px-6 pt-4">
          <ViewModeSelector
            value={engine.selectedEngine}
            ariaLabel="Computer engine"
            indicatorId="computer-engine"
            options={[
              { value: "local", label: "This machine" },
              { value: "cloud", label: "Cloud" },
            ]}
            onChange={(next) => {
              // The engine NAME only — no project id, no workspace path.
              track("computer_engine_selected", {
                location: "computer_tab",
                engine: next,
              });
              engine.setEngine(next);
            }}
          />
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {showLocalFace ? (
          <LocalComputerView projectId={projectId} engine={engine} />
        ) : (
          <ComputerView
            projectId={projectId}
            isSignedInMember={isSignedInMember}
          />
        )}
      </div>
    </div>
  );
}
