/**
 * Shared "Clients vs Environments" target-mode selection for surfaces that can
 * aim work at either legacy clients (host + server group) or Project
 * Environments.
 *
 * Two pieces, extracted from the previously hand-rolled copies in the Swarm
 * new-journey form and the AI-generate dialog:
 *
 *  - {@link useTargetMode} — mode state with a DERIVED default: environments
 *    whenever the flag is on and the project has at least one environment
 *    (environments are how these surfaces are meant to think about targets),
 *    else clients. The default stays live until the user explicitly picks a
 *    mode, so environments arriving after mount (the Convex list is reactive)
 *    still flip a fresh form into env mode instead of stranding it on the
 *    legacy default.
 *  - {@link TargetModeToggle} — the pill radiogroup. Environments first.
 */
import { useCallback, useState } from "react";
import { cn } from "@/lib/utils";

export type TargetMode = "clients" | "environments";

export function useTargetMode({
  environmentsEnabled,
  environmentCount,
}: {
  /** `project-environments-enabled` — off forces clients mode. */
  environmentsEnabled: boolean;
  /** Live environment count; 0 defaults a fresh form to clients. */
  environmentCount: number;
}): {
  targetMode: TargetMode;
  setTargetMode: (mode: TargetMode) => void;
  /** Back to the derived default (form close/reset). */
  resetTargetMode: () => void;
} {
  // `null` = untouched → derived default.
  const [override, setOverride] = useState<TargetMode | null>(null);
  const targetMode: TargetMode = environmentsEnabled
    ? override ?? (environmentCount > 0 ? "environments" : "clients")
    : "clients";
  return {
    targetMode,
    setTargetMode: setOverride,
    resetTargetMode: useCallback(() => setOverride(null), []),
  };
}

export function TargetModeToggle({
  value,
  onChange,
  testIdPrefix,
  ariaLabel,
  className,
}: {
  value: TargetMode;
  onChange: (mode: TargetMode) => void;
  /** Existing surfaces key tests on `<prefix>-target-mode-<mode>`. */
  testIdPrefix: string;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      className={cn("flex items-center gap-1 text-[11px]", className)}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {[
        { value: "environments" as const, label: "Environments" },
        { value: "clients" as const, label: "Clients" },
      ].map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          data-testid={`${testIdPrefix}-target-mode-${opt.value}`}
          onClick={() => onChange(opt.value)}
          className={cn(
            "rounded-full border px-2 py-0.5 font-medium transition-colors",
            value === opt.value
              ? "border-primary/50 bg-primary/10 text-foreground"
              : "border-border/60 text-muted-foreground hover:bg-muted/50"
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
