import { useCallback, useEffect, useRef, useState } from "react";
import { NavigationType } from "react-router";
import { useFeatureFlagEnabled } from "posthog-js/react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import { buttonVariants } from "@mcpjam/design-system/button";
import { Settings2 } from "lucide-react";
import { PAGE_HEADER_TAB_CLASSNAME } from "@/components/shared/landing-page-header";
import { ViewModeSelector } from "@/components/shared/view-mode-selector";
import type { SamePageNavigation } from "@/hooks/use-unsaved-changes-guard";
import type { EvalRoute, SuiteSettingsTab } from "@/lib/eval-route-types";

/** PostHog flag for the tabbed Suite settings page. */
export const SUITE_SETTINGS_TABS_FLAG = "eval-suite-settings-tabs";

/**
 * Not loaded counts as off, so the page shows today's layout until the flag
 * arrives. A self-hosted Inspector never loads flags, and a placeholder there
 * would hide Suite settings for good. The sections do not remount when the
 * flag arrives: the tabs only hide them.
 */
export function useSuiteSettingsTabsFlag(): boolean {
  return useFeatureFlagEnabled(SUITE_SETTINGS_TABS_FLAG) === true;
}

export const SUITE_SETTINGS_TAB_LABEL: Record<SuiteSettingsTab, string> = {
  settings: "Settings",
  evaluators: "Default evaluators",
};

const TAB_OPTIONS = (["settings", "evaluators"] as const).map((value) => ({
  value,
  label: SUITE_SETTINGS_TAB_LABEL[value],
}));

/** The settings that live on Default evaluators; everything else is on Settings. */
const EVALUATOR_SETTING_KEYS: ReadonlySet<string> = new Set(["passOrFail"]);

export function suiteSettingsTabForKey(key: string): SuiteSettingsTab {
  return EVALUATOR_SETTING_KEYS.has(key) ? "evaluators" : "settings";
}

const SETTINGS_PATH = /\/settings(?:\/evaluators)?\/?$/;

/**
 * Switching between the two tab addresses with `replace` stays on the page,
 * so the leave prompt does not fire; the tab dialog asks instead. Back and
 * Forward are not exempt: they leave the page as far as the person can tell.
 */
export const isSuiteSettingsTabSwitch: SamePageNavigation = (
  current,
  next,
  historyAction,
) =>
  historyAction === NavigationType.Replace &&
  SETTINGS_PATH.test(current.pathname) &&
  SETTINGS_PATH.test(next.pathname) &&
  current.pathname.replace(SETTINGS_PATH, "") ===
    next.pathname.replace(SETTINGS_PATH, "");

/**
 * Tab state for the Suite settings page. The route is the only source of the
 * current tab. A tab click with unsaved changes waits for the person's answer
 * in the dialog; once the draft is clean (Discard, or ⌘S saved it) the switch
 * goes ahead.
 */
