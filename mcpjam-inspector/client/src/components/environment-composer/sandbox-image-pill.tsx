/**
 * Sandbox-image slot — which Computer image a run's sandbox boots from.
 *
 * A native `<select>` rather than the popover the other slots use: the option
 * list needs its own disabled/annotated rows ("(draft)", "(not built)") and the
 * build badge beside it is the live status, so the plainest control that can
 * carry all three wins. Callers render this only when `computers-enabled` is on;
 * the query lives here so the hook is never fired on a surface without it.
 */
import { EnvironmentBuildBadge } from "@/components/computer/EnvironmentBuildBadge";
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

  return (
    <>
      <select
        data-testid={testId}
        aria-label="Sandbox image"
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        className="h-8 max-w-[200px] rounded-full border border-border/60 bg-muted/40 px-2 text-xs outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
      >
        <option value="">Computer · default</option>
        {(sandboxImages ?? []).map((img) => {
          const ready = img.currentBuild?.status === "ready";
          // A per-user draft can't be resolved by anyone else at launch, so it
          // is listed (so its absence isn't a mystery) but never selectable.
          const isDraft = img.sharing !== "project";
          return (
            <option
              key={img.environmentId}
              value={img.environmentId}
              disabled={isDraft}
            >
              {img.name}
              {isDraft ? " (draft)" : ready ? "" : " (not built)"}
            </option>
          );
        })}
      </select>
      {value ? (
        <EnvironmentBuildBadge build={selected?.currentBuild ?? null} />
      ) : null}
    </>
  );
}
