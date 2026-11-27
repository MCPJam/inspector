/**
 * What a refusal says when a harness can't run on this machine: the reason
 * the local venue wasn't chosen, and the one thing the member can do about it.
 *
 * Every string lives here so the wording is reviewed in one place (the ui-copy
 * rubric; DESIGN.md "Errors"). "Machine" matches the Playground's own local
 * copy ("Run Claude Code on this machine?", the "This machine" chip).
 */
import { harnessDisplayName } from "../../../../shared/harness-model-support.js";
import { LOCAL_HARNESS_MANIFEST } from "./compatibility.js";
import { localHarnessManifestsForDevelopment } from "./availability.js";
import { localHarnessMemberRefusal, type LocalHarnessMemberRefusal } from "./readiness.js";
import type { LocalVenueDecision, LocalVenueMachineRefusal } from "./run-resources.js";
import type { LocalPackTarget, SupportedLocalHarnessId } from "./targets.js";

/** The machines a target means, as a refusal names them. */
export const LOCAL_TARGET_LABELS: Readonly<Record<LocalPackTarget, string>> = {
  "darwin-arm64": "Macs with Apple silicon",
  "darwin-x64": "Intel Macs",
  "linux-x64": "Linux x64 machines",
  "linux-arm64": "Linux Arm machines",
  "win32-x64": "Windows x64 machines",
};

/** The refusals that have their own text. */
export type ExplainedLocalVenueRefusal =
  | Exclude<LocalVenueMachineRefusal, "unsupported-harness" | "hosted-server">
  | Exclude<LocalHarnessMemberRefusal, "actor-refused">;

function joinWithOr(labels: readonly string[]): string {
  return labels.length <= 1
    ? (labels[0] ?? "")
    : `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

/** Where unattended runs of `harnessId` are verified, from its manifest. */
function unattendedMachines(harnessId: SupportedLocalHarnessId): string {
  const manifest = localHarnessManifestsForDevelopment(LOCAL_HARNESS_MANIFEST)[harnessId];
  return joinWithOr((manifest?.unattendedSandboxTargets ?? []).map((target) => LOCAL_TARGET_LABELS[target]));
}

export function localVenueRefusalText(
  refusal: ExplainedLocalVenueRefusal,
  harnessId: SupportedLocalHarnessId,
): string {
  const name = harnessDisplayName(harnessId);
  switch (refusal) {
    case "not-set-up":
      return `Couldn't run ${name} on this machine because it isn't set up for this project. Set it up in the Playground, then run the eval again.`;
    case "not-rolled-out":
      return `Couldn't run ${name} on this machine because it isn't available for your account yet. Choose another client.`;
    case "rollout-unknown":
      return `Couldn't check whether ${name} can run on this machine. Check your connection, then run the eval again.`;
    case "flags-off":
      return `Couldn't run ${name} on this machine because DO_NOT_TRACK is set, so this Inspector can't check access to local clients. Choose another client.`;
    case "unattended-unverified": {
      const machines = unattendedMachines(harnessId);
      return machines
        ? `Couldn't run this eval on this machine because evals with ${name} run locally only on ${machines}. Choose another client.`
        : `Couldn't run this eval on this machine because evals with ${name} can't run locally yet. Choose another client.`;
    }
    case "unsupported-platform":
      return `Couldn't run ${name} on this machine because it doesn't support this operating system or processor. Choose another client.`;
    case "not-released":
      return `Couldn't run ${name} on this machine because it isn't available to run locally yet. Choose another client.`;
    case "turned-off":
      return `Couldn't run ${name} on this machine because running clients locally is turned off in this Inspector. Choose another client.`;
  }
}

/**
 * The text for a decision that kept a harness off this machine, or null when
 * there is nothing more specific to say: the harness has no local runtime, the
 * server is hosted, or no member identity could be established (signing in
 * again would not change that). A member refusal is narrowed here, after the
 * refusal, so a launch that runs locally never pays for the extra reads.
 */
export async function describeLocalVenueRefusal(
  decision: LocalVenueDecision,
  args: { bearer?: string; projectId?: string },
): Promise<string | null> {
  if (decision.venue === "local" || decision.harnessId === null) return null;
  const { refusal, harnessId } = decision;
  if (refusal === "unsupported-harness" || refusal === "hosted-server") return null;
  if (refusal !== "member") return localVenueRefusalText(refusal, harnessId);
  const member = await localHarnessMemberRefusal(args.bearer, args.projectId, harnessId);
  return member === null || member === "actor-refused"
    ? null
    : localVenueRefusalText(member, harnessId);
}