export function useSuiteSettingsTabs({
  enabled,
  route,
  suiteId,
  toSuiteEdit,
  hasUnsavedChanges,
  isCommitting,
  onDiscard,
}: {
  enabled: boolean;
  route: EvalRoute;
  suiteId: string;
  toSuiteEdit: (
    suiteId: string,
    fromCaseChecks?: string,
    tab?: SuiteSettingsTab,
    options?: { replace?: boolean },
  ) => void;
  hasUnsavedChanges: boolean;
  isCommitting: boolean;
  /** Drops every unsaved change. */
  onDiscard: () => void;
}) {
  const settingsRoute = route.type === "suite-edit" ? route : null;
  const tab = settingsRoute?.tab ?? "settings";
  const fromCaseChecks = settingsRoute?.fromCaseChecks;
  const onNavigate = useCallback(
    (next: SuiteSettingsTab) =>
      toSuiteEdit(suiteId, fromCaseChecks, next, { replace: true }),
    [fromCaseChecks, suiteId, toSuiteEdit],
  );
  const [pendingTab, setPendingTab] = useState<SuiteSettingsTab | null>(null);

  useEffect(() => {
    if (pendingTab === null || hasUnsavedChanges) return;
    setPendingTab(null);
    if (pendingTab !== tab) onNavigate(pendingTab);
  }, [hasUnsavedChanges, onNavigate, pendingTab, tab]);

  const requestTab = useCallback(
    (next: SuiteSettingsTab) => {
      // A save in flight would land after a Discard and bring the edits back.
      if (next === tab || isCommitting) return;
      if (hasUnsavedChanges) setPendingTab(next);
      else onNavigate(next);
    },
    [hasUnsavedChanges, isCommitting, onNavigate, tab],
  );

  // A scroll waiting for its tab to render: scrolling to a `hidden` section
  // does nothing, and the route commits after the click's frame.
  const afterSwitch = useRef<{ tab: SuiteSettingsTab; run: () => void } | null>(
    null,
  );
  useEffect(() => {
    const pending = afterSwitch.current;
    if (pending?.tab !== tab) return;
    afterSwitch.current = null;
    pending.run();
  }, [tab]);

  /**
   * Open the tab that holds `key`, then `scroll` to it. Only the commit bar's
   * Fix passes `fromFix`: it repairs an error, so it never asks to discard
   * first. Every other link asks like a tab click.
   */
  const goToSetting = useCallback(
    <Key extends string>(
      key: Key,
      scroll: (key: Key) => void,
      options?: { fromFix?: boolean },
    ) => {
      const target = suiteSettingsTabForKey(key);
      const run = () => scroll(key);
      if (!enabled || target === tab) return run();
      afterSwitch.current = { tab: target, run };
      if (options?.fromFix) onNavigate(target);
      else requestTab(target);
    },
    [enabled, onNavigate, requestTab, tab],
  );

  const onTabClick = (next: SuiteSettingsTab) => {
    afterSwitch.current = null;
    requestTab(next);
  };

  const dialog = (
    <SuiteSettingsDiscardDialog
      to={pendingTab}
      onKeepEditing={() => {
        afterSwitch.current = null;
        setPendingTab(null);
      }}
      onDiscard={onDiscard}
    />
  );

  return {
    enabled,
    tab,
    strip: enabled ? (
      <SuiteSettingsTabStrip tab={tab} onTabChange={onTabClick} />
    ) : undefined,
    requestTab: onTabClick,
    goToSetting,
    dialog,
    /** True when the flag is on and `section` is not the open tab. */
    hiddenUnless: (section: SuiteSettingsTab) => enabled && tab !== section,
    isSamePage: enabled ? isSuiteSettingsTabSwitch : undefined,
  };
}

export function SuiteSettingsEyebrow() {
  return (
    <p className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
      <Settings2 className="size-3" aria-hidden="true" />
      Suite settings
    </p>
  );
}

export function SuiteSettingsSubtitle() {
  return (
    <p className="mt-1 text-sm text-muted-foreground">
      What this suite tests and how it grades. Changes apply to the next run.
    </p>
  );
}

export function SuiteSettingsTabStrip({
  tab,
  onTabChange,
}: {
  tab: SuiteSettingsTab;
  onTabChange: (tab: SuiteSettingsTab) => void;
}) {
  return (
    <ViewModeSelector<SuiteSettingsTab>
      className={PAGE_HEADER_TAB_CLASSNAME}
      ariaLabel="Suite settings sections"
      indicatorId="suite-settings-tabs"
      value={tab}
      onChange={onTabChange}
      options={TAB_OPTIONS}
    />
  );
}

function SuiteSettingsDiscardDialog({
  to,
  onKeepEditing,
  onDiscard,
}: {
  to: SuiteSettingsTab | null;
  onKeepEditing: () => void;
  onDiscard: () => void;
}) {
  return (
    <AlertDialog
      open={to !== null}
      onOpenChange={(open) => {
        if (!open) onKeepEditing();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>
            You have unsaved changes. Discard them to open{" "}
            {to ? SUITE_SETTINGS_TAB_LABEL[to] : ""}, or keep editing and save
            first.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <button
            type="button"
            className={buttonVariants({ variant: "destructive" })}
            onClick={onDiscard}
          >
            Discard
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
