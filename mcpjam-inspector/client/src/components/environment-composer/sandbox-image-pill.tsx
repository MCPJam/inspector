/**
 * Sandbox-image slot — which Computer image a run's sandbox boots from.
 *
 * A single-select rather than the checkbox popover the other slots use: the
 * option list needs its own disabled/annotated rows ("(draft)", "(not built)")
 * and the build badge beside it is the live status. `SandboxImagePicker` carries
 * all three on the app's own Select primitive, so the slot reads as a pill like
 * its neighbours instead of a native dropdown. Callers render this only when
 * `computers-enabled` is on; the query lives here so the hook is never fired on
 * a surface without it.
 */
import { EnvironmentBuildBadge } from "@/components/computer/EnvironmentBuildBadge";
import { SandboxImagePicker } from "@/components/computer/SandboxImagePicker";
import { useEphemeralCloudAvailable } from "@/hooks/useProjectComputer";
import { useSandboxImages } from "@/hooks/useSandboxImages";

export function SandboxImagePill({
  projectId,
  value,
  onChange,
  disabled,
  testId,
}: {
  projectId: string;
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const sandboxImages = useSandboxImages(projectId);
  const selected = value
    ? (sandboxImages ?? []).find((img) => img.environmentId === value)
    : undefined;
  // `false` only from a real server answer — loading or a fetch failure never
  // blocks the control. Gated here rather than per surface so every consumer
  // inherits it; a surface that wants to EXPLAIN the block renders its own
  // notice (see `CloudUnreachableNotice`) alongside.
  const ephemeralCloudAvailable = useEphemeralCloudAvailable();
  const cloudUnreachable = ephemeralCloudAvailable === false;

  return (
    <>
      <SandboxImagePicker
        variant="pill"
        images={sandboxImages}
        value={value}
        onChange={onChange}
        disabled={disabled}
        testId={testId}
        noPinLabel="Computer · default"
        draftNote=" (draft)"
        // When cloud sandboxes are unreachable, IMAGE options are disabled but
        // the control itself stays live — a pin seeded from a saved environment
        // or draft must remain clearable back to "Computer · default", which is
        // the opt-out on offer.
        lockImages={cloudUnreachable}
      />
      {value ? (
        <EnvironmentBuildBadge build={selected?.currentBuild ?? null} />
      ) : null}
    </>
  );
}
