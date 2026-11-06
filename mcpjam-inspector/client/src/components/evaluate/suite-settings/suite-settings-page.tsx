import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router";
import { Loader2 } from "lucide-react";
import { SharedSettingsGate } from "@/components/billing/SharedSettingsGate";
import { buildEvaluatePath, useAppNavigate } from "@/lib/app-navigation";
import type { EvalRoute, SuiteSettingsTab } from "@/lib/eval-route-types";
import type { EvalSuiteSettingKey } from "@/shared/eval-suite-settings-manifest";
import { stripTimestampSuffix } from "@/components/evals/suite-overview-presentation";
import { useSuiteConfigLock } from "@/components/evals/use-suite-config-lock";
import { useSuiteSettingsSheet } from "@/components/evals/use-suite-settings-sheet";
import { SuiteSettingsFields } from "@/components/evals/suite-settings-fields";
import { SuiteSettingsLockFrame } from "@/components/evals/suite-settings-row-parts";
import { SuiteDefaultEvaluatorsSection } from "@/components/evals/suite-default-evaluators-section";
import { SuiteSettingsCompactContext } from "@/components/evals/suite-settings-compact";
import { EvalCrumbBar } from "../evals-header";
import type { EvalNavPageProps } from "../nav/eval-nav-pages";
import { useEvalNavPageView } from "../nav/eval-nav-analytics";
import {
  buildEvalBack,
  buildEvalCrumbs,
  type EvalNavNames,
} from "../nav/eval-nav-crumbs";
import { useEvalNavArrival, useEvalNavigate } from "../nav/eval-nav-state";
import { useEvalNavPageServices } from "../nav/eval-nav-page-services";
import { isSameSuiteSettingsPage } from "./suite-settings-guard";
import { SuiteSettingsSaveBar } from "./suite-settings-save-bar";
import {
  SuiteSettingsHeading,
  SuiteSettingsTabNav,
} from "./suite-settings-tabs";
import { SuiteCasesTab } from "./suite-cases-tab";
import {
  useSuiteSettingsPageData,
  type SuiteSettingsPageData,
} from "./use-suite-settings-page-data";

type SuiteSettingsRoute = Extract<EvalRoute, { type: "suite-settings" }>;
type ReadyData = Extract<SuiteSettingsPageData, { status: "ready" }>;

/** Which tab owns a setting a Fix or jump link points at. */
function tabForSetting(key: EvalSuiteSettingKey): SuiteSettingsTab {
  return key === "passOrFail" || key === "checks" ? "evaluators" : "settings";
}

/** Suite settings: heading, three tabs, and one Save in the crumb bar. */
export function SuiteSettingsPage({ route, projectId }: EvalNavPageProps) {
  if (route.type !== "suite-settings") return null;
  return <SuiteSettingsRoutePage route={route} projectId={projectId} />;
}

function SuiteSettingsRoutePage({
  route,
  projectId,
}: {
  route: SuiteSettingsRoute;
  projectId: string | null;
}) {
  useEvalNavPageView(route, { projectId, ui: "nav", enabled: true });
  const data = useSuiteSettingsPageData({ suiteId: route.suiteId, projectId });
  const navigate = useEvalNavigate();
  const { from } = useEvalNavArrival();
  useEffect(() => {
    if (data.status === "missing") {
      navigate({ type: "list" }, { via: "redirect", replace: true });
    }
  }, [data.status, navigate]);

  if (data.status !== "ready") {
    const names: EvalNavNames = {};
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <EvalCrumbBar
          crumbs={buildEvalCrumbs(route, names) ?? []}
          back={buildEvalBack(route, names, from)}
        />
        <div
          className="flex min-h-0 flex-1 items-center justify-center"
          data-testid="suite-settings-loading"
        >
          <Loader2 className="size-6 animate-spin text-primary" aria-hidden />
        </div>
      </div>
    );
  }
  return (
    <SharedSettingsGate
      projectId={projectId}
      creatorId={data.suite.createdBy}
      resource="eval suite"
    >
      <ReadySuiteSettingsPage route={route} projectId={projectId} data={data} />
    </SharedSettingsGate>
  );
}

