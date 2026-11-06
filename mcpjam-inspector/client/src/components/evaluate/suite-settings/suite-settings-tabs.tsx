import { useState } from "react";
import { Pause } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SuiteSettingsTab } from "@/lib/eval-route-types";
import {
  VIEW_MODE_INDICATOR_CLASSNAME,
  VIEW_MODE_NAV_CLASSNAME,
  VIEW_MODE_TAB_CLASSNAME,
} from "@/components/shared/view-mode-selector";
import { TAB_CLASSNAME } from "@/components/shared/landing-page-header";

export const SUITE_SETTINGS_TABS: readonly {
  value: SuiteSettingsTab;
  label: string;
}[] = [
  { value: "settings", label: "Settings" },
  { value: "cases", label: "Test cases" },
  { value: "evaluators", label: "Default evaluators" },
];

const NAME_CLASS = "text-xl font-semibold tracking-tight text-foreground";

/** Eyebrow, the suite's name (click to rename), and what the page is for. */
export function SuiteSettingsHeading({
  name,
  nameEditor,
}: {
  name: string;
  /** Absent when the suite is locked: the name renders as plain text. */
  nameEditor?: {
    value: string;
    onChange(value: string): void;
    error?: string;
  };
}) {
  const [editing, setEditing] = useState(false);
  // An empty name has nothing to click, so its editor stays open.
  const showInput = nameEditor && (editing || Boolean(nameEditor.error));
  const value = nameEditor?.value ?? name;

  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-testid="suite-settings-heading"
    >
      <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
        <Pause className="size-3" aria-hidden /> Suite settings
      </span>
      <div className="min-w-0" data-setting-key="name">
        {showInput ? (
          <input
            type="text"
            value={value}
            onChange={(event) => nameEditor.onChange(event.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === "Escape") {
                setEditing(false);
                event.currentTarget.blur();
              }
            }}
            autoFocus={editing}
            aria-label="Suite name"
            aria-invalid={nameEditor.error ? true : undefined}
            className="h-8 w-full max-w-xl rounded-md border border-input bg-background px-2 text-xl font-semibold tracking-tight focus:outline-none focus:ring-2 focus:ring-ring"
          />
        ) : nameEditor ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            title={value}
            className={cn(
              "block max-w-full truncate text-left hover:text-foreground/80",
              NAME_CLASS,
            )}
          >
            {value}
          </button>
        ) : (
          <h2 className={cn("truncate", NAME_CLASS)} title={name}>
            {name}
          </h2>
        )}
        {nameEditor?.error ? (
          <p className="mt-1 text-xs text-destructive">{nameEditor.error}</p>
        ) : null}
      </div>
      <p className="text-sm text-muted-foreground">
        What this suite tests and how it grades. Changes apply to the next run.
      </p>
    </div>
  );
}

/** Settings · Test cases <n> · Default evaluators, each its own address. */
export function SuiteSettingsTabNav({
  tab,
  caseCount,
  onTabChange,
}: {
  tab: SuiteSettingsTab;
  caseCount: number;
  onTabChange(tab: SuiteSettingsTab): void;
}) {
  return (
    <div className="border-b border-border/60">
      <nav
        aria-label="Suite settings"
        className={cn(VIEW_MODE_NAV_CLASSNAME, TAB_CLASSNAME)}
      >
        {SUITE_SETTINGS_TABS.map((option) => {
          const active = tab === option.value;
          return (
            <button
              key={option.value}
              type="button"
              data-testid={`suite-settings-tab-${option.value}`}
              aria-current={active ? "page" : undefined}
              onClick={() => onTabChange(option.value)}
              className={cn(
                VIEW_MODE_TAB_CLASSNAME,
                active
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="relative z-10">
                {option.label}
                {option.value === "cases" ? (
                  <span className="ml-1.5 text-muted-foreground tabular-nums">
                    {caseCount}
                  </span>
                ) : null}
              </span>
              {active ? (
                <span
                  aria-hidden="true"
                  className={VIEW_MODE_INDICATOR_CLASSNAME}
                />
              ) : null}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
