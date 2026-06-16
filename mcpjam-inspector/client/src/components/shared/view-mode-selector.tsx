import { motion, useReducedMotion } from "framer-motion";
import { cn } from "@/lib/utils";

export type ViewModeSelectorOption<T extends string> = {
  value: T;
  label: string;
  disabled?: boolean;
};

export function ViewModeSelector<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
  /**
   * Shared-layout id for the sliding active indicator. Each distinct
   * selector instance on screen needs its own id so framer-motion doesn't
   * try to animate one underline between two different navs. Defaults to the
   * aria label.
   */
  indicatorId,
}: {
  value: T;
  options: readonly ViewModeSelectorOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
  indicatorId?: string;
}) {
  const reduceMotion = useReducedMotion();
  const layoutId = `view-mode-indicator-${indicatorId ?? ariaLabel}`;
  return (
    <nav
      className={cn(
        "order-3 flex w-full justify-center gap-1 overflow-x-auto [-webkit-overflow-scrolling:touch] md:order-2 md:w-auto md:max-w-full md:py-0",
        className,
      )}
      aria-label={ariaLabel}
    >
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={option.disabled}
            aria-current={active ? "page" : undefined}
            onClick={() => onChange(option.value)}
            className={cn(
              "relative min-h-10 shrink-0 px-4 py-2 text-sm font-medium transition-colors duration-200 sm:min-h-11 sm:px-5 sm:text-base md:min-h-10 md:px-4 lg:px-6",
              active
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
              option.disabled ? "cursor-not-allowed opacity-40" : "",
            )}
          >
            <span className="relative z-10">{option.label}</span>
            {active ? (
              <motion.span
                layoutId={layoutId}
                aria-hidden="true"
                className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary sm:inset-x-4 md:inset-x-3 lg:inset-x-6"
                transition={
                  reduceMotion
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 520, damping: 38, mass: 0.7 }
                }
              />
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}