function ReadySuiteSettingsPage({
  route,
  projectId,
  data,
}: {
  route: SuiteSettingsRoute;
  projectId: string | null;
  data: ReadyData;
}) {
  const { suite, cases, runs } = data;
  const services = useEvalNavPageServices();
  const { from } = useEvalNavArrival();
  const location = useLocation();
  const appNavigate = useAppNavigate();
  const names = useMemo<EvalNavNames>(
    () => ({ suiteName: stripTimestampSuffix(suite.name) }),
    [suite.name],
  );
  const lock = useSuiteConfigLock(suite, {});
  const sheet = useSuiteSettingsSheet({
    suite,
    runs,
    projectId,
    lock,
    active: true,
    canDeleteSuite: data.canDeleteSuite,
    allowNavigation: isSameSuiteSettingsPage,
  });

  // A tab is not a page level: replace, keep the arrival state (and so the
  // Back target), and drop importJob.
  const changeTab = useCallback(
    (tab: SuiteSettingsTab) =>
      appNavigate(
        buildEvaluatePath({ type: "suite-settings", suiteId: suite._id, tab }),
        { replace: true, state: location.state },
      ),
    [appNavigate, location.state, suite._id],
  );

  // Fix and jump links land on the owning tab first, then open the setting.
  const [pendingSetting, setPendingSetting] =
    useState<EvalSuiteSettingKey | null>(null);
  const goToSetting = useCallback(
    (key: EvalSuiteSettingKey) => {
      const tab = tabForSetting(key);
      if (tab !== route.tab) changeTab(tab);
      setPendingSetting(key);
    },
    [changeTab, route.tab],
  );
  const { openSetting, scrollRef } = sheet;
  useEffect(() => {
    if (!pendingSetting || tabForSetting(pendingSetting) !== route.tab) return;
    setPendingSetting(null);
    if (pendingSetting === "name") {
      scrollRef.current
        ?.querySelector<HTMLInputElement>('input[aria-label="Suite name"]')
        ?.focus();
    }
    openSetting(pendingSetting);
  }, [pendingSetting, route.tab, openSetting, scrollRef]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <EvalCrumbBar
        crumbs={buildEvalCrumbs(route, names) ?? []}
        back={buildEvalBack(route, names, from)}
        actions={
          <SuiteSettingsSaveBar
            sheet={sheet}
            revisionNumber={suite.revisionNumber}
            onFix={goToSetting}
          />
        }
      />
      <div
        ref={sheet.scrollRef}
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto px-6 pb-6 pt-6"
      >
        <div className="flex min-w-0 flex-col gap-5 pb-6">
          <SuiteSettingsHeading
            name={names.suiteName ?? suite.name}
            nameEditor={
              sheet.editingDisabled
                ? undefined
                : {
                    value: sheet.draft.current.name,
                    onChange: (value) =>
                      sheet.dispatchDraft({ type: "edit", key: "name", value }),
                    error: sheet.nameError,
                  }
            }
          />
          <SuiteSettingsTabNav
            tab={route.tab}
            caseCount={cases.length}
            onTabChange={changeTab}
          />
          {route.tab === "cases" ? (
            <SuiteCasesTab
              route={route}
              names={names}
              suite={suite}
              cases={cases}
              projectId={projectId}
              locked={sheet.editingDisabled}
              onClearImportJob={() => changeTab("cases")}
            />
          ) : (
            <SuiteSettingsCompactContext.Provider value>
              <div className="mx-auto w-full max-w-5xl space-y-6 px-0 py-4 sm:px-6">
                <SuiteSettingsLockFrame
                  sheet={sheet}
                  onDuplicateSuite={() => services.duplicateSuite(suite)}
                >
                  {route.tab === "settings" ? (
                    <SuiteSettingsFields
                      sheet={sheet}
                      suite={suite}
                      projectId={projectId}
                      lock={lock}
                    />
                  ) : (
                    <SuiteDefaultEvaluatorsSection
                      sheet={sheet}
                      suite={suite}
                      projectId={projectId}
                      capabilities={lock.capabilities}
                      availableModels={data.availableModels}
                      requireOrgKeys={data.requireOrgKeys}
                      onManageOrgProviders={data.onManageOrgProviders}
                      onAddProvider={data.onAddProvider}
                      onOpenSetting={goToSetting}
                    />
                  )}
                </SuiteSettingsLockFrame>
              </div>
            </SuiteSettingsCompactContext.Provider>
          )}
        </div>
      </div>
    </div>
  );
}
