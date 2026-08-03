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
 *    else clients. The default LATCHES the first time the environments list
 *    settles (`environmentCount` becomes a number) after mount or reset: the
 *    reactive Convex list arriving a beat after the form opens still flips a
 *    fresh form into env mode, but a teammate creating the project's FIRST
 *    environment can no longer yank a user out of clients mode mid-form.
 *  - {@link TargetModeToggle} — the pill radiogroup. Environments first.
 *    Keyboard-operable per the WAI-ARIA radio-group pattern: roving tabIndex
 *    (only the checked pill is tabbable) + arrow keys move AND select.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type TargetMode = "clients" | "environments";

export function useTargetMode({
  environmentsEnabled,
  environmentCount,
}: {
  /** `project-environments-enabled` — off forces clients mode. */
  environmentsEnabled: boolean;
  /**
   * Live environment count; `undefined` while the list is still loading.
   * The derived default latches on the first settled value (see above), so
   * pass `undefined` during load rather than coercing to 0 — a coerced 0
   * would latch "clients" before the data arrives.
   */
  environmentCount: number | undefined;
}): {
  targetMode: TargetMode;
  setTargetMode: (mode: TargetMode) => void;
  /** Back to the (re-derived) default (form close/reset). */
  resetTargetMode: () => void;
} {
  // `null` = untouched → default. The default itself is latched state, not a
  // live derivation — `null` until the count first settles.
  const [override, setOverride] = useState<TargetMode | null>(null);
  const [latchedDefault, setLatchedDefault] = useState<TargetMode | null>(null);
  useEffect(() => {
    if (latchedDefault !== null || environmentCount === undefined) return;
    setLatchedDefault(environmentCount > 0 ? "environments" : "clients");
  }, [latchedDefault, environmentCount]);

  // Synchronous fallback while the latch effect hasn't committed yet: derive
  // from the CURRENT count so a fresh form with environments already loaded
  // renders env mode on its very first frame instead of flashing clients.
  // Once latched, the latch wins — later count changes can't flip the mode.
  const derivedNow: TargetMode =
    environmentCount !== undefined && environmentCount > 0
      ? "environments"
      : "clients";
  const targetMode: TargetMode = environmentsEnabled
    ? override ?? latchedDefault ?? derivedNow
    : "clients";
  return {
    targetMode,
    setTargetMode: setOverride,
    resetTargetMode: useCallback(() => {
      setOverride(null);
      // Drop the latch too: the next settle (immediate if the list is already
      // loaded — the effect re-runs on `latchedDefault` turning null) re-derives
      // the default from the CURRENT environment count.
      setLatchedDefault(null);
    }, []),
  };
}

const OPTIONS = [
  { value: "environments", label: "Environments" },
  { value: "clients", label: "Clients" },
] as const;

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
  const buttonRefs = useRef(new Map<TargetMode, HTMLButtonElement>());

  // WAI-ARIA radio pattern: any arrow key moves to (and selects) the other
  // option — with two options every direction means "the other one". The
  // current option comes from the FOCUSED pill (event target), not `value`:
  // selection can move without focus (the async default latch), and arrowing
  // from a no-longer-selected pill must still land on its neighbor.
  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      return;
    }
    event.preventDefault();
    const focused = event.currentTarget.dataset.targetMode as
      | TargetMode
      | undefined;
    const next: TargetMode =
      (focused ?? value) === "environments" ? "clients" : "environments";
    onChange(next);
    buttonRefs.current.get(next)?.focus();
  };

  return (
    <div
      className={cn("flex items-center gap-1 text-[11px]", className)}
      role="radiogroup"
      aria-label={ariaLabel}
    >
      {OPTIONS.map((opt) => (
        <button
          key={opt.value}
          ref={(el) => {
            if (el) buttonRefs.current.set(opt.value, el);
            else buttonRefs.current.delete(opt.value);
          }}
          type="button"
          role="radio"
          aria-checked={value === opt.value}
          // Roving tabIndex: only the checked pill is a tab stop; arrows move
          // within the group.
          tabIndex={value === opt.value ? 0 : -1}
          data-target-mode={opt.value}
          data-testid={`${testIdPrefix}-target-mode-${opt.value}`}
          onClick={() => onChange(opt.value)}
          onKeyDown={onKeyDown}
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
