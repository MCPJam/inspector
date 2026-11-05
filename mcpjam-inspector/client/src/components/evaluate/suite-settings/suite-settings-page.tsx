import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Tabs, TabsList, TabsTrigger } from "@mcpjam/design-system/tabs";
import { buildEvaluatePath } from "@/lib/app-navigation";
import { SharedSettingsGate } from "@/components/billing/SharedSettingsGate";
import type {
  EvaluateNavRoute,
  SuiteSettingsTab,
} from "@/lib/eval-route-types";
import { SuiteSettingsCommitBar } from "../../evals/suite-settings-commit-bar";
import { sortRunsNewestFirst } from "../../evals/suite-iterations-view";
import { isSubsetRerunRun } from "../../evals/helpers";
import type { EvalSuite } from "../../evals/types";
import { SuiteBudgetSettingsFields } from "../../evals/suite-settings-sheet/suite-budget-settings-fields";
import { SuiteDefaultEvaluatorsFields } from "../../evals/suite-settings-sheet/suite-default-evaluators-fields";
import { SuiteRunTargetSettingsFields } from "../../evals/suite-settings-sheet/suite-run-target-settings-fields";
import { SuiteSettingsFields } from "../../evals/suite-settings-sheet/suite-settings-fields";
import { SuiteCiOwnedNotice } from "../../evals/suite-settings-sheet/suite-settings-ledger";
import {
  useSuiteSettingsEditor,
  type SuiteSettingsEditor,
} from "../../evals/suite-settings-sheet/use-suite-settings-editor";
import { EvaluateNavCrumbBar } from "../nav/evaluate-nav-crumb-bar";
import { useEvaluateNavNavigate } from "../nav/use-evaluate-nav-navigate";
import { SuiteSettingsCasesTab } from "./suite-settings-cases-tab";
import {
  useSuiteSettingsPageData,
  type SuiteSettingsPageData,
} from "./use-suite-settings-page-data";

type SuiteSettingsRoute = Extract<EvaluateNavRoute, { type: "suite-settings" }>;

const TAB_LABELS: Record<SuiteSettingsTab, string> = {
  settings: "Settings",
  cases: "Test cases",
  evaluators: "Default evaluators",
};

/**
 * Every tab keeps the draft: the page stays mounted across them, and leaving
 * the Settings tab for Test cases does not throw away a half-made change.
 */
const DRAFT_TABS: readonly SuiteSettingsTab[] = [
  "settings",
  "cases",
  "evaluators",
];

function isSuiteSettingsTab(value: string): value is SuiteSettingsTab {
  return value in TAB_LABELS;
}

/**
 * Suite settings (C4): Settings, Test cases and Default evaluators, each at
 * its own address. Settings and Default evaluators share one draft and one
 * Save bar in the breadcrumb bar; the Test cases tab has none (DD3, E11).
 */
export function SuiteSettingsPage({ route }: { route: SuiteSettingsRoute }) {
  const data = useSuiteSettingsPageData(route.suiteId);
  const { suite } = data;
  if (suite === undefined || data.cases === undefined) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center"
        data-testid="suite-settings-loading"
      >
        <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden />
      </div>
    );
  }
  if (suite === null) {
    return (
      <p className="px-6 py-12 text-center text-sm text-muted-foreground">
        This suite was deleted or you no longer have access to it. Open Evaluate
        to choose another suite.
      </p>
    );
  }
  return (
    <SharedSettingsGate
      projectId={data.projectId}
      creatorId={suite.createdBy}
      resource="eval suite"
    >
      <LoadedSuiteSettingsPage route={route} suite={suite} data={data} />
    </SharedSettingsGate>
  );
}

function LoadedSuiteSettingsPage({
  route,
  suite,
  data,
}: {
  route: SuiteSettingsRoute;
  suite: EvalSuite;
  data: SuiteSettingsPageData;
}) {
  const { projectId, configLocked, capabilities, evalContext } = data;
  const keepsDraft = useCallback(
    (nextPathname: string) =>
      DRAFT_TABS.some((tab) =>
        nextPathname.endsWith(
          buildEvaluatePath({
            type: "suite-settings",
            suiteId: suite._id,
            tab,
          }),
        ),
      ),
    [suite._id],
  );
  const editor = useSuiteSettingsEditor({
    suite,
    projectId,
    editingDisabled: configLocked,
    keepsDraft,
  });
  const followLink = useEvaluateNavNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const latestCompletedRun = useMemo(
    () =>
      sortRunsNewestFirst(data.runs).find(
        (run) => run.status === "completed" && !isSubsetRerunRun(run),
      ) ?? null,
    [data.runs],
  );
  const openTab = useCallback(
    (tab: SuiteSettingsTab) =>
      followLink({ ...route, tab }, "link", { replace: true }),
    [followLink, route],
  );
  const showSetting = useCallback(
    (tab: SuiteSettingsTab, settingKey: string) => {
      if (route.tab !== tab) openTab(tab);
      requestAnimationFrame(() =>
        scrollRef.current
          ?.querySelector(`[data-setting-key="${settingKey}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    },
    [openTab, route.tab],
  );

  const actions = (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          followLink({ type: "suite-overview", suiteId: suite._id }, "link")
        }
      >
        Back to suite
      </Button>
      {route.tab === "cases" ? null : (
        <SaveSettings
          editor={editor}
          suite={suite}
          locked={configLocked}
          onFix={showSetting}
        />
      )}
    </>
  );

  let body: ReactNode;
  if (route.tab === "cases") {
    body = (
      <SuiteSettingsCasesTab
        suite={suite}
        cases={data.cases ?? []}
        runs={data.runs}
        projectId={projectId}
        editingDisabled={configLocked}
        generateState={data.generateState}
        connectedServerNames={evalContext.connectedServerNames}
        onAddCase={() =>
          followLink({ type: "case-new", suiteId: suite._id }, "link")
        }
        onOpenCase={(caseId) =>
          followLink(
            { type: "case-settings", suiteId: suite._id, caseId },
            "link",
          )
        }
        onOpenCopy={(suiteId, caseId) =>
          followLink({ type: "case-settings", suiteId, caseId }, "link")
        }
        onDeleteCases={data.deleteTestCases}
      />
    );
  } else {
    body = (
      <div className="mx-auto w-full max-w-5xl space-y-6 px-6 py-8">
        {configLocked ? <SuiteCiOwnedNotice /> : null}
        <fieldset
          disabled={configLocked}
          className="m-0 min-w-0 space-y-8 border-0 p-0"
          data-testid={configLocked ? "suite-settings-locked" : undefined}
        >
          {route.tab === "settings" ? (
            <>
              <div data-setting-key="name" className="space-y-1">
                <Input
                  aria-label="Suite name"
                  className="max-w-md"
                  value={editor.draft.current.name}
                  onChange={(event) =>
                    editor.dispatchDraft({
                      type: "edit",
                      key: "name",
                      value: event.target.value,
                    })
                  }
                />
                {editor.nameRowError ? (
                  <p className="text-xs text-destructive">
                    {editor.nameRowError.message}
                  </p>
                ) : null}
              </div>
              <SuiteSettingsFields
                editor={editor}
                capabilities={capabilities}
              />
              <SuiteRunTargetSettingsFields
                suite={suite}
                projectId={projectId}
                editor={editor}
                capabilities={capabilities}
                readOnlyConfig={false}
                configLocked={configLocked}
              />
              <SuiteBudgetSettingsFields editor={editor} />
            </>
          ) : (
            <SuiteDefaultEvaluatorsFields
              suite={suite}
              projectId={projectId}
              editor={editor}
              capabilities={capabilities}
              latestCompletedRun={latestCompletedRun}
              availableModels={evalContext.availableModels}
              requireOrgKeys={evalContext.requireOrgKeys}
              onManageOrgProviders={evalContext.onManageOrgProviders}
              onAddProvider={evalContext.onAddProvider}
              onGoToWhereItRuns={() => showSetting("settings", "environments")}
            />
          )}
        </fieldset>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-testid="suite-settings-page"
    >
      <EvaluateNavCrumbBar
        route={route}
        names={{ suiteName: suite.name }}
        actions={actions}
      />
      <Tabs
        value={route.tab}
        onValueChange={(value) => {
          if (isSuiteSettingsTab(value)) openTab(value);
        }}
        className="shrink-0 border-b border-border/40 px-6 pt-3"
      >
        <TabsList aria-label="Suite settings sections">
          {Object.entries(TAB_LABELS).map(([tab, label]) => (
            <TabsTrigger key={tab} value={tab}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        {body}
      </div>
    </div>
  );
}

/** The one Save bar for the Settings and Default evaluators tabs. */
function SaveSettings({
  editor,
  suite,
  locked,
  onFix,
}: {
  editor: SuiteSettingsEditor;
  suite: EvalSuite;
  locked: boolean;
  onFix: (tab: SuiteSettingsTab, settingKey: string) => void;
}) {
  if (locked) return null;
  if (editor.draftChanges.length === 0) {
    return (
      <Button size="sm" disabled>
        Save settings
      </Button>
    );
  }
  return (
    <SuiteSettingsCommitBar
      layout="inline"
      changeCount={editor.draftChanges.length}
      conflictCount={editor.draft.conflicts.length}
      canCommit={editor.draftCanCommit}
      isCommitting={editor.isCommitting}
      onDiscard={() => editor.dispatchDraft({ type: "discard" })}
      onSave={() => void editor.commitSettings()}
      revisionNumber={suite.revisionNumber}
      blockingErrors={[
        ...(editor.nameRowError
          ? [
              {
                message: editor.nameRowError.message,
                onFix: () => onFix("settings", "name"),
              },
            ]
          : []),
        ...(editor.passOrFailRowError
          ? [
              {
                message: editor.passOrFailRowError.message,
                onFix: () => onFix("evaluators", "passOrFail"),
              },
            ]
          : []),
      ]}
    />
  );
}
